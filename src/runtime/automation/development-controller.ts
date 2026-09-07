import express from 'express';
import { createRuntimeRouter } from '../api/routes';
import { ingressRateLimit, rateLimit, requireArchitect } from '../api/middleware';
import { prepareDevelopmentJob } from './development-jobs';
import { interruptActiveAutomationRuns } from './run-control';

// Expose the existing control plane, not query/ingest/provider/key-admin routes.
const ROUTES: Array<[string, RegExp]> = [
  ['GET', /^\/control\/session$/],
  ['GET', /^\/control\/automation\/readiness$/],
  ['POST', /^\/control\/automation\/run$/],
  ['GET', /^\/control\/automation\/runs\/[A-Za-z0-9_-]+$/],
  ['POST', /^\/control\/automation\/runs\/[A-Za-z0-9_-]+\/cancel$/],
  ['GET', /^\/control\/missions\/[A-Za-z0-9_-]+\/fabric$/],
];

export function createDevelopmentController(env: NodeJS.ProcessEnv) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false);
  app.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  app.get('/health', (_req, res) => {
    // Liveness only. Readiness still requires authenticated five-party attestation.
    res.json({ ok: true, protocol: 'ronor-development-controller/v1', purpose: 'development-only' });
  });
  app.use(ingressRateLimit);
  app.use(express.json({ limit: '32kb', strict: true }));
  app.post('/api/development/jobs', requireArchitect, rateLimit, (req, res) => {
    const body = req.body as Record<string, unknown> | undefined;
    if (!body || Object.keys(body).some(key => key !== 'objective') ||
        typeof body.objective !== 'string') {
      res.status(400).json({ ok: false, error: 'invalid_development_job' }); return;
    }
    try {
      const result = prepareDevelopmentJob({
        architectKeyId: req.apiKey!.key_id,
        idempotencyKey: req.header('idempotency-key') || '',
        objective: body.objective,
      });
      res.status(result.created ? 201 : 200).json({
        ok: true, job: result.job, execution_started: false,
      });
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      const known = ['invalid_development_job', 'development_job_conflict', 'development_job_integrity_failed'];
      res.status(code === 'invalid_development_job' ? 400 : code === 'development_job_conflict' ? 409 : 500)
        .json({ ok: false, error: known.includes(code) ? code : 'development_job_failed' });
    }
  });
  const runtime = createRuntimeRouter(env);
  app.use('/api/runtime', (req, res, next) => {
    if (!ROUTES.some(([method, pattern]) => req.method === method && pattern.test(req.path))) {
      res.status(404).json({ ok: false, error: 'not_found' }); return;
    }
    next();
  }, runtime);
  app.use((_req, res) => { res.status(404).json({ ok: false, error: 'not_found' }); });
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const kind = (error as { type?: string })?.type;
    const status = kind === 'entity.too.large' ? 413 : kind === 'entity.parse.failed' ? 400 : 500;
    res.status(status).json({ ok: false, error: status < 500 ? 'invalid_request_body' : 'development_controller_failed' });
  });
  return { app, stop: () => { runtime.stopAutomationRecovery(); interruptActiveAutomationRuns(); } };
}
