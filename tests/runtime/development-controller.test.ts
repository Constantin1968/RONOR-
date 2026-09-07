import crypto from 'crypto';
import request from 'supertest';
import { bootstrapApiKeys } from '../../src/runtime/api/auth';
import { createDevelopmentController } from '../../src/runtime/automation/development-controller';
import { prepareDevelopmentJob } from '../../src/runtime/automation/development-jobs';
import { controllerEnvironment, CONTROLLER_SECRETS } from '../../src/runtime/automation/services/development-controller-server';
import { getDb } from '../../src/audit/hash-chain';
import { registerAutomationRun } from '../../src/runtime/automation/run-control';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';

const architect = crypto.randomBytes(32).toString('hex');
const admin = crypto.randomBytes(32).toString('hex');
const env = { RONOR_ARCHITECT_API_KEY: architect, RONOR_ADMIN_API_KEY: admin, RONOR_AUTOMATION_ENABLED: 'false' };
let controller: ReturnType<typeof createDevelopmentController>;
beforeAll(() => { bootstrapApiKeys(env); controller = createDevelopmentController(env); });
afterAll(() => controller.stop());

describe('standalone development surface', () => {
  it('reports liveness without claiming readiness', async () => {
    const r = await request(controller.app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true, protocol: 'ronor-development-controller/v1', purpose: 'development-only' });
    expect(r.headers['cache-control']).toBe('no-store');
  });
  it('does not expose the main runtime query or key administration', async () => {
    for (const route of ['/query', '/agents/dispatch', '/knowledge/ingest', '/admin/keys']) {
      expect((await request(controller.app).post(`/api/runtime${route}`).set('Authorization', `Bearer ${architect}`).send({})).status).toBe(404);
    }
  });
  it('rejects unauthenticated callers and ordinary administrators', async () => {
    const payload = { objective: 'Implement a regression test.' };
    expect((await request(controller.app).post('/api/development/jobs').send(payload)).status).toBe(401);
    expect((await request(controller.app).post('/api/development/jobs').set('Authorization', `Bearer ${admin}`).send(payload)).status).toBe(403);
  });
  it('persists one job for repeated identical intent without starting execution', async () => {
    const id = crypto.randomUUID();
    const send = () => request(controller.app).post('/api/development/jobs')
      .set('Authorization', `Bearer ${architect}`).set('Idempotency-Key', id)
      .send({ objective: 'Implement and test the development entry point.' });
    const first = await send(); const retry = await send();
    expect(first.status).toBe(201); expect(retry.status).toBe(200);
    expect(first.body.job).toEqual(retry.body.job);
    expect(first.body.execution_started).toBe(false);
    expect(Object.keys(first.body.job).sort()).toEqual(['created_at', 'job_id', 'mission_id']);
  });
  it('refuses a changed objective under the same identifier', async () => {
    const id = crypto.randomUUID();
    const send = (objective: string) => request(controller.app).post('/api/development/jobs')
      .set('Authorization', `Bearer ${architect}`).set('Idempotency-Key', id).send({ objective });
    expect((await send('Implement A')).status).toBe(201);
    expect((await send('Implement B')).status).toBe(409);
  });
  it('rejects delegated authority fields, absent identifiers and oversized text', async () => {
    for (const body of [{ objective: 'A', approved: true }, { objective: 'x'.repeat(8001) }]) {
      expect((await request(controller.app).post('/api/development/jobs')
        .set('Authorization', `Bearer ${architect}`).set('Idempotency-Key', crypto.randomUUID()).send(body)).status).toBe(400);
    }
    expect((await request(controller.app).post('/api/development/jobs')
      .set('Authorization', `Bearer ${architect}`).send({ objective: 'A' })).status).toBe(400);
  });
  it('refuses execution without approval and never claims disabled adapters are ready', async () => {
    const r = await request(controller.app).get('/api/runtime/control/automation/readiness')
      .set('Authorization', `Bearer ${architect}`);
    expect(r.status).toBe(503); expect(r.body.automation.ready).toBe(false);
    const execution = await request(controller.app).post('/api/runtime/control/automation/run')
      .set('Authorization', `Bearer ${architect}`).send({});
    expect(execution.status).toBe(409);
  });
  it('rejects malformed JSON without disclosing it', async () => {
    const r = await request(controller.app).post('/api/development/jobs')
      .set('Content-Type', 'application/json').send('{"objective":');
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ ok: false, error: 'invalid_request_body' });
  });
  it('interrupts active work on shutdown without discarding its cleanup handle', () => {
    const run = registerAutomationRun(`shutdown-${crypto.randomUUID()}`, 'shutdown-mission')!;
    const isolated = createDevelopmentController(env);
    isolated.stop();
    expect(run.signal.aborted).toBe(true);
    run.finish();
  });
});

