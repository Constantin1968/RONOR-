import request from 'supertest';
import { createMission, getMissionFabric, verifyMissionFabric } from '../../src/runtime/mission/store';
import { ALWAYS_DENIED_ACTIONS, objectiveHash } from '../../src/runtime/automation/policy';
import { executionRunId, runExecutiveMission } from '../../src/runtime/automation/runner';
import { signMandateAuthority } from '../../src/runtime/automation/mandate-issuer';
import { createNativeOpenHandsClient } from '../../src/runtime/automation/adapters/openhands-native';
import { createOpenHandsAdapter } from '../../src/runtime/automation/adapters/http';
import { createOpenHandsBridgeApp } from '../../src/runtime/automation/services/openhands-bridge';
import { evaluateOpenHandsEffects } from '../../src/runtime/automation/effect-policy';
import { EFFECT_RULES, readEffectDiagnostics, readResultEffectDiagnostics } from '../../src/runtime/automation/effect-diagnostics';
import type { AdapterResult, AutomationAdapters, PlannedAssignment } from '../../src/runtime/automation/contracts';

const valid = {
  rule: 'privilege_escalation_forbidden' as const, scanned_actions: 1, scanned_chars: 25,
  match_index: 12, match_locus: 'command' as const,
};
const invalidDiagnostics: Array<[string, unknown]> = [
  ['missing field', { ...valid, match_locus: undefined }],
  ['unknown rule', { ...valid, rule: 'synthetic_private_input_key' }],
  ['rule suffix', { ...valid, rule: `${valid.rule}\n` }],
  ['unknown locus', { ...valid, match_locus: '/private/fixture-path' }],
  ['extra field', { ...valid, synthetic_private_input_key: 'never emit' }],
  ['negative actions', { ...valid, scanned_actions: -1 }],
  ['fractional actions', { ...valid, scanned_actions: 0.5 }],
  ['infinite actions', { ...valid, scanned_actions: Infinity }],
  ['unsafe actions', { ...valid, scanned_actions: Number.MAX_SAFE_INTEGER + 1 }],
  ['not-a-number chars', { ...valid, scanned_chars: NaN }],
  ['string chars', { ...valid, scanned_chars: '25' }],
  ['fractional chars', { ...valid, scanned_chars: 25.1 }],
  ['infinite chars', { ...valid, scanned_chars: Infinity }],
  ['unsafe chars', { ...valid, scanned_chars: Number.MAX_SAFE_INTEGER + 1 }],
  ['oversized matched scan', { ...valid, scanned_chars: 128001 }],
  ['negative index', { ...valid, match_index: -1 }],
  ['fractional index', { ...valid, match_index: 0.5 }],
  ['infinite index', { ...valid, match_index: Infinity }],
  ['unsafe index', { ...valid, match_index: Number.MAX_SAFE_INTEGER + 1 }],
  ['index at end', { ...valid, match_index: 25 }],
  ['index beyond end', { ...valid, match_index: 26 }],
  ['index without rule', { ...valid, rule: null }],
  ['rule without index', { ...valid, match_index: null }],
  ['rule without locus', { ...valid, match_locus: null }],
  ['match without actions', { ...valid, scanned_actions: 0 }],
  ['array', [valid]],
  ['null', null],
];

