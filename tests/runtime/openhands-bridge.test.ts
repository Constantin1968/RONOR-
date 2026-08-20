import request from 'supertest';
import { signExecutionCapability } from '../../src/runtime/automation/capability';
import { createOpenHandsBridgeApp, MemoryCapabilityNonceStore } from '../../src/runtime/automation/services/openhands-bridge';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const key = 'k'.repeat(32);
const serviceToken = 'bridge-service-token';
const deadline = '2026-08-21T00:00:00.000Z';
const envelope: OpenHandsExecutionEnvelope = {
  assignment_id: 'task-1', instruction: 'Run declared tests only.', allowed_actions: ['read_repo', 'run_tests'],
  objective_hash: 'a'.repeat(64), deadline,
};
const capability = (nonce = 'nonce-1') => signExecutionCapability({
  audience: 'openhands-bridge', mandate_id: 'm1', mission_id: 'msn1', assignment_id: envelope.assignment_id,
  objective_hash: envelope.objective_hash, allowed_actions: envelope.allowed_actions, expires_at: deadline, nonce,
}, key);

describe('RONOR OpenHands bridge', () => {
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
});
