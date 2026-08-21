import crypto from 'node:crypto';
import { claimAutomationRun } from '../../src/runtime/automation/run-lease';
import { objectiveHash, ALWAYS_DENIED_ACTIONS } from '../../src/runtime/automation/policy';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';

function mandate(maxFixCycles = 2): ExecutionMandate {
  const id = crypto.randomUUID();
  return {
    mandate_id: `mandate_${id.replaceAll('-', '')}`, mission_id: `msn_${id}`,
    issued_by: 'merlin', issued_by_key_id: 'key_0123456789ab', objective_hash: objectiveHash('objective'),
    workspace_root: '/worktree', branch_prefix: 'agent/run', allowed_actions: ['read_repo'],
    denied_actions: [...ALWAYS_DENIED_ACTIONS], max_cost_usd: 1, max_runtime_minutes: 10,
    max_fix_cycles: maxFixCycles, issued_at: '2026-08-20T00:00:00Z', expires_at: '2026-08-21T00:00:00Z',
  };
}

describe('persistent automation run lease', () => {
  it('atomically excludes a concurrent owner and persists completion', () => {
    const m = mandate(); const runId = `run_${crypto.randomUUID()}`;
    const first = claimAutomationRun({ runId, mandate: m, owner: 'worker-a', now: new Date('2026-08-20T12:00:00Z'), leaseMs: 30_000 });
    expect(first.outcome).toBe('acquired');
    expect(claimAutomationRun({ runId, mandate: m, owner: 'worker-b', now: new Date('2026-08-20T12:00:01Z'), leaseMs: 30_000 }).outcome).toBe('busy');
    if (first.outcome !== 'acquired') throw new Error('claim failed');
    expect(first.lease.finish('complete')).toBe(true);
    const complete = claimAutomationRun({ runId, mandate: m, owner: 'worker-b', now: new Date('2026-08-20T12:00:02Z'), leaseMs: 30_000 });
    expect(complete.outcome).toBe('completed');
  });

  it('recovers an expired lease with the original immutable mandate', () => {
    const original = mandate(); const runId = `run_${crypto.randomUUID()}`;
    const first = claimAutomationRun({ runId, mandate: original, owner: 'crashed-worker', now: new Date('2026-08-20T12:00:00Z'), leaseMs: 3_000 });
    expect(first.outcome).toBe('acquired');
    const changedRetry = { ...original, branch_prefix: 'agent/expanded', expires_at: '2026-08-22T00:00:00Z' };
    const resumed = claimAutomationRun({ runId, mandate: changedRetry, owner: 'recovery-worker', now: new Date('2026-08-20T12:00:04Z'), leaseMs: 3_000 });
    expect(resumed.outcome).toBe('resumed');
    if (resumed.outcome !== 'resumed' || first.outcome !== 'acquired') throw new Error('resume failed');
    expect(resumed.mandate).toEqual(original);
    expect(first.lease.finish('complete')).toBe(false);
    expect(resumed.lease.finish('failed')).toBe(true);
  });

  it('enforces the configured fix-cycle ceiling', () => {
    const m = mandate(1); const runId = `run_${crypto.randomUUID()}`;
    const first = claimAutomationRun({ runId, mandate: m, owner: 'one', now: new Date('2026-08-20T12:00:00Z'), leaseMs: 3_000 });
    if (first.outcome !== 'acquired') throw new Error('claim failed');
    first.lease.finish('failed');
    const second = claimAutomationRun({ runId, mandate: m, owner: 'two', now: new Date('2026-08-20T12:00:01Z'), leaseMs: 3_000 });
    expect(second.outcome).toBe('resumed');
    if (second.outcome !== 'resumed') throw new Error('resume failed');
    second.lease.finish('failed');
    expect(claimAutomationRun({ runId, mandate: m, owner: 'three', now: new Date('2026-08-20T12:00:02Z'), leaseMs: 3_000 }).outcome).toBe('fix_cycle_limit_exceeded');
  });
});
