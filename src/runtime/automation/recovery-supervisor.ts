import type { AutomationRunStatus, ExecutionMandate } from './contracts';
import {
  claimAutomationRun,
  interruptedAutomationRuns,
  type InterruptedAutomationRun,
  type RunClaimResult,
} from './run-lease';

export interface AutomationRecoverySupervisor {
  sweepNow(): Promise<number>;
  stop(): void;
}

type RecoveryClaim = Extract<RunClaimResult, { outcome: 'resumed' }>;

/**
 * Recover only expired in-flight leases. A completed, failed, cancelled or
 * expired-mandate run is never selected. Lease acquisition remains the atomic
 * authority boundary, so multiple runtime replicas may sweep safely.
 */
export function startAutomationRecoverySupervisor(params: {
  enabled: boolean;
  owner: string;
  execute(runId: string, mandate: ExecutionMandate, signal: AbortSignal): Promise<AutomationRunStatus>;
  intervalMs?: number;
  leaseMs?: number;
  batchSize?: number;
  discover?: (now: Date, limit: number) => InterruptedAutomationRun[];
  claim?: (candidate: InterruptedAutomationRun, owner: string, now: Date, leaseMs: number) => RunClaimResult;
  now?: () => Date;
}): AutomationRecoverySupervisor {
  const intervalMs = params.intervalMs ?? 30_000;
  const leaseMs = params.leaseMs ?? 120_000;
  const batchSize = params.batchSize ?? 5;
  if (!Number.isFinite(intervalMs) || intervalMs < 1_000) throw new Error('automation_recovery_interval_invalid');
  if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > 100) throw new Error('automation_recovery_batch_invalid');

  const discover = params.discover ?? interruptedAutomationRuns;
  const claim = params.claim ?? ((candidate, owner, now, duration) => claimAutomationRun({
    runId: candidate.run_id, mandate: candidate.mandate, owner, now, leaseMs: duration,
  }));
  const active = new Map<string, AbortController>();
  let stopped = false;
  let sweep: Promise<number> | null = null;

  const recover = async (candidate: InterruptedAutomationRun): Promise<boolean> => {
    const now = (params.now ?? (() => new Date()))();
    const result = claim(candidate, params.owner, now, leaseMs);
    if (result.outcome !== 'resumed') return false;
    const recovered = result as RecoveryClaim;
    const controller = new AbortController();
    active.set(candidate.run_id, controller);
    recovered.lease.startHeartbeat(() => controller.abort());
    let status: AutomationRunStatus = 'failed';
    try { status = await params.execute(candidate.run_id, recovered.mandate, controller.signal); }
    catch { status = 'failed'; }
    finally {
      recovered.lease.finish(status);
      active.delete(candidate.run_id);
    }
    return true;
  };

  const sweepNow = (): Promise<number> => {
    if (!params.enabled || stopped) return Promise.resolve(0);
    if (sweep) return sweep;
    sweep = (async () => {
      const candidates = discover((params.now ?? (() => new Date()))(), batchSize);
      let recovered = 0;
      for (const candidate of candidates) {
        if (stopped) break;
        if (await recover(candidate)) recovered += 1;
      }
      return recovered;
    })().finally(() => { sweep = null; });
    return sweep;
  };

  const timer = params.enabled ? setInterval(() => { void sweepNow(); }, intervalMs) : null;
  timer?.unref();
  if (params.enabled) queueMicrotask(() => { void sweepNow(); });

  return {
    sweepNow,
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      for (const controller of active.values()) controller.abort();
    },
  };
}
