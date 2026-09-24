import { AutomationAdapterError, createCodexVerifierAdapter } from '../../src/runtime/automation/adapters/http';
import { runExecutiveMission } from '../../src/runtime/automation/runner';
import { signMandateAuthority } from '../../src/runtime/automation/mandate-issuer';
import { ALWAYS_DENIED_ACTIONS, objectiveHash } from '../../src/runtime/automation/policy';
import { createMission, getMissionFabric, verifyMissionFabric } from '../../src/runtime/mission/store';
import { closeDb } from '../../src/audit/hash-chain';
import { resetSchemaGuard } from '../../src/runtime/ledgers/schema';
import type { AutomationAdapters } from '../../src/runtime/automation/contracts';
import request from 'supertest';
import crypto from 'node:crypto';
import { createCodexVerifierApp } from '../../src/runtime/automation/services/verification-authorities';
import { AccountedEvaluationError } from '../../src/runtime/automation/services/codex-evaluator';
import type { WorkspaceArtifactCollector } from '../../src/runtime/automation/artifacts';
import type { EvidenceArtifact } from '../../src/runtime/automation/contracts';

const previousDb = process.env.AUDIT_DB_PATH;
beforeAll(() => { closeDb(); resetSchemaGuard(); process.env.AUDIT_DB_PATH = ':memory:'; });
afterAll(() => {
  closeDb(); resetSchemaGuard();
  if (previousDb === undefined) delete process.env.AUDIT_DB_PATH;
  else process.env.AUDIT_DB_PATH = previousDb;
});

const failure = (overrides: Record<string, unknown> = {}) => ({
  ok: false, verdict: 'fail', summary: 'Independent verification failed closed.',
  evidence: ['verification:failed-closed'], cost_usd: 0.04, ...overrides,
});
const adapter = (body: unknown, status = 422) => createCodexVerifierAdapter({
  baseUrl: 'https://codex.invalid', token: 'fixture-service-credential',
  capabilityKey: 'fixture-capability-key-0123456789abcdef',
  fetcher: jest.fn(async () => new Response(JSON.stringify(body), { status })),
});
const verify = (body: unknown, status = 422) => adapter(body, status).verify('mission', { claims: [], artifacts: [] });

