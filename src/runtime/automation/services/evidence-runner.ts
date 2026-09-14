import express from 'express';
import { createServiceRateLimit } from './rate-limit';
import type { WorkspaceArtifactCollector } from '../artifacts';
import type { TestExecutor } from '../test-executor';
import type { BoundedTestExecutor } from '../bounded-test-executor';
import { EXISTING_ASSIGNMENT, inspectExistingCommit, validCommitPins } from '../existing-commit-workspace';

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;

export function createEvidenceRunnerApp(config: {
  token: string; workspaceRoot: string; artifacts: WorkspaceArtifactCollector; tests: TestExecutor;
  boundedTests?: BoundedTestExecutor;
}) {
  const app = express(); app.disable('x-powered-by'); app.use(express.json({ limit: '8kb' })); app.use(createServiceRateLimit());
  const authorised = (header: string | undefined) => header === `Bearer ${config.token}`;
  app.get('/health', (req, res) => authorised(req.header('authorization'))
    ? res.json({ ok: true, protocol: 'ronor-evidence-runner/v1', service_id: 'automation-evidence-runner', capabilities: ['git-evidence', 'allowlisted-tests', ...(config.boundedTests && config.artifacts.collectCommitRange ? ['verify-existing'] : [])] })
    : res.status(401).json({ ok: false, error: 'unauthorized' }));
  let existingBusy = false;
  app.post('/v1/verify-existing', async (req, res) => {
    if (!authorised(req.header('authorization'))) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    const body = req.body;
    const deadline = Date.parse(body?.deadline);
    if (!body || Object.keys(body).some(k => !['run_id', 'base_commit', 'head_commit', 'deadline'].includes(k)) ||
        typeof body.run_id !== 'string' || !/^verify_[a-f0-9]{64}$/.test(body.run_id) ||
        !validCommitPins(body) || !Number.isFinite(deadline) || deadline <= Date.now() || deadline > Date.now() + 60 * 60_000) {
      res.status(400).json({ ok: false, error: 'invalid_existing_verification_request' }); return;
    }
    if (!config.boundedTests || !config.artifacts.collectCommitRange) {
      res.status(503).json({ ok: false, error: 'existing_verification_not_configured' }); return;
    }
    if (existingBusy) { res.status(409).json({ ok: false, error: 'evidence_runner_busy' }); return; }
    existingBusy = true;
    const control = new AbortController();
    const disconnected = () => { if (!res.writableEnded) control.abort(); };
    res.once('close', disconnected);
    const timer = setTimeout(() => control.abort(), Math.max(1, deadline - Date.now()));
    try {
      const pins = { base_commit: body.base_commit, head_commit: body.head_commit };
      const before = inspectExistingCommit(config.workspaceRoot, pins);
      const artifacts = config.artifacts.collectCommitRange(config.workspaceRoot, body.run_id, EXISTING_ASSIGNMENT, pins);
      const result = await config.boundedTests.run(config.workspaceRoot, body.run_id, EXISTING_ASSIGNMENT, deadline, control.signal);
      const after = inspectExistingCommit(config.workspaceRoot, pins);
      if (control.signal.aborted || Date.now() >= deadline || before.diff_sha256 !== after.diff_sha256)
        throw new Error('existing_verification_interrupted');
      config.artifacts.verify([...artifacts, result.artifact]);
      res.status(result.passed ? 200 : 422).json({
        ok: result.passed, passed: result.passed, claims: result.claims, artifacts: [...artifacts, result.artifact],
      });
    } catch { if (!res.destroyed) res.status(422).json({ ok: false, error: 'existing_verification_failed' }); }
    finally { clearTimeout(timer); res.removeListener('close', disconnected); existingBusy = false; }
  });
  app.post('/v1/verify', (req, res) => {
    if (!authorised(req.header('authorization'))) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    if (existingBusy) { res.status(409).json({ ok: false, error: 'evidence_runner_busy' }); return; }
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
