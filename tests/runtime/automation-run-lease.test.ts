import crypto from 'node:crypto';
import { claimAutomationRun, getAutomationRunRecord, interruptedAutomationRuns, requestAutomationRunCancellation } from '../../src/runtime/automation/run-lease';
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

  it('never resumes work after the immutable mandate expires', () => {
    const m = mandate(); const runId = `run_${crypto.randomUUID()}`;
    const first = claimAutomationRun({ runId, mandate: m, owner: 'worker-a', now: new Date('2026-08-20T23:59:50Z'), leaseMs: 3_000 });
    expect(first.outcome).toBe('acquired');
    expect(claimAutomationRun({
      runId, mandate: { ...m, expires_at: '2026-08-22T00:00:00Z' }, owner: 'worker-b',
      now: new Date('2026-08-21T00:00:01Z'), leaseMs: 3_000,
    }).outcome).toBe('mandate_expired');
  });

  it('discovers only interrupted runs still inside the approved recovery envelope', () => {
    const valid = mandate(2); const validRun = `run_${crypto.randomUUID()}`;
    claimAutomationRun({ runId: validRun, mandate: valid, owner: 'crashed', now: new Date('2026-08-20T12:00:00Z'), leaseMs: 3_000 });

    const busy = mandate(2); const busyRun = `run_${crypto.randomUUID()}`;
    claimAutomationRun({ runId: busyRun, mandate: busy, owner: 'live', now: new Date('2026-08-20T12:00:03Z'), leaseMs: 30_000 });

    const expired = { ...mandate(2), expires_at: '2026-08-20T12:00:02Z' };
    const expiredRun = `run_${crypto.randomUUID()}`;
    claimAutomationRun({ runId: expiredRun, mandate: expired, owner: 'expired', now: new Date('2026-08-20T12:00:00Z'), leaseMs: 3_000 });

    const cancelled = mandate(2); const cancelledRun = `run_${crypto.randomUUID()}`;
    claimAutomationRun({ runId: cancelledRun, mandate: cancelled, owner: 'cancelled', now: new Date('2026-08-20T12:00:00Z'), leaseMs: 3_000 });
    requestAutomationRunCancellation(cancelledRun, cancelled.mission_id);

    expect(interruptedAutomationRuns(new Date('2026-08-20T12:00:04Z'), 10)).toEqual(expect.arrayContaining([
      expect.objectContaining({ run_id: validRun, mission_id: valid.mission_id, mandate: valid, attempt_count: 1 }),
    ]));
    const ids = interruptedAutomationRuns(new Date('2026-08-20T12:00:04Z'), 10).map((run) => run.run_id);
    expect(ids).not.toContain(busyRun);
    expect(ids).not.toContain(expiredRun);
    expect(ids).not.toContain(cancelledRun);
    expect(() => interruptedAutomationRuns(new Date(), 0)).toThrow('automation_recovery_limit_invalid');
  });

  it('persists cancellation, revokes the lease and refuses resurrection', () => {
    const m = mandate(); const runId = `run_${crypto.randomUUID()}`;
    const claimed = claimAutomationRun({ runId, mandate: m, owner: 'worker-a', now: new Date('2026-08-20T12:00:00Z'), leaseMs: 30_000 });
    expect(claimed.outcome).toBe('acquired');
    expect(requestAutomationRunCancellation(runId, 'wrong-mission')).toBe('mission_mismatch');
    expect(requestAutomationRunCancellation(runId, m.mission_id)).toBe('cancelled');
    expect(getAutomationRunRecord(runId, m.mission_id, new Date('2026-08-20T12:00:01Z'))).toMatchObject({
      status: 'cancelled', cancellation_requested: true, lease_active: false, attempt_count: 1,
    });
    if (claimed.outcome !== 'acquired') throw new Error('claim failed');
    expect(claimed.lease.renew(new Date('2026-08-20T12:00:02Z'))).toBe(false);
    expect(claimed.lease.finish('failed')).toBe(false);
    expect(claimAutomationRun({ runId, mandate: m, owner: 'worker-b', now: new Date('2026-08-20T12:01:00Z'), leaseMs: 3_000 }).outcome).toBe('cancelled');
  });

  it('returns only a safe status projection without lease owner, token or mandate JSON', () => {
    const m = mandate(); const runId = `run_${crypto.randomUUID()}`;
    claimAutomationRun({ runId, mandate: m, owner: 'sensitive-owner', now: new Date('2026-08-20T12:00:00Z'), leaseMs: 30_000 });
    const record = getAutomationRunRecord(runId, m.mission_id, new Date('2026-08-20T12:00:01Z'))!;
    expect(record).toMatchObject({ run_id: runId, mission_id: m.mission_id, status: 'running', lease_active: true });
    const serialised = JSON.stringify(record);
    expect(serialised).not.toContain('sensitive-owner');
    expect(serialised).not.toContain('lease_token');
    expect(serialised).not.toContain('mandate_json');
  });
});
