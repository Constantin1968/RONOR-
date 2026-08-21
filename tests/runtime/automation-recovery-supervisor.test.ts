import { startAutomationRecoverySupervisor } from '../../src/runtime/automation/recovery-supervisor';
import type { AutomationRunLease, InterruptedAutomationRun, RunClaimResult } from '../../src/runtime/automation/run-lease';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';

const mandate = { mandate_id: 'mandate_1', mission_id: 'mission_1' } as ExecutionMandate;
const candidate: InterruptedAutomationRun = { run_id: 'run_1', mission_id: 'mission_1', mandate, attempt_count: 1 };

function lease(): AutomationRunLease {
  return { startHeartbeat: jest.fn(), finish: jest.fn(() => true), renew: jest.fn(() => true), runId: 'run_1' } as unknown as AutomationRunLease;
}

describe('automation recovery supervisor', () => {
  it('is inert when disabled and never discovers work', async () => {
    const discover = jest.fn(() => [candidate]);
    const supervisor = startAutomationRecoverySupervisor({ enabled: false, owner: 'supervisor', discover, execute: jest.fn() });
    expect(await supervisor.sweepNow()).toBe(0);
    expect(discover).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({ enabled: false, state: 'disabled', active_runs: 0, leases_reclaimed_total: 0 });
    supervisor.stop();
    expect(supervisor.snapshot().state).toBe('stopped');
  });

  it('atomically reclaims and executes an interrupted run under the stored mandate', async () => {
    const recoveredLease = lease();
    const claim = jest.fn((): RunClaimResult => ({ outcome: 'resumed', lease: recoveredLease, attempt: 2, mandate }));
    const execute = jest.fn(async () => 'complete' as const);
    const supervisor = startAutomationRecoverySupervisor({
      enabled: true, owner: 'runtime-a', intervalMs: 60_000,
      discover: () => [candidate], claim, execute,
      now: () => new Date('2026-08-20T12:00:00Z'),
    });
    expect(await supervisor.sweepNow()).toBe(1);
    expect(claim).toHaveBeenCalledWith(candidate, 'runtime-a', new Date('2026-08-20T12:00:00Z'), 120_000);
    expect(execute).toHaveBeenCalledWith('run_1', mandate, expect.any(AbortSignal));
    expect(recoveredLease.startHeartbeat).toHaveBeenCalledTimes(1);
    expect(recoveredLease.finish).toHaveBeenCalledWith('complete');
    expect(supervisor.snapshot()).toMatchObject({
      state: 'idle', active_runs: 0, last_candidate_count: 1,
      leases_reclaimed_total: 1, completions_total: 1, failures_total: 0,
    });
    supervisor.stop();
  });

  it('does not execute when another replica wins the lease', async () => {
    const execute = jest.fn();
    const supervisor = startAutomationRecoverySupervisor({
      enabled: true, owner: 'runtime-b', intervalMs: 60_000,
      discover: () => [candidate], claim: () => ({ outcome: 'busy' }), execute,
    });
    expect(await supervisor.sweepNow()).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    supervisor.stop();
  });

  it('does not consume a lease while external preflight is unavailable', async () => {
    const claim = jest.fn(); const execute = jest.fn();
    const supervisor = startAutomationRecoverySupervisor({
      enabled: true, owner: 'runtime-preflight', intervalMs: 60_000,
      discover: () => [candidate], preflight: async () => false, claim, execute,
    });
    expect(await supervisor.sweepNow()).toBe(0);
    expect(claim).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(supervisor.snapshot().preflight_refusals_total).toBe(1);
    supervisor.stop();
  });

  it('aborts active recovery on shutdown and records failure', async () => {
    const recoveredLease = lease();
    let observedSignal: AbortSignal | undefined;
    const execute = jest.fn((_runId: string, _mandate: ExecutionMandate, signal: AbortSignal) => new Promise<'failed'>((resolve) => {
      observedSignal = signal;
      signal.addEventListener('abort', () => resolve('failed'), { once: true });
    }));
    const supervisor = startAutomationRecoverySupervisor({
      enabled: true, owner: 'runtime-c', intervalMs: 60_000, discover: () => [candidate],
      claim: () => ({ outcome: 'resumed', lease: recoveredLease, attempt: 2, mandate }), execute,
    });
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    supervisor.stop();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(observedSignal?.aborted).toBe(true);
    expect(recoveredLease.finish).toHaveBeenCalledWith('failed');
    expect(supervisor.snapshot()).toMatchObject({ state: 'stopped', active_runs: 0, failures_total: 1 });
  });

  it('refuses unsafe polling and batch limits', () => {
    expect(() => startAutomationRecoverySupervisor({ enabled: false, owner: 'x', intervalMs: 999, execute: jest.fn() })).toThrow('automation_recovery_interval_invalid');
    expect(() => startAutomationRecoverySupervisor({ enabled: false, owner: 'x', batchSize: 101, execute: jest.fn() })).toThrow('automation_recovery_batch_invalid');
  });
});
