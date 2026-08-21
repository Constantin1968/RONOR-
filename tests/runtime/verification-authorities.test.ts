import request from 'supertest';
import { createAssuranceAuthorityApp, createCodexVerifierApp } from '../../src/runtime/automation/services/verification-authorities';
import type { EvidenceArtifact, VerificationEvidence } from '../../src/runtime/automation/contracts';
import type { WorkspaceArtifactCollector } from '../../src/runtime/automation/artifacts';
import { signVerificationReceipt } from '../../src/runtime/automation/verification-receipt';
import crypto from 'node:crypto';

const receiptKeys = crypto.generateKeyPairSync('ed25519');
const receiptPrivateKey = receiptKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const receiptPublicKey = receiptKeys.publicKey.export({ type: 'spki', format: 'pem' }).toString();
const now = new Date('2026-08-21T12:00:00.000Z');

const artifacts: EvidenceArtifact[] = ['git_diff', 'git_status', 'test_report'].map((kind, index) => ({
  kind: kind as EvidenceArtifact['kind'], sha256: String(index + 1).repeat(64), reference: `run/task/file-${index}`, bytes: 4,
}));
const evidence: VerificationEvidence = { claims: ['tests:pass'], artifacts };
const passingReport = JSON.stringify({
  schema: 'ronor-test-report/v1', passed: true, command_count: 1,
  results: [{ id: 'jest', passed: true, exit_code: 0, signal: null }],
});
const collector = (overrides: Partial<WorkspaceArtifactCollector> = {}): WorkspaceArtifactCollector => ({
  collect: jest.fn(() => artifacts), verify: jest.fn((items) => items),
  read: jest.fn((items) => items.map((artifact) => ({ artifact, content: artifact.kind === 'test_report' ? passingReport : 'safe' }))), ...overrides,
  recordTestReport: jest.fn(() => artifacts[2]),
});

describe('independent verification authorities', () => {
  it('Codex health and verification require the dedicated identity', async () => {
    const evaluate = jest.fn(async () => ({ verdict: 'pass' as const, summary: 'diff and tests verified', evidence: ['codex:pass'], cost_usd: 0.01 }));
    const store = collector(); const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate }, now: () => now });
    expect((await request(app).get('/health')).status).toBe(401);
    expect((await request(app).get('/health').set('Authorization', 'Bearer codex-token')).body.protocol).toBe('ronor-codex-verifier/v1');
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expect(response.status).toBe(200); expect(response.body.verdict).toBe('pass');
    expect(response.body.receipt).toMatchObject({ issuer: 'codex-verifier', mission_id: 'mission-1', verdict: 'pass' });
    expect(store.read).toHaveBeenCalledWith(artifacts); expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('Codex refuses PASS without diff, status and test report', async () => {
    const evaluate = jest.fn(); const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence: { claims: [], artifacts: artifacts.slice(0, 2) } });
    expect(response.status).toBe(422); expect(response.body.verdict).toBe('fail'); expect(evaluate).not.toHaveBeenCalled();
  });

  it('Codex refuses failed, malformed or contradictory test evidence before model invocation', async () => {
    const evaluate = jest.fn();
    const verify = async (report: string, claims = ['tests:pass']) => {
      const store = collector({ read: jest.fn((items) => items.map((artifact) => ({ artifact, content: artifact.kind === 'test_report' ? report : 'safe' }))) });
      const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate } });
      return request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence: { ...evidence, claims } });
    };
    const failed = JSON.stringify({ schema: 'ronor-test-report/v1', passed: false, command_count: 1, results: [{ id: 'jest', passed: false, exit_code: 1, signal: null }] });
    expect((await verify(failed)).body.evidence).toEqual(['test-evidence:invalid']);
    expect((await verify('{bad json')).status).toBe(422);
    expect((await verify(passingReport, ['tests:pass', 'test:jest:fail'])).status).toBe(422);
    expect(evaluate).not.toHaveBeenCalled();
  });

  it('Codex rejects duplicate artifact references before reading evidence', async () => {
    const store = collector(); const evaluate = jest.fn();
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate } });
    const duplicated = [...artifacts, { ...artifacts[2], kind: 'event_log' as const }];
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence: { claims: ['tests:pass'], artifacts: duplicated } });
    expect(response.status).toBe(400); expect(store.read).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
  });

  it('Codex fails closed and never leaks evaluator errors', async () => {
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate: async () => { throw new Error('secret provider detail'); } } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expect(response.status).toBe(422); expect(JSON.stringify(response.body)).not.toContain('secret provider detail');
  });

  it('Victoria re-verifies artifacts and applies a distinct assurance policy', async () => {
    const store = collector(); const app = createAssuranceAuthorityApp({ serviceToken: 'victoria-token', receiptPublicKey, artifacts: store, now: () => now });
    expect((await request(app).get('/health').set('Authorization', 'Bearer codex-token')).status).toBe(401);
    const receipt = signVerificationReceipt({ privateKeyPem: receiptPrivateKey, missionId: 'mission-1', verdict: 'pass', evidence, now });
    const accepted = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({ mission_id: 'mission-1', verification: { verdict: 'pass', summary: 'verified', evidence: ['codex:pass'], receipt }, evidence });
    expect(accepted.status).toBe(200); expect(accepted.body.evidence).toEqual(['assurance:policy-pass']); expect(store.verify).toHaveBeenCalledWith(artifacts);
    const rejected = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({ mission_id: 'mission-1', verification: { verdict: 'fail' }, evidence });
    expect(rejected.status).toBe(422); expect(rejected.body.verdict).toBe('fail');
  });

  it('Victoria fails closed on a digest mismatch before policy evaluation', async () => {
    const store = collector({ verify: jest.fn(() => { throw new Error('artifact_integrity_failed'); }) });
    const app = createAssuranceAuthorityApp({ serviceToken: 'victoria-token', receiptPublicKey, artifacts: store, now: () => now });
    const receipt = signVerificationReceipt({ privateKeyPem: receiptPrivateKey, missionId: 'mission-1', verdict: 'pass', evidence, now });
    const response = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({ mission_id: 'mission-1', verification: { verdict: 'pass', receipt }, evidence });
    expect(response.status).toBe(422); expect(response.body.evidence).toEqual(['assurance:integrity-failed']);
  });

  it('Victoria rejects a missing, tampered or stale Codex receipt', async () => {
    const app = createAssuranceAuthorityApp({ serviceToken: 'victoria-token', receiptPublicKey, artifacts: collector(), now: () => now });
    const valid = signVerificationReceipt({ privateKeyPem: receiptPrivateKey, missionId: 'mission-1', verdict: 'pass', evidence, now });
    const verify = (receipt: unknown) => request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token')
      .send({ mission_id: 'mission-1', verification: { verdict: 'pass', receipt }, evidence });
    expect((await verify(undefined)).status).toBe(422);
    expect((await verify({ ...valid, evidence_digest: 'f'.repeat(64) })).status).toBe(422);
    const stale = signVerificationReceipt({ privateKeyPem: receiptPrivateKey, missionId: 'mission-1', verdict: 'pass', evidence, now: new Date('2026-08-21T11:00:00.000Z') });
    expect((await verify(stale)).status).toBe(422);
  });
});