describe('closed effect diagnostics', () => {
  it.each(EFFECT_RULES)('admits only the fixed rule %s in a fresh object', rule => {
    const input = { ...valid, rule };
    const result = readEffectDiagnostics(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  });

  it.each(invalidDiagnostics)('rejects %s without copying any part of it', (_name, input) => {
    expect(readEffectDiagnostics(input)).toBeNull();
  });

  it('admits non-pattern diagnostics, including the original oversized count', () => {
    for (const [actions, chars] of [[0, 0], [1, 128001], [1, 0]]) {
      const diagnostic = { rule: null, scanned_actions: actions, scanned_chars: chars, match_index: null, match_locus: null };
      expect(readEffectDiagnostics(diagnostic)).toEqual(diagnostic);
    }
    expect(readEffectDiagnostics({ rule: null, scanned_actions: 0, scanned_chars: 1, match_index: null, match_locus: null })).toBeNull();
  });

  it('rejects accessor, inherited, symbol and serialization-hook injection without invoking getters', () => {
    const get = jest.fn(() => { throw new Error('synthetic_private_detail'); });
    const accessor = Object.defineProperty({ ...valid }, 'rule', { get });
    const toJSON = jest.fn(() => ({ synthetic_private_input_key: '/private/fixture-path' }));
    for (const input of [
      accessor, Object.create(valid), { ...valid, toJSON }, { ...valid, [Symbol('private')]: 'private' },
      Object.defineProperty({ ...valid }, 'extra', { value: 'private', enumerable: false }),
      new Proxy({ ...valid }, { ownKeys: get }),
    ]) expect(readEffectDiagnostics(input)).toBeNull();
    // The Proxy trap may run, but object property accessors and toJSON must not.
    expect(get).toHaveBeenCalledTimes(1);
    expect(toJSON).not.toHaveBeenCalled();
  });

  it('does not carry diagnostics on successful results or invoke custom diagnostic getters', () => {
    expect(readResultEffectDiagnostics({ ok: true, effect_diagnostics: valid })).toBeNull();
    const get = jest.fn(() => { throw new Error('synthetic_private_detail'); });
    expect(readResultEffectDiagnostics(Object.defineProperty({ ok: false }, 'effect_diagnostics', { get }))).toBeNull();
    expect(get).not.toHaveBeenCalled();
  });
});

const objective = 'Read bounded documentation.';
const authorityKey = 'fixture-effect-authority-key-0123456789abcdef';
const capabilityKey = 'fixture-effect-capability-key-0123456789abcdef';
const serviceToken = 'fixture-effect-service-token';
const assignment: PlannedAssignment = { id: 'effect-refusal', instruction: objective, actions: ['read_repo'] };
const conversationId = '11111111-1111-4111-8111-111111111111';
const refusalReason = `openhands_action_refused_${valid.rule}`;
const json = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });

function fixture() {
  const mission = createMission({ title: 'Effect diagnostics regression', objective, operatorId: 'test-architect' });
  const mandate = signMandateAuthority({
    mandate_id: `mandate-${mission.mission_id}`, mission_id: mission.mission_id, issued_by: 'merlin',
    issued_by_key_id: 'key_0123456789ab', objective_hash: objectiveHash(objective),
    workspace_root: '/tmp/ronor-effect-fixture', branch_prefix: 'agent/', allowed_actions: ['read_repo'],
    denied_actions: [...ALWAYS_DENIED_ACTIONS], max_cost_usd: 5, max_runtime_minutes: 15, max_fix_cycles: 1,
    issued_at: '2026-01-01T00:00:00.000Z', expires_at: new Date(Date.now() + 120_000).toISOString(),
  }, authorityKey);
  return { mission, mandate };
}

async function runFailure(openhands: AutomationAdapters['openhands'], setup = fixture()) {
  const verify = jest.fn();
  const accept = jest.fn();
  const collect = jest.fn();
  const verifyWorkspace = jest.fn();
  const { mission, mandate } = setup;
  const result = await runExecutiveMission({
    objective, workspaceRoot: mandate.workspace_root, branch: 'agent/effect-fixture', mandate, authorityKey,
    adapters: {
      langgraph: { plan: async () => [assignment] }, openhands, codex: { verify }, assurance: { accept },
    },
    artifactCollector: { collect, verify: jest.fn(), read: jest.fn(), recordTestReport: jest.fn() },
    postExecutionVerifier: { verify: verifyWorkspace, attest: jest.fn() },
  });
  const fabric = getMissionFabric(mission.mission_id)!;
  expect(result.completed_assignments).toBe(0);
  expect(fabric.tasks[assignment.id].status).not.toBe('complete');
  expect(verify).not.toHaveBeenCalled();
  expect(accept).not.toHaveBeenCalled();
  expect(collect).not.toHaveBeenCalled();
  expect(verifyWorkspace).not.toHaveBeenCalled();
  expect(Object.keys(fabric.evidence)).toHaveLength(0);
  expect(fabric.checkpoints.some(event => event.payload.verdict === 'pass')).toBe(false);
  expect(verifyMissionFabric(mission.mission_id)?.valid).toBe(true);
  expect(fabric.failures).toHaveLength(1);
  return { result, fabric, failure: fabric.failures[0].payload };
}

