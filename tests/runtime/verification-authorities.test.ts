import request from 'supertest';
import { createAssuranceAuthorityApp, createCodexVerifierApp } from '../../src/runtime/automation/services/verification-authorities';
import type { CodexEvaluationPort } from '../../src/runtime/automation/services/verification-authorities';
import { AccountedEvaluationError } from '../../src/runtime/automation/services/codex-evaluator';
import type { EvidenceArtifact, VerificationEvidence } from '../../src/runtime/automation/contracts';
import type { WorkspaceArtifactCollector } from '../../src/runtime/automation/artifacts';
import { signVerificationReceipt, verifyVerificationReceipt } from '../../src/runtime/automation/verification-receipt';
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
const passingEvaluation = { verdict: 'pass' as const, summary: 'diff and tests verified', evidence: ['codex:pass'], cost_usd: 0.01 };
const collector = (overrides: Partial<WorkspaceArtifactCollector> = {}): WorkspaceArtifactCollector => ({
  collect: jest.fn(() => artifacts), verify: jest.fn((items) => items),
  read: jest.fn((items) => items.map((artifact) => ({ artifact, content: artifact.kind === 'test_report' ? passingReport : 'safe' }))), ...overrides,
  recordTestReport: jest.fn(() => artifacts[2]),
});

function expectClosedFailure(response: { status: number; body: unknown }, failureCode: string, cost: number | null): void {
  expect(response.status).toBe(422);
  expect(response.body).toEqual({
    ok: false, verdict: 'fail', failure_code: failureCode, summary: 'Independent verification failed closed.',
    evidence: ['verification:failed-closed'], cost_usd: cost,
  });
}

