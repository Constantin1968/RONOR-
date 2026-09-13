import { createMission, getMissionFabric } from '../../src/runtime/mission/store';
import { ALWAYS_DENIED_ACTIONS, objectiveHash } from '../../src/runtime/automation/policy';
import { runExecutiveMission as executeMission } from '../../src/runtime/automation/runner';
import { signMandateAuthority } from '../../src/runtime/automation/mandate-issuer';
import type { AutomationAdapters, ExecutionMandate, PlannedAssignment } from '../../src/runtime/automation/contracts';
import type { TestExecutor } from '../../src/runtime/automation/test-executor';

/*
 * A null cost in the audit trail has two quite different causes: a dispatch in
 * flight whose amount is not yet settled, and a dispatch aborted or failed
 * without reporting an amount, which the runner will never learn but the model
 * budget ledger has settled durably. These tests assert that the projected run
 * state names which of the two holds, and that the basis carries no amount.
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

  it('points a terminal unknown cost at the ledger rather than leaving a silent null', async () => {
    const mission = createMission({ title: 'Cost basis, aborted dispatch', objective, operatorId: 'merlin' });
    const result = await executeMission({
      objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), testExecutor, authorityKey,
      adapters: adapters(async () => { throw new Error('aborted without reporting an amount'); }),
    });
    expect(result.status).toBe('failed');
    expect(result.cost_usd).toBeNull();

    const terminal = projectedRun(mission.mission_id, result.run_id);
    expect(terminal.cost_usd).toBeNull();
    expect(terminal.cost_basis).toBe('unknown_ledger_authoritative');
    expect(JSON.stringify(terminal.cost_basis)).not.toMatch(/[0-9]/);
  });
});