function httpResult(body: unknown) {
  return createOpenHandsAdapter({
    baseUrl: 'https://bridge.invalid', token: serviceToken, capabilityKey,
    fetcher: jest.fn(async () => json(body)),
  });
}

describe('effect refusal native → bridge → HTTP → runner → durable fabric', () => {
  it.each([0.1, null])('preserves diagnostics and refusal with final cost %s', async finalCost => {
    const setup = fixture();
    const command = `${['su', 'do'].join('')} npm test`;
    const action = { kind: 'ActionEvent', action: { command, content: 'synthetic_private_prose', path: 'private-path.txt' } };
    const expected = evaluateOpenHandsEffects({ items: [action] }, assignment.actions).diagnostics;
    let paused = false;
    const nativeFetch = jest.fn(async (input: URL | Request | string) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/conversations') return json({ id: conversationId });
      if (url.pathname.endsWith('/events/search')) return json({ items: [{ id: 'pending', ...action }] });
      if (url.pathname.endsWith('/events') || url.pathname.endsWith('/events/respond_to_confirmation')) return json({ accepted: true });
      if (url.pathname.endsWith('/pause')) { paused = true; return json({ paused: true }); }
      return json({ execution_status: paused ? 'paused' : 'waiting_for_confirmation',
        leaf_event_id: 'pending', cost_usd: paused ? finalCost : 0.1 });
    });
    const native = createNativeOpenHandsClient({
      baseUrl: 'https://native.invalid', sessionApiKey: 'fixture-native-token', fetcher: nativeFetch,
      pollIntervalMs: 0, startupPolls: 0,
    });
    const nativeExecute = jest.spyOn(native, 'execute');
    const app = createOpenHandsBridgeApp({ capabilityKey, serviceToken, client: native });
    let bridgeBody: Record<string, unknown> | undefined;
    const httpFetch = jest.fn(async (input: URL | Request | string, init?: RequestInit) => {
      expect(getMissionFabric(setup.mission.mission_id)!.runs[executionRunId(setup.mandate.mandate_id)])
        .toMatchObject({ cost_usd: null, cost_basis: 'unknown_pending_dispatch' });
      const response = await request(app).post(new URL(String(input)).pathname)
        .set(init!.headers as Record<string, string>).send(JSON.parse(String(init?.body)));
      expect(response.status).toBe(200);
      bridgeBody = response.body;
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
    const http = createOpenHandsAdapter({ baseUrl: 'https://bridge.invalid', token: serviceToken, capabilityKey, fetcher: httpFetch });
    const httpExecute = jest.spyOn(http, 'execute');
    const { result, fabric, failure } = await runFailure(http, setup);
    const nativeResult = await nativeExecute.mock.results[0].value;
    const parsedResult = await httpExecute.mock.results[0].value;
    for (const value of [nativeResult, bridgeBody, parsedResult]) {
      expect(value).toMatchObject({ ok: false, summary: refusalReason, cost_usd: finalCost, effect_diagnostics: expected });
    }
    expect(failure).toMatchObject({ reason: refusalReason, effect_diagnostics: expected });
    expect(Object.keys(failure).sort()).toEqual(['effect_diagnostics', 'id', 'reason', 'run_id']);
    expect(result.cost_usd).toBe(finalCost);
    expect(result.status).toBe(finalCost === null ? 'blocked' : 'failed');
    expect(result.reason).toBe(finalCost === null ? 'cost_accounting_unknown' : refusalReason);
    expect(fabric.runs[result.run_id].cost_basis).toBe(finalCost === null ? 'unknown_reconciliation_required' : 'runner_subtotal');
    expect(fabric.checkpoints.filter(event => event.payload.kind === 'openhands_conversation'))
      .toHaveLength(1);
    const confirm = nativeFetch.mock.calls.find(call => String(call[0]).endsWith('/events/respond_to_confirmation'));
    // The native fetch mock's call type omits init; inspect the actual call only.
    const init = (confirm as unknown as [unknown, RequestInit])[1];
    expect(JSON.parse(String(init.body)).accept).toBe(false);
    for (const privateValue of [command, 'synthetic_private_prose', 'private-path.txt', 'fixture-native-token']) {
      expect(JSON.stringify(fabric)).not.toContain(privateValue);
    }
    expect(httpFetch).toHaveBeenCalledTimes(1);
  });

  it('keeps diagnostics when pause/accounting fails after a policy refusal', async () => {
    const fetcher = jest.fn(async (input: URL | Request | string) => {
      const url = new URL(String(input));
      if (url.pathname === '/api/conversations') return json({ id: conversationId });
      if (url.pathname.endsWith('/events/search')) return json({ items: [{
        id: 'pending', kind: 'ActionEvent', action: { command: `${['su', 'do'].join('')} npm test` },
      }] });
      if (url.pathname.endsWith('/pause')) throw new Error('synthetic_private_exception');
      if (url.pathname.endsWith('/events') || url.pathname.endsWith('/events/respond_to_confirmation')) return json({ accepted: true });
      return json({ execution_status: 'waiting_for_confirmation', leaf_event_id: 'pending', cost_usd: 0.1 });
    });
    const setup = fixture();
    const native = createNativeOpenHandsClient({ baseUrl: 'https://native.invalid', sessionApiKey: 'fixture-token', fetcher });
    const result = await native.execute({
      assignment_id: assignment.id, instruction: objective, allowed_actions: assignment.actions,
      objective_hash: setup.mandate.objective_hash, deadline: setup.mandate.expires_at,
    });
    expect(result).toMatchObject({ ok: false, summary: 'openhands_pause_unconfirmed', cost_usd: null,
      effect_diagnostics: { rule: valid.rule, match_locus: 'command' } });
    const { failure, fabric } = await runFailure(httpResult(result), setup);
    expect(failure).toMatchObject({ reason: 'openhands_pause_unconfirmed', effect_diagnostics: result.effect_diagnostics });
    expect(JSON.stringify(fabric)).not.toContain('synthetic_private_exception');
  });

  it.each(invalidDiagnostics)('rejects %s diagnostics through both HTTP and custom adapters', async (_name, diagnostic) => {
    const body = {
      ok: false, summary: refusalReason, evidence: ['synthetic_private_prose'], cost_usd: null,
      effect_diagnostics: diagnostic,
      artifacts: [{ kind: 'git_diff', sha256: 'f'.repeat(64), reference: 'private-path.txt', bytes: 10 }],
    };
    for (const adapter of [httpResult(body), { execute: async () => body as AdapterResult }]) {
      const { failure, fabric, result } = await runFailure(adapter);
      expect(failure.reason).toBe(refusalReason);
      expect(failure).not.toHaveProperty('effect_diagnostics');
      expect(result.cost_usd).toBeNull();
      for (const text of ['synthetic_private_input_key', '/private/fixture-path', 'synthetic_private_prose', 'private-path.txt']) {
        expect(JSON.stringify(fabric)).not.toContain(text);
      }
    }
  });

  it('revalidates and copies custom diagnostics without serializing hooks or invoking accessors', async () => {
    const getter = jest.fn(() => { throw new Error('synthetic_private_exception'); });
    const toJSON = jest.fn(() => ({ synthetic_private_input_key: 'never emit' }));
    const base = { ok: false, summary: refusalReason, evidence: [], cost_usd: 0.1 };
    for (const body of [
      { ...base, effect_diagnostics: { ...valid, toJSON } },
      { ...base, effect_diagnostics: Object.defineProperty({ ...valid }, 'rule', { get: getter }) },
      Object.defineProperty({ ...base }, 'effect_diagnostics', { get: getter }),
    ]) {
      const { failure, fabric } = await runFailure({ execute: async () => body as AdapterResult });
      expect(failure).not.toHaveProperty('effect_diagnostics');
      expect(JSON.stringify(fabric)).not.toContain('synthetic_private');
    }
    expect(getter).not.toHaveBeenCalled();
    expect(toJSON).not.toHaveBeenCalled();
    const { failure } = await runFailure({ execute: async () => ({ ...base, effect_diagnostics: valid }) });
    expect(failure.effect_diagnostics).toEqual(valid);
    expect(failure.effect_diagnostics).not.toBe(valid);
  });

  it('drops diagnostics on successful HTTP results instead of making them accepted evidence', async () => {
    const { mandate } = fixture();
    const result = await httpResult({ ok: true, summary: 'read', evidence: [], cost_usd: 0, effect_diagnostics: valid })
      .execute(assignment, mandate);
    expect(result).not.toHaveProperty('effect_diagnostics');
    expect(result.evidence).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });
});