describe('opt-in deployment contract', () => {
  it('preserves the default production image and exposes only the dedicated loopback port', () => {
    const root = path.resolve(__dirname, '../..');
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(dockerfile.trim().split('\n').at(-1)).toBe('FROM runtime AS default-runtime');
    const compose = yaml.load(fs.readFileSync(path.join(root, 'docker-compose.development-controller.yml'), 'utf8')) as any;
    const service = compose.services.controller;
    expect(service.build.target).toBe('development-controller');
    expect(service.ports).toEqual(['127.0.0.1:3010:3010']);
    expect(service.user).toBe('10001:10001');
    expect(service.read_only).toBe(true);
    expect(service.cap_drop).toEqual(['ALL']);
    expect(service.environment.RONOR_AUTOMATION_RECOVERY_ENABLED).toBe('false');
    expect(service.volumes.find((v: any) => v.target === '/automation-worktrees/project').read_only).toBe(true);
    expect(service.volumes.find((v: any) => v.target === '/automation-artifacts').read_only).toBe(true);
    expect(service.volumes.some((v: any) => JSON.stringify(v).includes('docker.sock'))).toBe(false);
    expect(service.secrets).not.toContain('codex_api_key');
    expect(service.secrets).not.toContain('openhands_llm_api_key');
  });
});

describe('persistent intent integrity', () => {
  it('scopes an identifier to its authenticated architect identity', () => {
    const id = crypto.randomUUID();
    const a = prepareDevelopmentJob({ architectKeyId: 'architect-a', idempotencyKey: id, objective: 'Same objective' });
    const b = prepareDevelopmentJob({ architectKeyId: 'architect-b', idempotencyKey: id, objective: 'Same objective' });
    expect(a.job.mission_id).not.toBe(b.job.mission_id);
  });
  it('refuses a dangling or replaced mission instead of silently creating another', () => {
    const input = { architectKeyId: 'integrity-check', idempotencyKey: crypto.randomUUID(), objective: 'Test integrity' };
    const result = prepareDevelopmentJob(input);
    getDb().prepare('UPDATE runtime_development_jobs SET mission_id = ? WHERE job_id = ?')
      .run('missing-mission', result.job.job_id);
    expect(() => prepareDevelopmentJob(input)).toThrow('development_job_integrity_failed');
  });
});

describe('controller credential boundary', () => {
  const configuration = () => Object.fromEntries(CONTROLLER_SECRETS.map(key => [key, crypto.randomBytes(32).toString('hex')]));
  it('requires every dedicated identity and does not inherit unrelated credentials', () => {
    const result = controllerEnvironment({ ...configuration(), OPENAI_API_KEY: 'not-forwarded', GITHUB_TOKEN: 'not-forwarded' });
    expect(result.OPENAI_API_KEY).toBeUndefined(); expect(result.GITHUB_TOKEN).toBeUndefined();
    expect(result.RONOR_AUTOMATION_RECOVERY_ENABLED).toBe('false');
    expect(() => controllerEnvironment({})).toThrow('controller_secret_missing_or_short');
  });
  it('rejects shared identities', () => {
    const env = configuration(); env.RONOR_ASSURANCE_TOKEN = env.RONOR_OPENHANDS_TOKEN;
    expect(() => controllerEnvironment(env)).toThrow('controller_secret_identity_conflict');
  });
});
