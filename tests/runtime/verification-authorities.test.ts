import request from 'supertest';
import { createAssuranceAuthorityApp, createCodexVerifierApp } from '../../src/runtime/automation/services/verification-authorities';
import type { EvidenceArtifact, VerificationEvidence } from '../../src/runtime/automation/contracts';
import type { WorkspaceArtifactCollector } from '../../src/runtime/automation/artifacts';

const artifacts: EvidenceArtifact[] = ['git_diff', 'git_status', 'test_report'].map((kind, index) => ({
  kind: kind as EvidenceArtifact['kind'], sha256: String(index + 1).repeat(64), reference: `run/task/file-${index}`, bytes: 4,
}));
const evidence: VerificationEvidence = { claims: ['tests:pass'], artifacts };
const collector = (overrides: Partial<WorkspaceArtifactCollector> = {}): WorkspaceArtifactCollector => ({
  collect: jest.fn(() => artifacts), verify: jest.fn((items) => items),
  read: jest.fn((items) => items.map((artifact) => ({ artifact, content: 'safe' }))), ...overrides,
});

describe('independent verification authorities', () => {
  it('Codex health and verification require the dedicated identity', async () => {
    const evaluate = jest.fn(async () => ({ verdict: 'pass' as const, summary: 'diff and tests verified', evidence: ['codex:pass'], cost_usd: 0.01 }));
    const store = collector(); const app = createCodexVerifierApp({ serviceToken: 'codex-token', artifacts: store, evaluator: { evaluate } });
    expect((await request(app).get('/health')).status).toBe(401);
    expect((await request(app).get('/health').set('Authorization', 'Bearer codex-token')).body.protocol).toBe('ronor-codex-verifier/v1');
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expect(response.status).toBe(200); expect(response.body.verdict).toBe('pass');
    expect(store.read).toHaveBeenCalledWith(artifacts); expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('Codex refuses PASS without diff, status and test report', async () => {
    const evaluate = jest.fn(); const app = createCodexVerifierApp({ serviceToken: 'codex-token', artifacts: collector(), evaluator: { evaluate } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence: { claims: [], artifacts: artifacts.slice(0, 2) } });
    expect(response.status).toBe(422); expect(response.body.verdict).toBe('fail'); expect(evaluate).not.toHaveBeenCalled();
  });

  it('Codex fails closed and never leaks evaluator errors', async () => {
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', artifacts: collector(), evaluator: { evaluate: async () => { throw new Error('secret provider detail'); } } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expect(response.status).toBe(422); expect(JSON.stringify(response.body)).not.toContain('secret provider detail');
  });

  it('Victoria re-verifies artifacts and applies a distinct assurance policy', async () => {
    const store = collector(); const app = createAssuranceAuthorityApp({ serviceToken: 'victoria-token', artifacts: store });
    expect((await request(app).get('/health').set('Authorization', 'Bearer codex-token')).status).toBe(401);
    const accepted = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({ mission_id: 'mission-1', verification: { verdict: 'pass', summary: 'verified', evidence: ['codex:pass'] }, evidence });
    expect(accepted.status).toBe(200); expect(accepted.body.evidence).toEqual(['assurance:policy-pass']); expect(store.verify).toHaveBeenCalledWith(artifacts);
    const rejected = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({ mission_id: 'mission-1', verification: { verdict: 'fail' }, evidence });
    expect(rejected.status).toBe(422); expect(rejected.body.verdict).toBe('fail');
  });

  it('Victoria fails closed on a digest mismatch before policy evaluation', async () => {
    const store = collector({ verify: jest.fn(() => { throw new Error('artifact_integrity_failed'); }) });
    const app = createAssuranceAuthorityApp({ serviceToken: 'victoria-token', artifacts: store });
    const response = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({ mission_id: 'mission-1', verification: { verdict: 'pass' }, evidence });
    expect(response.status).toBe(422); expect(response.body.evidence).toEqual(['assurance:integrity-failed']);
  });
});