describe('Codex rejection diagnostics at the HTTP boundary', () => {
  it.each([
    ['codex_evidence_missing', 'rejection'],
    ['codex_test_evidence_invalid', 'rejection'],
    ['codex_verdict_rejected', 'rejection'],
    ['codex_api_output_not_json', 'service'],
    ['codex_api_http_429', 'service'],
    ['codex_api_timeout', 'service'],
    ['codex_artifact_read_failed', 'service'],
    ['codex_receipt_signing_failed', 'service'],
  ])('preserves %s as diagnostic data, never as a successful verdict', async (code, category) => {
    await expect(verify(failure({ failure_code: code }))).rejects.toMatchObject({
      message: code, cost_usd: 0.04,
      diagnostic: { code, category, http_status: 422, verdict: 'fail',
        summary: 'Independent verification failed closed.', evidence: ['verification:failed-closed'] },
    });
  });

  it.each([
    ['required-evidence:missing', 'codex_evidence_missing', 'rejection'],
    ['test-evidence:invalid', 'codex_test_evidence_invalid', 'rejection'],
    ['verification:failed-closed', 'codex_verification_failed_closed', 'service'],
    ['unknown:failure', 'codex_failure_unclassified', 'unknown'],
  ])('supports legacy %s without inventing a detailed cause', async (evidence, code, category) => {
    await expect(verify(failure({ evidence: [evidence] }))).rejects.toMatchObject({
      diagnostic: { code, category, evidence: [evidence] },
    });
  });

  it.each([0, 0.04, null])('retains exact failed-call accounting: %s', async cost => {
    await expect(verify(failure({ failure_code: 'codex_api_output_invalid', cost_usd: cost })))
      .rejects.toMatchObject({ cost_usd: cost });
  });

  it('distinguishes a gateway 503 from a verifier rejection', async () => {
    await expect(verify(failure({ failure_code: 'codex_verdict_rejected' }), 503))
      .rejects.toMatchObject({ diagnostic: { code: 'adapter_http_503', category: 'http', http_status: 503 } });
  });

  it.each([401, 403])('retains HTTP %s with unknown accounting for minimal auth responses', async status => {
    await expect(verify({ ok: false, error: 'unauthorized' }, status)).rejects.toMatchObject({
      cost_usd: null, diagnostic: { code: `adapter_http_${status}`, category: 'http', http_status: status },
    });
  });

  it('retains a typed invalid-request code without fabricating zero cost', async () => {
    await expect(verify({ ok: false, failure_code: 'codex_request_invalid' }, 400))
      .rejects.toMatchObject({ cost_usd: null, diagnostic: { code: 'codex_request_invalid', http_status: 400 } });
  });

  it.each([
    { ok: true, verdict: 'pass' }, { verdict: 'pass' }, { summary: 'x'.repeat(4001) },
    { evidence: [42] }, { evidence: Array(51).fill('x') },
  ])('fails closed on malformed or contradictory failure envelopes', async overrides => {
    await expect(verify(failure(overrides))).rejects.toMatchObject({
      diagnostic: { code: 'codex_failure_response_invalid', category: 'protocol' },
    });
  });

  it.each([
    'Bearer abcdefghijklmnopqrstuvwxyz123456', 'Bearer abcdefghijkl',
    'sk-abcdefghijklmnop1234', 'eyJabc.abc.def', 'fixture-service-credential',
    // The title must not interpolate the fixture: the evidence runner refuses a test
  // report whose output contains credential-shaped text, so %s here failed the
  // isolated verification of run_3847cd6530ad06a733eb on 24 September 2026.
  ])('never exposes credential-like failure detail (fixture %#)', async secret => {
    let captured: unknown;
    try { await verify(failure({ summary: secret })); } catch (error) { captured = error; }
    expect(captured).toBeInstanceOf(AutomationAdapterError);
    expect(JSON.stringify(captured)).not.toContain(secret);
    expect((captured as AutomationAdapterError).message).not.toContain(secret);
  });

  it('retains the reason while explicitly omitting details above the event budget', async () => {
    await expect(verify(failure({ failure_code: 'codex_api_output_invalid', evidence: Array(50).fill('x'.repeat(2000)) })))
      .rejects.toMatchObject({ diagnostic: {
        code: 'codex_api_output_invalid', category: 'service', details_omitted: true,
      } });
  });

  it('does not accept PASS without the existing required receipt', async () => {
    await expect(verify({ ok: true, verdict: 'pass', summary: 'ok', evidence: [], cost_usd: 0 }, 200))
      .rejects.toThrow('codex_receipt_invalid');
  });

  it('does not accept PASS carried on a failure HTTP response', async () => {
    const receipt = { version: 'ronor-codex-receipt/v1', issuer: 'codex-verifier', mission_id: 'mission',
      verdict: 'pass', evidence_digest: 'a'.repeat(64), issued_at: new Date().toISOString(), signature: 'a'.repeat(86) };
    await expect(verify({ ok: true, verdict: 'pass', summary: 'ok', evidence: [], cost_usd: 0, receipt }))
      .rejects.toThrow('codex_failure_response_invalid');
  });

  it('preserves a real authority response through the HTTP adapter without a model call', async () => {
    const materials: EvidenceArtifact[] = ['git_diff', 'git_status', 'test_report'].map((kind, index) => ({
      kind: kind as EvidenceArtifact['kind'], sha256: `${index + 1}`.repeat(64), reference: `run/file-${index}`, bytes: 4,
    }));
    const store: WorkspaceArtifactCollector = {
      collect: jest.fn(() => materials), verify: jest.fn(items => items),
      recordTestReport: jest.fn(() => materials[2]),
      read: jest.fn(items => items.map(artifact => ({ artifact, content: artifact.kind === 'test_report'
        ? JSON.stringify({ schema: 'ronor-test-report/v1', passed: true, command_count: 1,
          results: [{ id: 'jest', passed: true, exit_code: 0, signal: null }] }) : 'safe' }))),
    };
    const receiptPrivateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const evaluate = jest.fn(async () => { throw new AccountedEvaluationError('codex_api_output_not_json', 0.04); });
    const app = createCodexVerifierApp({ serviceToken: 'fixture-service-credential', receiptPrivateKey,
      artifacts: store, evaluator: { evaluate } });
    const fetcher = jest.fn(async (_url: URL | Request | string, init?: RequestInit) => {
      const response = await request(app).post('/v1/verify').set('Authorization', 'Bearer fixture-service-credential')
        .send(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
    const codex = createCodexVerifierAdapter({ baseUrl: 'https://codex.invalid', token: 'fixture-service-credential', fetcher });
    await expect(codex.verify('mission', { claims: ['tests:pass'], artifacts: materials }))
      .rejects.toMatchObject({ cost_usd: 0.04, diagnostic: { category: 'service',
        code: 'codex_api_output_not_json', http_status: 422, verdict: 'fail' } });
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

async function runWithCodex(codex: AutomationAdapters['codex'], signal?: AbortSignal) {
  const objective = 'Read bounded documentation only.';
  const mission = createMission({ title: 'Local diagnostic regression', objective, operatorId: 'test-architect' });
  const authorityKey = 'fixture-authority-key-0123456789abcdef';
  const mandate = signMandateAuthority({
    mandate_id: `mandate-${mission.mission_id}`, mission_id: mission.mission_id, issued_by: 'merlin',
    issued_by_key_id: 'key_0123456789ab', objective_hash: objectiveHash(objective),
    workspace_root: '/tmp/ronor-diagnostics-fixture', branch_prefix: 'agent/',
    allowed_actions: ['read_repo'], denied_actions: [...ALWAYS_DENIED_ACTIONS],
    max_cost_usd: 5, max_runtime_minutes: 15, max_fix_cycles: 1,
    issued_at: '2026-01-01T00:00:00.000Z', expires_at: '2099-01-01T00:00:00.000Z',
  }, authorityKey);
  const accept = jest.fn(async () => ({ ok: true, verdict: 'pass' as const, summary: 'unused', evidence: [], cost_usd: 0 }));
  const adapters: AutomationAdapters = {
    langgraph: { plan: async () => [{ id: 'read-only', instruction: objective, actions: ['read_repo'] }] },
    openhands: { execute: async () => ({ ok: true, summary: 'read', evidence: [], cost_usd: 0.2 }) },
    codex, assurance: { accept },
  };
  const result = await runExecutiveMission({
    objective, workspaceRoot: mandate.workspace_root, branch: 'agent/diagnostic', mandate, authorityKey, adapters, signal,
  });
  const fabric = getMissionFabric(mission.mission_id)!;
  expect(accept).not.toHaveBeenCalled();
  expect(result.status).toBe('failed');
  expect(fabric.checkpoints.some(event => event.payload.verdict === 'pass')).toBe(false);
  expect(Object.keys(fabric.evidence)).toHaveLength(0);
  expect(verifyMissionFabric(mission.mission_id)?.valid).toBe(true);
  return { result, fabric, diagnostic: fabric.failures.at(-1)!.payload.diagnostic };
}

describe('Codex diagnostic persistence without acceptance', () => {
  it.each([
    ['codex_verdict_rejected', 'rejection', 'codex_verification_rejected'],
    ['codex_api_output_not_json', 'service', 'codex_service_failed'],
  ])('carries %s from HTTP into the audit event', async (code, category, reason) => {
    const { result, diagnostic } = await runWithCodex(adapter(failure({ failure_code: code })));
    expect(result.reason).toBe(reason);
    expect(result.cost_usd).toBeCloseTo(0.24);
    expect(diagnostic).toMatchObject({ code, category, http_status: 422, verdict: 'fail',
      summary: 'Independent verification failed closed.', evidence: ['verification:failed-closed'] });
  });

  it('preserves unknown cost after a failed verifier call', async () => {
    const { result } = await runWithCodex(adapter(failure({ failure_code: 'codex_api_timeout', cost_usd: null })));
    expect(result.cost_usd).toBeNull();
  });

  it.each(['adapter_timeout', 'adapter_cancelled', 'adapter_unreachable'])('keeps transport code %s', async code => {
    const { result, diagnostic } = await runWithCodex({ verify: async () => { throw new AutomationAdapterError(code); } });
    expect(result.reason).toBe('codex_transport_failed');
    expect(diagnostic).toEqual({ code, category: 'transport' });
    expect(result.cost_usd).toBeNull();
  });

  it('records malformed JSON as a protocol error rather than a rejection', async () => {
    const codex = createCodexVerifierAdapter({ baseUrl: 'https://codex.invalid', token: 'fixture-service-credential',
      capabilityKey: 'fixture-capability-key-0123456789abcdef',
      fetcher: jest.fn(async () => new Response('<html>failure</html>', { status: 502 })) });
    const { result, diagnostic } = await runWithCodex(codex);
    expect(result.reason).toBe('codex_protocol_failed');
    expect(diagnostic).toMatchObject({ code: 'adapter_invalid_json', category: 'protocol' });
  });

  it('never logs an unexpected exception or its stack', async () => {
    const secret = 'Bearer abcdefghijklmnopqrstuvwxyz123456';
    const { result, fabric, diagnostic } = await runWithCodex({ verify: async () => { throw new Error(secret); } });
    expect(result.reason).toBe('codex_adapter_failed');
    expect(diagnostic).toEqual({ code: 'codex_adapter_failed', category: 'unknown' });
    expect(JSON.stringify(fabric)).not.toContain(secret);
    expect(result.cost_usd).toBeNull();
  });

  it.each(['codex_api_http_429\n', 'adapter_http_503\n', 'codex_api_arbitrary_secret_suffix'])(
    'does not persist an unrecognised exception code: %s', async code => {
      const { result, diagnostic, fabric } = await runWithCodex({ verify: async () => {
        throw new AutomationAdapterError(code, 0.04);
      } });
      expect(result.reason).toBe('codex_adapter_failed');
      expect(diagnostic).toEqual({ code: 'codex_adapter_failed', category: 'unknown' });
      expect(JSON.stringify(fabric)).not.toContain(JSON.stringify(code).slice(1, -1));
      expect(result.cost_usd).toBeCloseTo(0.24);
    });

  it.each(['summary', 'evidence'])('filters raw credential strings in %s before persistent encoding', async field => {
    for (const secret of ['Bearer\tabcdefghijkl', 'Bearer\nabcdefghijkl', 'Bearer abc123', 'Bearer x']) {
      const details = field === 'summary' ? { summary: secret } : { evidence: [secret] };
      const { result, fabric, diagnostic } = await runWithCodex(adapter(failure({
        failure_code: 'codex_api_output_invalid', ...details,
      })));
      expect(result.reason).toBe('codex_protocol_failed');
      expect(result.cost_usd).toBeCloseTo(0.24);
      expect(diagnostic).toEqual({ code: 'codex_failure_response_invalid', category: 'protocol', http_status: 422 });
      expect(JSON.stringify(fabric)).not.toContain(JSON.stringify(secret).slice(1, -1));
    }
  });

  it.each(['throwing-code', 'shadowed-every', 'throwing-element', 'throwing-diagnostic', 'throwing-message'])(
    'records terminal failure despite custom diagnostic %s', async kind => {
      const diagnostic: Record<string, unknown> = { code: 'adapter_timeout', category: 'transport' };
      if (kind === 'throwing-code') Object.defineProperty(diagnostic, 'code', {
        get: () => { throw new Error('synthetic-private-detail'); },
      });
      if (kind === 'shadowed-every') diagnostic.evidence = Object.assign([], { every: null });
      if (kind === 'throwing-element') diagnostic.evidence = Object.defineProperty(['safe'], '0', {
        get: () => { throw new Error('synthetic-private-detail'); },
      });
      const error = Object.assign(new AutomationAdapterError('adapter_timeout', 0.04), { diagnostic });
      if (kind === 'throwing-diagnostic') Object.defineProperty(error, 'diagnostic', {
        get: () => { throw new Error('synthetic-private-detail'); },
      });
      if (kind === 'throwing-message') {
        Object.defineProperty(error, 'diagnostic', { value: undefined });
        Object.defineProperty(error, 'message', { get: () => { throw new Error('synthetic-private-detail'); } });
      }
      const { result, fabric, diagnostic: recorded } = await runWithCodex({ verify: async () => { throw error; } });
      expect(result.cost_usd).toBeCloseTo(0.24);
      expect(result.reason).toBe(['throwing-diagnostic', 'throwing-message'].includes(kind)
        ? 'codex_adapter_failed' : 'codex_transport_failed');
      expect(recorded).toMatchObject({ code: ['throwing-diagnostic', 'throwing-message'].includes(kind)
        ? 'codex_adapter_failed' : 'adapter_timeout' });
      expect(JSON.stringify(fabric)).not.toContain('synthetic-private-detail');
    });

  it('preserves cancellation and unknown cost when diagnostic extraction fails', async () => {
    const controller = new AbortController();
    const error = new AutomationAdapterError('adapter_timeout', null);
    Object.defineProperty(error, 'diagnostic', { get: () => { throw new Error('synthetic-private-detail'); } });
    const { result, diagnostic } = await runWithCodex({ verify: async () => {
      controller.abort(); throw error;
    } }, controller.signal);
    expect(result.reason).toBe('cancelled');
    expect(result.cost_usd).toBeNull();
    expect(diagnostic).toEqual({ code: 'codex_adapter_failed', category: 'unknown' });
  });

  it('terminates safely when response details exceed the event size limit', async () => {
    const { result, diagnostic } = await runWithCodex(adapter(failure({
      failure_code: 'codex_api_output_invalid', evidence: Array(50).fill('\n'.repeat(2000)),
    })));
    expect(result.reason).toBe('codex_service_failed');
    expect(diagnostic).toMatchObject({ code: 'codex_api_output_invalid', details_omitted: true });
    expect(JSON.stringify(diagnostic).length).toBeLessThan(12_000);
  });

  it('keeps explicit run cancellation higher priority than diagnostic classification', async () => {
    const controller = new AbortController();
    const { result, diagnostic } = await runWithCodex({ verify: async () => {
      controller.abort(); throw new AutomationAdapterError('adapter_cancelled');
    } }, controller.signal);
    expect(result.reason).toBe('cancelled');
    expect(diagnostic).toMatchObject({ code: 'adapter_cancelled' });
  });
});
