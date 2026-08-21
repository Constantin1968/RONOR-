import request from 'supertest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { signExecutionCapability } from '../../src/runtime/automation/capability';
import { createOpenHandsBridgeApp, FileCapabilityNonceStore, MemoryCapabilityNonceStore } from '../../src/runtime/automation/services/openhands-bridge';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const key = 'k'.repeat(32);
const serviceToken = 'bridge-service-token';
// Far-future expiry keeps replay tests independent of the calendar date on CI.
const deadline = '2099-08-21T00:00:00.000Z';
const envelope: OpenHandsExecutionEnvelope = {
  assignment_id: 'task-1', instruction: 'Run declared tests only.', allowed_actions: ['read_repo', 'run_tests'],
  objective_hash: 'a'.repeat(64), deadline,
};
const capability = (nonce = 'nonce-1') => signExecutionCapability({
  audience: 'openhands-bridge', mandate_id: 'm1', mission_id: 'msn1', assignment_id: envelope.assignment_id,
  objective_hash: envelope.objective_hash, allowed_actions: envelope.allowed_actions, expires_at: deadline, nonce,
}, key);

describe('RONOR OpenHands bridge', () => {
  it('requires the bridge identity for health attestation', async () => {
    const app = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute: jest.fn() } });
    expect((await request(app).get('/health')).status).toBe(401);
    const response = await request(app).get('/health').set('Authorization', `Bearer ${serviceToken}`);
    expect(response.body).toMatchObject({ ok: true, protocol: 'ronor-openhands-bridge/v1', service_id: 'openhands-bridge', capabilities: ['execute'] });
  });
  it('executes once with matching service identity and capability', async () => {
    const execute = jest.fn(async () => ({ ok: true, summary: 'done', evidence: ['tests:pass'], cost_usd: 0 }));
    const app = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute }, now: () => new Date('2026-08-20T00:00:00Z') });
    const response = await request(app).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability()).send({ envelope });
    expect(response.status).toBe(200);
    expect(execute).toHaveBeenCalledWith(envelope);
  });

  it('rejects missing auth, tampering and replay before OpenHands', async () => {
    const execute = jest.fn(async () => ({ ok: true, summary: 'done', evidence: [], cost_usd: 0 }));
    const app = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute }, nonces: new MemoryCapabilityNonceStore(), now: () => new Date('2026-08-20T00:00:00Z') });
    expect((await request(app).post('/v1/execute').send({ envelope })).status).toBe(401);
    expect((await request(app).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('tamper')).send({ envelope: { ...envelope, allowed_actions: ['push'] } })).status).toBe(403);
    const first = await request(app).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('once')).send({ envelope });
    const replay = await request(app).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('once')).send({ envelope });
    expect(first.status).toBe(200);
    expect(replay.status).toBe(409);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('does not disclose upstream errors', async () => {
    const app = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute: async () => { throw new Error('secret upstream detail'); } }, now: () => new Date('2026-08-20T00:00:00Z') });
    const response = await request(app).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('error')).send({ envelope });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('secret upstream detail');
  });

  it('preserves nonce consumption across bridge restarts', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ronor-nonces-'));
    const execute = jest.fn(async () => ({ ok: true, summary: 'done', evidence: [], cost_usd: 0 }));
    const fixedNow = () => Date.parse('2026-08-20T00:00:00Z');
    try {
      const first = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute }, nonces: new FileCapabilityNonceStore(directory, fixedNow), now: () => new Date(fixedNow()) });
      const accepted = await request(first).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('durable')).send({ envelope });
      const restarted = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute }, nonces: new FileCapabilityNonceStore(directory, fixedNow), now: () => new Date(fixedNow()) });
      const replay = await request(restarted).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('durable')).send({ envelope });
      expect(accepted.status).toBe(200);
      expect(replay.status).toBe(409);
      expect(execute).toHaveBeenCalledTimes(1);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('atomically admits only one concurrent use and fails closed when storage fails', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ronor-nonces-race-'));
    const execute = jest.fn(async () => ({ ok: true, summary: 'done', evidence: [], cost_usd: 0 }));
    const fixedNow = () => Date.parse('2026-08-20T00:00:00Z');
    try {
      const app = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute }, nonces: new FileCapabilityNonceStore(directory, fixedNow), now: () => new Date(fixedNow()) });
      const send = () => request(app).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('race')).send({ envelope });
      const responses = await Promise.all([send(), send()]);
      expect(responses.map((item) => item.status).sort()).toEqual([200, 409]);
      expect(execute).toHaveBeenCalledTimes(1);
      const unavailable = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute }, nonces: { consume: () => { throw new Error('disk detail'); } }, now: () => new Date(fixedNow()) });
      const blocked = await request(unavailable).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('storage')).send({ envelope });
      expect(blocked.status).toBe(503);
      expect(blocked.body).toEqual({ ok: false, error: 'nonce_store_unavailable' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });

  it('refuses secret-like worker output before returning it to the runtime', async () => {
    const execute = jest.fn(async () => ({ ok: true, summary: 'api_key=abcdefghijklmnop123456', evidence: [], cost_usd: 0 }));
    const app = createOpenHandsBridgeApp({ capabilityKey: key, serviceToken, client: { execute }, now: () => new Date('2026-08-20T00:00:00Z') });
    const response = await request(app).post('/v1/execute').set('Authorization', `Bearer ${serviceToken}`).set('X-RONOR-Capability', capability('sensitive')).send({ envelope });
    expect(response.status).toBe(502);
    expect(JSON.stringify(response.body)).not.toContain('abcdefghijklmnop123456');
  });
});
