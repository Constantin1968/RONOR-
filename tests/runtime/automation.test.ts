import { createMission, getMissionFabric } from '../../src/runtime/mission/store';
import { actionPermitted, ALWAYS_DENIED_ACTIONS, objectiveHash, validateMandate } from '../../src/runtime/automation/policy';
import { runExecutiveMission } from '../../src/runtime/automation/runner';
import type { AutomationAdapters, ExecutionMandate, PlannedAssignment } from '../../src/runtime/automation/contracts';
import type { TestExecutor } from '../../src/runtime/automation/test-executor';

const objective = 'Implement and verify a bounded RONOR feature.';
const workspace = 'C:/sandbox/ronor';
const branch = 'agent/mission-1';
const testExecutor: TestExecutor = { run: () => ({ passed: true, claims: ['tests:pass'], artifact: { kind: 'test_report', sha256: 'f'.repeat(64), reference: 'run/test-report.json', bytes: 10 } }) };

function mandate(missionId: string, overrides: Partial<ExecutionMandate> = {}): ExecutionMandate {
  return {
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
    expires_at: '2026-08-21T00:00:00.000Z',
    ...overrides,
  };
}

function adapters(assignments: PlannedAssignment[]): AutomationAdapters & { executeCount: () => number } {
  let executions = 0;
  return {
    executeCount: () => executions,
    langgraph: { plan: async () => assignments },
    openhands: {
      execute: async () => {
        executions += 1;
        return { ok: true, summary: 'implemented in sandbox', evidence: ['diff:abc', 'tests:pass'], cost_usd: 0.2 };
      },
    },
    codex: {
      verify: async () => ({ ok: true, verdict: 'pass', summary: 'independent checks pass', evidence: ['codex:pass'], cost_usd: 0.1 }),
    },
    assurance: {
      accept: async () => ({ ok: true, verdict: 'pass', summary: 'Victoria accepted', evidence: ['assurance:pass'], cost_usd: 0 }),
    },
  };
}

describe('Executive Mission Runner · mandate policy', () => {
  it('permits bounded development and denies every consequential action', () => {
    const m = mandate('msn-policy');
    expect(actionPermitted(m, 'edit_worktree')).toBe(true);
    for (const action of ALWAYS_DENIED_ACTIONS) expect(actionPermitted(m, action)).toBe(false);
  });

  it('binds objective, workspace, branch, issuer and expiry', () => {
    const m = mandate('msn-policy');
    const valid = validateMandate(m, { objective, workspaceRoot: workspace, branch, now: new Date('2026-08-20T12:00:00Z') });
    expect(valid.valid).toBe(true);
    expect(validateMandate(m, { objective: 'different', workspaceRoot: workspace, branch }).reason).toBe('objective_mismatch');
    expect(validateMandate(m, { objective, workspaceRoot: 'C:/other', branch }).reason).toBe('workspace_mismatch');
    expect(validateMandate(m, { objective, workspaceRoot: workspace, branch: 'main' }).reason).toBe('branch_outside_mandate');
    expect(validateMandate({ ...m, issued_by: 'merlin', expires_at: '2026-08-19T00:00:00Z' }, { objective, workspaceRoot: workspace, branch }).reason).toBe('mandate_expired_or_not_yet_valid');
  });

  it('refuses a mandate that attempts to allow deployment', () => {
    const m = mandate('msn-policy', { allowed_actions: ['read_repo', 'deploy'] });
    expect(validateMandate(m, { objective, workspaceRoot: workspace, branch }).reason).toBe('consequential_action_cannot_be_delegated');
  });
});