describe('independent verification authorities', () => {
  it('Codex health and verification require the dedicated identity', async () => {
    const evaluate = jest.fn(async () => ({ verdict: 'pass' as const, summary: 'diff and tests verified', evidence: ['codex:pass'], cost_usd: 0.01 }));
    const store = collector(); const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate }, now: () => now });
    expect((await request(app).get('/health')).status).toBe(401);
    expect((await request(app).get('/health').set('Authorization', 'Bearer codex-token')).body.protocol).toBe('ronor-codex-verifier/v1');
    const unauthorized = await request(app).post('/v1/verify').send({ mission_id: 'mission-1', evidence });
    expect(unauthorized.status).toBe(401); expect(unauthorized.body).toEqual({ ok: false, error: 'unauthorized' });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence, budget_token: 'test-budget-token' });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ ok: true, ...passingEvaluation, receipt: expect.any(Object) });
    expect(response.body.receipt).toMatchObject({ issuer: 'codex-verifier', mission_id: 'mission-1', verdict: 'pass' });
    expect(verifyVerificationReceipt({ publicKeyPem: receiptPublicKey, receipt: response.body.receipt, missionId: 'mission-1', verdict: 'pass', evidence, now })).toBe(true);
    expect(store.read).toHaveBeenCalledWith(artifacts); expect(store.read).toHaveBeenCalledTimes(1); expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith({
      missionId: 'mission-1', claims: evidence.claims,
      materials: artifacts.map((artifact) => ({ artifact, content: artifact.kind === 'test_report' ? passingReport : 'safe' })),
      budgetToken: 'test-budget-token',
    });
  });

  it('Codex labels an evaluated rejection while preserving its signed receipt and cost', async () => {
    const evaluated = { verdict: 'fail' as const, summary: 'The diff does not satisfy the claims.', evidence: ['codex:rejected'], cost_usd: 0.03 };
    const evaluate = jest.fn(async () => evaluated);
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate }, now: () => now });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expect(response.status).toBe(422);
    expect(response.body).toEqual({ ok: false, ...evaluated, failure_code: 'codex_verdict_rejected', receipt: expect.any(Object) });
    expect(verifyVerificationReceipt({ publicKeyPem: receiptPublicKey, receipt: response.body.receipt, missionId: 'mission-1', verdict: 'fail', evidence, now })).toBe(true);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it.each(['git_diff', 'git_status', 'test_report'])('Codex refuses PASS without %s evidence', async (missingKind) => {
    const store = collector(); const evaluate = jest.fn();
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({
      mission_id: 'mission-1', evidence: { ...evidence, artifacts: artifacts.filter((artifact) => artifact.kind !== missingKind) },
    });
    expect(response.status).toBe(422);
    expect(response.body).toEqual({
      ok: false, verdict: 'fail', failure_code: 'codex_evidence_missing', summary: 'Required independent evidence is incomplete.',
      evidence: ['required-evidence:missing'], cost_usd: 0,
    });
    expect(store.read).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
  });

  it('Codex refuses failed, malformed or contradictory test evidence before model invocation', async () => {
    const evaluate = jest.fn();
    const verify = async (report: string, claims = ['tests:pass']) => {
      const store = collector({ read: jest.fn((items) => items.map((artifact) => ({ artifact, content: artifact.kind === 'test_report' ? report : 'safe' }))) });
      const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate } });
      return request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence: { ...evidence, claims } });
    };
    const failed = JSON.stringify({ schema: 'ronor-test-report/v1', passed: false, command_count: 1, results: [{ id: 'jest', passed: false, exit_code: 1, signal: null }] });
    for (const response of [
      await verify(failed), await verify('{bad json'), await verify('null'),
      await verify(passingReport, ['tests:pass', 'test:jest:fail']), await verify(passingReport, []),
      await verify(JSON.stringify({ schema: 'ronor-test-report/v1', passed: true, command_count: 0, results: [] })),
    ]) {
      expect(response.status).toBe(422);
      expect(response.body).toEqual({
        ok: false, verdict: 'fail', failure_code: 'codex_test_evidence_invalid',
        summary: 'Test evidence does not deterministically prove a passing run.', evidence: ['test-evidence:invalid'], cost_usd: 0,
      });
    }
    expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    { mission_id: '../invalid', evidence },
    { mission_id: 42, evidence },
    { evidence },
    { mission_id: 'mission-1' },
    { mission_id: 'mission-1', evidence: { claims: ['tests:pass'], artifacts: [] } },
  ])('Codex labels invalid verification request %# without reading evidence', async (body) => {
    const store = collector(); const evaluate = jest.fn();
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send(body);
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'invalid_verification_request', failure_code: 'codex_request_invalid' });
    expect(store.read).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
  });

  it('Codex rejects duplicate artifact references before reading evidence', async () => {
    const store = collector(); const evaluate = jest.fn();
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate } });
    const duplicated = [...artifacts, { ...artifacts[2], kind: 'event_log' as const }];
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence: { claims: ['tests:pass'], artifacts: duplicated } });
    expect(response.status).toBe(400);
    expect(response.body).toEqual({ ok: false, error: 'invalid_verification_request', failure_code: 'codex_request_invalid' });
    expect(store.read).not.toHaveBeenCalled(); expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'tampered artifact digest', error: new Error('artifact_integrity_failed') },
    { label: 'secret-bearing read error', error: new Error('artifact secret: private-credential-value') },
    { label: 'accounted error outside evaluation', error: new AccountedEvaluationError('codex_api_timeout', 0) },
  ])('Codex safely labels $label as an artifact read failure', async ({ error }) => {
    const store = collector({ read: jest.fn(() => { throw error; }) }); const evaluate = jest.fn();
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: store, evaluator: { evaluate } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expectClosedFailure(response, 'codex_artifact_read_failed', 0);
    expect(store.read).toHaveBeenCalledWith(artifacts); expect(evaluate).not.toHaveBeenCalled();
  });

  it.each([
    'codex_api_response_too_large', 'codex_api_usage_missing', 'codex_api_usage_invalid',
    'codex_api_output_missing', 'codex_api_output_not_json', 'codex_api_output_invalid',
    'codex_api_timeout', 'codex_api_unavailable',
    'codex_api_http_100', 'codex_api_http_199', 'codex_api_http_200', 'codex_api_http_299',
    'codex_api_http_300', 'codex_api_http_399', 'codex_api_http_400', 'codex_api_http_429',
    'codex_api_http_499', 'codex_api_http_500', 'codex_api_http_503', 'codex_api_http_599',
  ])('Codex exposes the exact accounted code %s and preserves charged, zero and unknown cost', async (code) => {
    for (const cost of [0.037, 0, null]) {
      const evaluate = jest.fn(async () => { throw new AccountedEvaluationError(code, cost); });
      const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate } });
      const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
      expectClosedFailure(response, code, cost);
      expect(evaluate).toHaveBeenCalledTimes(1);
    }
  });

  it.each([
    'secret provider detail: Authorization: Bearer private-credential-value',
    'codex_api_output_invalid_secret_credential', 'codex_api_unknown_failure',
    'codex_api_timeout\n', 'codex_api_http_429\n', 'codex_api_http_429\r\n',
    'codex_api_http_429 secret provider response', 'codex_api_http_099', 'codex_api_http_600',
    'codex_api_http_42', 'codex_api_http_1000', 'prefix_codex_api_http_429', 'codex_api_HTTP_429',
    'invalid_evaluator_result', 'codex_receipt_signing_failed',
  ])('Codex replaces unsafe accounted message %# with a fixed code without losing cost', async (message) => {
    for (const cost of [0.023, null]) {
      const error = new AccountedEvaluationError(message, cost);
      error.stack = 'secret provider stack: private-credential-value';
      const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate: async () => { throw error; } } });
      const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
      expectClosedFailure(response, 'codex_evaluator_failed', cost);
    }
  });

  it.each([undefined, null, { secret: 'private-credential-value' }])('Codex safely handles a non-string accounted error message %#', async (message) => {
    const error = Object.assign(new AccountedEvaluationError('codex_api_timeout', 0.023), { message });
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate: async () => { throw error; } } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expectClosedFailure(response, 'codex_evaluator_failed', 0.023);
  });

  it.each([
    { label: 'secret-bearing Error', error: new Error('secret provider detail: Authorization: Bearer private-credential-value') },
    { label: 'plain Error using an allowed code', error: new Error('codex_api_timeout') },
    { label: 'plain Error using the old result-validation message', error: new Error('invalid_evaluator_result') },
    { label: 'error-shaped object', error: { message: 'codex_api_output_invalid', cost_usd: 123, stack: 'secret provider stack' } },
    { label: 'non-Error rejection', error: 'secret provider detail: private-credential-value' },
  ])('Codex fails closed with only a fixed code and summary for $label', async ({ error }) => {
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate: async () => { throw error; } } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expectClosedFailure(response, 'codex_evaluator_failed', null);
  });

  it.each([
    { label: 'null result', result: null, cost: null },
    { label: 'missing result', result: undefined, cost: null },
    { label: 'invalid verdict', result: { ...passingEvaluation, verdict: 'PASS' }, cost: 0.01 },
    { label: 'invalid summary', result: { ...passingEvaluation, summary: { secret: 'private-credential-value' } }, cost: 0.01 },
    { label: 'oversized summary', result: { ...passingEvaluation, summary: 'x'.repeat(4001) }, cost: 0.01 },
    { label: 'invalid evidence', result: { ...passingEvaluation, evidence: 'secret provider response' }, cost: 0.01 },
    { label: 'too many evidence items', result: { ...passingEvaluation, evidence: Array(51).fill('item') }, cost: 0.01 },
    { label: 'invalid evidence item', result: { ...passingEvaluation, evidence: [null] }, cost: 0.01 },
    { label: 'oversized evidence item', result: { ...passingEvaluation, evidence: ['x'.repeat(2001)] }, cost: 0.01 },
    { label: 'negative cost', result: { ...passingEvaluation, cost_usd: -1 }, cost: null },
    { label: 'unknown cost', result: { ...passingEvaluation, cost_usd: null }, cost: null },
    { label: 'NaN cost', result: { ...passingEvaluation, cost_usd: NaN }, cost: null },
    { label: 'infinite cost', result: { ...passingEvaluation, cost_usd: Infinity }, cost: null },
    { label: 'string cost', result: { ...passingEvaluation, cost_usd: '0.01' }, cost: null },
    { label: 'invalid result with zero cost', result: { ...passingEvaluation, verdict: 'invalid', cost_usd: 0 }, cost: 0 },
  ])('Codex safely labels $label as an invalid evaluator result while preserving known cost', async ({ result, cost }) => {
    const evaluate = jest.fn(async () => result as Awaited<ReturnType<CodexEvaluationPort['evaluate']>>);
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate } });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expectClosedFailure(response, 'codex_evaluator_result_invalid', cost);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it.each(['pass', 'fail'] as const)('Codex labels signing failure after a valid %s evaluation and retains cost without a receipt', async (verdict) => {
    const evaluate = jest.fn(async () => ({ ...passingEvaluation, verdict }));
    const app = createCodexVerifierApp({ serviceToken: 'codex-token', receiptPrivateKey: 'invalid secret signing key', artifacts: collector(), evaluator: { evaluate }, now: () => now });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expectClosedFailure(response, 'codex_receipt_signing_failed', 0.01);
    expect(evaluate).toHaveBeenCalledTimes(1);
  });

  it('Codex uses the signing phase even when receipt preparation throws an accounted evaluator code', async () => {
    const app = createCodexVerifierApp({
      serviceToken: 'codex-token', receiptPrivateKey, artifacts: collector(), evaluator: { evaluate: async () => passingEvaluation },
      now: () => { throw new AccountedEvaluationError('codex_api_timeout', 0.04); },
    });
    const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer codex-token').send({ mission_id: 'mission-1', evidence });
    expectClosedFailure(response, 'codex_receipt_signing_failed', 0.04);
  });

  it('Victoria re-verifies artifacts and applies a distinct assurance policy', async () => {
    const store = collector(); const app = createAssuranceAuthorityApp({ serviceToken: 'victoria-token', receiptPublicKey, artifacts: store, now: () => now });
    expect((await request(app).get('/health').set('Authorization', 'Bearer codex-token')).status).toBe(401);
    const receipt = signVerificationReceipt({ privateKeyPem: receiptPrivateKey, missionId: 'mission-1', verdict: 'pass', evidence, now });
    const accepted = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({ mission_id: 'mission-1', verification: { verdict: 'pass', summary: 'verified', evidence: ['codex:pass'], receipt }, evidence });
    expect(accepted.status).toBe(200); expect(accepted.body.evidence).toEqual(['assurance:policy-pass']); expect(store.read).toHaveBeenCalledWith(artifacts);
    const rejected = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({ mission_id: 'mission-1', verification: { verdict: 'fail' }, evidence });
    expect(rejected.status).toBe(422); expect(rejected.body.verdict).toBe('fail');
  });

  it('Victoria fails closed on a digest mismatch before policy evaluation', async () => {
    const store = collector({ read: jest.fn(() => { throw new Error('artifact_integrity_failed'); }) });
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

  it('Victoria independently rejects a valid Codex receipt over a failed test report', async () => {
    const failedReport = JSON.stringify({
      schema: 'ronor-test-report/v1', passed: false, command_count: 1,
      results: [{ id: 'jest', passed: false, exit_code: 1, signal: null }],
    });
    const store = collector({ read: jest.fn((items) => items.map((artifact) => ({ artifact, content: artifact.kind === 'test_report' ? failedReport : 'safe' }))) });
    const app = createAssuranceAuthorityApp({ serviceToken: 'victoria-token', receiptPublicKey, artifacts: store, now: () => now });
    const receipt = signVerificationReceipt({ privateKeyPem: receiptPrivateKey, missionId: 'mission-1', verdict: 'pass', evidence, now });
    const response = await request(app).post('/v1/assure').set('Authorization', 'Bearer victoria-token').send({
      mission_id: 'mission-1', verification: { verdict: 'pass', receipt }, evidence,
    });
    expect(response.status).toBe(422);
    expect(response.body.evidence).toEqual(['assurance:policy-fail']);
  });
});
