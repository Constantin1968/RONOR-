import express from 'express';
import type { WorkspaceArtifactCollector } from '../artifacts';
import type { TestExecutor } from '../test-executor';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function createEvidenceRunnerApp(config: {
  token: string; workspaceRoot: string; artifacts: WorkspaceArtifactCollector; tests: TestExecutor;
}) {
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '8kb' }));
  const authorised = (header: string | undefined) => header === `Bearer ${config.token}`;
  app.get('/health', (req, res) => authorised(req.header('authorization'))
    ? res.json({ ok: true, protocol: 'ronor-evidence-runner/v1', service_id: 'automation-evidence-runner', capabilities: ['git-evidence', 'allowlisted-tests'] })
    : res.status(401).json({ ok: false, error: 'unauthorized' }));
  app.post('/v1/verify', (req, res) => {
    if (!authorised(req.header('authorization'))) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    const runId = req.body?.run_id; const assignmentId = req.body?.assignment_id; const runTests = req.body?.run_tests;
    if (typeof runId !== 'string' || !SAFE_ID.test(runId) || typeof assignmentId !== 'string' || !SAFE_ID.test(assignmentId) || typeof runTests !== 'boolean') {
      res.status(400).json({ ok: false, error: 'invalid_evidence_request' }); return;
    }
    try {
      const artifacts = config.artifacts.collect(config.workspaceRoot, runId, assignmentId);
      if (!runTests) { res.json({ ok: true, passed: true, claims: [], artifacts }); return; }
      const tests = config.tests.run(config.workspaceRoot, runId, assignmentId);
      res.json({ ok: tests.passed, passed: tests.passed, claims: tests.claims, artifacts: [...artifacts, tests.artifact] });
    } catch { res.status(422).json({ ok: false, error: 'evidence_verification_failed' }); }
  });
  return app;
}
