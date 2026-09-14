import { appendMissionFabricEvent, createMission, getMissionFabric, verifyMissionFabric } from '../../src/runtime/mission/store';
import { ALWAYS_DENIED_ACTIONS, objectiveHash } from '../../src/runtime/automation/policy';
import { executionRunId, runExecutiveMission as executeMission } from '../../src/runtime/automation/runner';
import { AutomationAdapterError, createOpenHandsAdapter } from '../../src/runtime/automation/adapters/http';
import { signMandateAuthority } from '../../src/runtime/automation/mandate-issuer';
import type { AutomationAdapters, ExecutionMandate, PlannedAssignment } from '../../src/runtime/automation/contracts';
import type { TestExecutor } from '../../src/runtime/automation/test-executor';

/*
 * A null cost in the audit trail has two quite different causes: a dispatch in
 * flight whose amount is not yet settled, and a dispatch aborted or failed
 * without reporting an amount. The runner cannot establish whether a ledger
 * exists or is settled. Terminal unknown amounts require reconciliation; the
 * label carries no amount and is not an assertion of accounting authority.
 */

const objective = 'Implement and verify a bounded RONOR feature.';
const workspace = 'C:/sandbox/ronor';
const branch = 'agent/mission-1';
const authorityKey = 'test-runner-authority-key-0123456789abcdef';
const testExecutor: TestExecutor = {
  run: () => ({ passed: true, claims: ['tests:pass'], artifact: { kind: 'test_report', sha256: 'f'.repeat(64), reference: 'run/test-report.json', bytes: 10 } }),
};

function mandate(missionId: string): ExecutionMandate {
  return signMandateAuthority({
    mandate_id: `mandate-${missionId}`,
    mission_id: missionId,
    issued_by: 'merlin',
    issued_by_key_id: 'key_0123456789ab',
    objective_hash: objectiveHash(objective),
    workspace_root: workspace,
    branch_prefix: 'agent/',
    allowed_actions: ['read_repo', 'create_branch', 'edit_worktree', 'run_tests', 'commit_local'],
    denied_actions: [...ALWAYS_DENIED_ACTIONS],
    max_cost_usd: 5,
    max_runtime_minutes: 60,
    max_fix_cycles: 3,
    issued_at: '2026-08-20T00:00:00.000Z',
    expires_at: '2099-08-21T00:00:00.000Z',
  }, authorityKey);
}

const assignment: PlannedAssignment = {
  id: 'task-cost-basis-1', instruction: 'Implement in worktree',
  actions: ['read_repo', 'edit_worktree', 'run_tests', 'commit_local'],
};

function adapters(
  execute: AutomationAdapters['openhands']['execute'],
  onVerify: () => void = () => undefined,
): AutomationAdapters {
  return {
    langgraph: { plan: async () => [assignment] },
    openhands: { execute },
    codex: {
      verify: async () => {
        onVerify();
        return { ok: true, verdict: 'pass', summary: 'independent checks pass', evidence: ['codex:pass'], cost_usd: 0.1 };
      },
    },
    assurance: { accept: async () => ({ ok: true, verdict: 'pass', summary: 'Victoria accepted', evidence: ['assurance:pass'], cost_usd: 0 }) },
  };
}

const projectedRun = (missionId: string, runId: string) => getMissionFabric(missionId)!.runs[runId];

describe('run status cost basis', () => {
  it('marks a dispatch in flight as pending and a known subtotal as the runner subtotal', async () => {
    const mission = createMission({ title: 'Cost basis, successful path', objective, operatorId: 'merlin' });
    const inFlight: Array<Record<string, unknown>> = [];
    const result = await executeMission({
      objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), testExecutor, authorityKey,
      adapters: adapters(
        async () => ({ ok: true, summary: 'implemented in sandbox', evidence: ['diff:abc', 'tests:pass'], cost_usd: 0.2 }),
        () => { inFlight.push(...Object.values(getMissionFabric(mission.mission_id)!.runs)); },
      ),
    });
    expect(result.status).toBe('complete');

    expect(inFlight).toHaveLength(1);
    expect(inFlight[0].cost_usd).toBeNull();
    expect(inFlight[0].cost_basis).toBe('unknown_pending_dispatch');

    const terminal = projectedRun(mission.mission_id, result.run_id);
    expect(typeof terminal.cost_usd).toBe('number');
    expect(terminal.cost_basis).toBe('runner_subtotal');
  });

  it('requires reconciliation of terminal unknown cost without claiming a ledger has settled', async () => {
    const mission = createMission({ title: 'Cost basis, aborted dispatch', objective, operatorId: 'merlin' });
    const result = await executeMission({
      objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), testExecutor, authorityKey,
      adapters: adapters(async () => { throw new Error('aborted without reporting an amount'); }),
    });
    expect(result.status).toBe('failed');
    expect(result.cost_usd).toBeNull();

    const terminal = projectedRun(mission.mission_id, result.run_id);
    expect(terminal.cost_usd).toBeNull();
    expect(terminal.cost_basis).toBe('unknown_reconciliation_required');
    expect(JSON.stringify(terminal.cost_basis)).not.toMatch(/[0-9]/);
  });

  it('does not claim ledger authority for a predispatch adapter configuration error', async () => {
    const mission = createMission({ title: 'Predispatch accounting', objective, operatorId: 'merlin' });
    const fetcher = jest.fn();
    const openhands = createOpenHandsAdapter({ baseUrl: 'https://bridge.invalid', fetcher });
    const result = await executeMission({
      objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), authorityKey,
      adapters: { ...adapters(jest.fn()), openhands },
    });
    expect(result).toMatchObject({ status: 'failed', reason: 'capability_key_required', cost_usd: null });
    expect(projectedRun(mission.mission_id, result.run_id).cost_basis).toBe('unknown_reconciliation_required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('blocks persisted unknown accounting before any new planning or dispatch', async () => {
    const mission = createMission({ title: 'Persisted unknown accounting', objective, operatorId: 'merlin' });
    const m = mandate(mission.mission_id);
    const runId = executionRunId(m.mandate_id);
    appendMissionFabricEvent({
      missionId: mission.mission_id, expectedVersion: getMissionFabric(mission.mission_id)!.version,
      type: 'run.status_changed', actor: { kind: 'openhands', id: 'openhands' },
      payload: { id: runId, run_id: runId, cost_usd: null, status: 'executing', cost_basis: 'unknown_pending_dispatch' },
    });
    const execute = jest.fn();
    const a = adapters(execute);
    a.langgraph.plan = jest.fn();
    const result = await executeMission({
      objective, workspaceRoot: workspace, branch, mandate: m, authorityKey, adapters: a,
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'cost_accounting_unknown', cost_usd: null });
    expect(projectedRun(mission.mission_id, runId).cost_basis).toBe('unknown_reconciliation_required');
    expect(a.langgraph.plan).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(verifyMissionFabric(mission.mission_id)?.valid).toBe(true);
  });

  it('keeps an explicitly known predispatch zero numeric', async () => {
    const mission = createMission({ title: 'Known predispatch zero', objective, operatorId: 'merlin' });
    const result = await executeMission({
      objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), authorityKey,
      adapters: adapters(async () => { throw new AutomationAdapterError('openhands_deadline_expired', 0); }),
    });
    expect(result.cost_usd).toBe(0);
    expect(projectedRun(mission.mission_id, result.run_id)).toMatchObject({ cost_usd: 0, cost_basis: 'runner_subtotal' });
  });
});