describe('Executive Mission Runner · governed execution', () => {
  it('runs LangGraph → OpenHands → Codex → Victoria without repeated approvals', async () => {
    const mission = createMission({ title: 'Automation', objective, operatorId: 'merlin' });
    const a = adapters([
      { id: 'task-automation-1', instruction: 'Implement in worktree', actions: ['read_repo', 'edit_worktree', 'run_tests', 'commit_local'] },
    ]);
    const result = await runExecutiveMission({
      objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), adapters: a, testExecutor,
    });
    expect(result.status).toBe('complete');
    expect(result.completed_assignments).toBe(1);
    expect(a.executeCount()).toBe(1);
    const fabric = getMissionFabric(mission.mission_id)!;
    expect(fabric.tasks['task-automation-1'].status).toBe('complete');
    expect(fabric.checkpoints.some((e) => e.payload.verdict === 'pass')).toBe(true);
    expect(fabric.runs[result.run_id].status).toBe('complete');
    expect(fabric.runs[result.run_id].stage).toBe('complete');
  });

  it('blocks push before OpenHands is invoked', async () => {
    const mission = createMission({ title: 'Denied automation', objective, operatorId: 'merlin' });
    const a = adapters([{ id: 'task-push', instruction: 'Push it', actions: ['push'] }]);
    const result = await runExecutiveMission({
      objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), adapters: a,
    });
    expect(result.status).toBe('blocked');
    expect(result.reason).toBe('action_outside_mandate:push');
    expect(a.executeCount()).toBe(0);
  });

  it('returns a completed mandate idempotently without adapter reinvocation', async () => {
    const mission = createMission({ title: 'No replay', objective, operatorId: 'merlin' });
    const m = mandate(mission.mission_id);
    const firstAdapters = adapters([{ id: 'task-once', instruction: 'Implement', actions: ['edit_worktree'] }]);
    expect((await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: m, adapters: firstAdapters })).status).toBe('complete');
    const replayAdapters = adapters([{ id: 'task-replay', instruction: 'Replay', actions: ['edit_worktree'] }]);
    const replay = await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: m, adapters: replayAdapters });
    expect(replay.status).toBe('complete');
    expect(replay.reason).toBeNull();
    expect(replayAdapters.executeCount()).toBe(0);
  });

  it('resumes a checkpointed plan without rerunning completed assignments', async () => {
    const mission = createMission({ title: 'Resume', objective, operatorId: 'merlin' });
    const m = mandate(mission.mission_id);
    const first = adapters([
      { id: 'resume-1', instruction: 'First', actions: ['edit_worktree'] },
      { id: 'resume-2', instruction: 'Second', actions: ['run_tests'] },
    ]);
    let calls = 0;
    first.openhands.execute = async () => {
      calls += 1;
      if (calls === 2) throw new Error('transient');
      return { ok: true, summary: 'done', evidence: ['first:done'], cost_usd: 0 };
    };
    expect((await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: m, adapters: first, testExecutor })).reason).toBe('openhands_failed');
    const resumed = adapters([{ id: 'different-plan', instruction: 'must not be used', actions: ['read_repo'] }]);
    const result = await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: m, adapters: resumed, testExecutor });
    expect(result.status).toBe('complete');
    expect(result.completed_assignments).toBe(2);
    expect(resumed.executeCount()).toBe(1);
  });

  it('stops when Codex fails and never asks Victoria to approve', async () => {
    const mission = createMission({ title: 'Failed verification', objective, operatorId: 'merlin' });
    const a = adapters([{ id: 'task-verify', instruction: 'Implement', actions: ['edit_worktree'] }]);
    let assuranceCalls = 0;
    a.codex.verify = async () => ({ ok: true, verdict: 'fail', summary: 'regression', evidence: ['tests:fail'], cost_usd: 0 });
    a.assurance.accept = async () => {
      assuranceCalls += 1;
      return { ok: true, verdict: 'pass', summary: 'should not run', evidence: [], cost_usd: 0 };
    };
    const result = await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), adapters: a });
    expect(result.status).toBe('failed');
    expect(result.reason).toBe('codex_verification_failed');
    expect(assuranceCalls).toBe(0);
  });

  it('creates an authoritative test report before Codex can verify', async () => {
    const mission = createMission({ title: 'Test evidence', objective, operatorId: 'merlin' });
    const a = adapters([{ id: 'task-tests', instruction: 'Run governed tests', actions: ['run_tests'] }]);
    let received: unknown;
    a.codex.verify = async (_missionId, evidence) => { received = evidence; return { ok: true, verdict: 'pass', summary: 'verified', evidence: [], cost_usd: 0 }; };
    const result = await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), adapters: a, testExecutor });
    expect(result.status).toBe('complete');
    expect(received).toEqual(expect.objectContaining({ claims: expect.arrayContaining(['tests:pass']), artifacts: expect.arrayContaining([expect.objectContaining({ kind: 'test_report' })]) }));
  });

  it('fails closed when a planned test has no authoritative executor', async () => {
    const mission = createMission({ title: 'Missing test authority', objective, operatorId: 'merlin' });
    const result = await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), adapters: adapters([{ id: 'task-tests-missing', instruction: 'Run tests', actions: ['run_tests'] }]) });
    expect(result.status).toBe('failed'); expect(result.reason).toBe('test_executor_not_configured');
  });

  it('passes actual OpenHands evidence to Codex instead of checkpoint hashes', async () => {
    const mission = createMission({ title: 'Evidence', objective, operatorId: 'merlin' });
    const a = adapters([{ id: 'task-evidence', instruction: 'Implement', actions: ['edit_worktree'] }]);
    a.openhands.execute = async () => ({
      ok: true, summary: 'implemented', evidence: ['tests:pass'], cost_usd: 0,
      artifacts: [{ kind: 'git_diff', sha256: 'a'.repeat(64), reference: 'run/task-evidence/diff.patch', bytes: 42 }],
    });
    let received: unknown = null;
    a.codex.verify = async (_missionId, evidence) => {
      received = evidence;
      return { ok: true, verdict: 'pass', summary: 'verified', evidence: ['codex:pass'], cost_usd: 0 };
    };
    const result = await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id), adapters: a });
    expect(result.status).toBe('complete');
    expect(received).toEqual({
      claims: ['tests:pass'],
      artifacts: [{ kind: 'git_diff', sha256: 'a'.repeat(64), reference: 'run/task-evidence/diff.patch', bytes: 42 }],
    });
    const fabric = getMissionFabric(mission.mission_id)!;
    expect(Object.values(fabric.evidence)).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'git_diff', digest: 'a'.repeat(64), reference: 'run/task-evidence/diff.patch' }),
    ]));
  });

  it('enforces the wall-clock deadline before invoking OpenHands', async () => {
    const mission = createMission({ title: 'Deadline', objective, operatorId: 'merlin' });
    const a = adapters([{ id: 'task-late', instruction: 'Implement', actions: ['edit_worktree'] }]);
    const ticks = [new Date('2026-08-20T00:00:00Z'), new Date('2026-08-20T00:00:00Z'), new Date('2026-08-20T00:02:00Z')];
    const result = await runExecutiveMission({
      objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id, { max_runtime_minutes: 1 }), adapters: a,
      now: () => ticks.shift() ?? new Date('2026-08-20T00:02:00Z'),
    });
    expect(result.reason).toBe('runtime_limit_exceeded');
    expect(a.executeCount()).toBe(0);
  });

  it('blocks assurance when Codex pushes total cost over budget', async () => {
    const mission = createMission({ title: 'Budget', objective, operatorId: 'merlin' });
    const a = adapters([{ id: 'task-budget', instruction: 'Implement', actions: ['edit_worktree'] }]);
    let assuranceCalls = 0;
    a.codex.verify = async () => ({ ok: true, verdict: 'pass', summary: 'verified', evidence: [], cost_usd: 1 });
    a.assurance.accept = async () => { assuranceCalls += 1; return { ok: true, verdict: 'pass', summary: 'accepted', evidence: [], cost_usd: 0 }; };
    const result = await runExecutiveMission({ objective, workspaceRoot: workspace, branch, mandate: mandate(mission.mission_id, { max_cost_usd: 0.5 }), adapters: a });
    expect(result.reason).toBe('cost_limit_exceeded');
    expect(assuranceCalls).toBe(0);
  });
});
