import crypto from 'node:crypto';
import { getDb } from '../../audit/hash-chain';
import { ensureRuntimeLedgerSchema } from '../ledgers/schema';
import type { AutomationRunStatus, ExecutionMandate } from './contracts';
import { verifyMandateAuthority } from './mandate-issuer';

export type RunClaimResult =
  | { outcome: 'acquired'; lease: AutomationRunLease; attempt: number; mandate: ExecutionMandate }
  | { outcome: 'resumed'; lease: AutomationRunLease; attempt: number; mandate: ExecutionMandate }
  | { outcome: 'completed'; mandate: ExecutionMandate }
  | { outcome: 'cancelled'; mandate: ExecutionMandate }
  | { outcome: 'busy' }
  | { outcome: 'conflict' }
  | { outcome: 'authority_invalid' }
  | { outcome: 'mandate_expired' }
  | { outcome: 'fix_cycle_limit_exceeded' };

export interface InterruptedAutomationRun {
  run_id: string;
  mission_id: string;
  mandate: ExecutionMandate;
  attempt_count: number;
}

export function mandateFingerprint(mandate: ExecutionMandate): string {
  const authority = {
    mandate_id: mandate.mandate_id, mission_id: mandate.mission_id,
    issued_by: mandate.issued_by, issued_by_key_id: mandate.issued_by_key_id,
    objective_hash: mandate.objective_hash, workspace_root: mandate.workspace_root,
    branch_prefix: mandate.branch_prefix, allowed_actions: [...mandate.allowed_actions].sort(),
    denied_actions: [...mandate.denied_actions].sort(), max_cost_usd: mandate.max_cost_usd,
    max_runtime_minutes: mandate.max_runtime_minutes, max_fix_cycles: mandate.max_fix_cycles,
    issued_at: mandate.issued_at, expires_at: mandate.expires_at,
  };
  return crypto.createHash('sha256').update(JSON.stringify(authority)).digest('hex');
}

export class AutomationRunLease {
  private timer?: NodeJS.Timeout;

  constructor(
    readonly runId: string,
    private readonly token: string,
    private readonly leaseMs: number,
  ) {}

  renew(now = new Date()): boolean {
    const expires = new Date(now.getTime() + this.leaseMs).toISOString();
    const result = getDb().prepare(
      `UPDATE runtime_automation_runs SET lease_expires_at = ?, updated_at = datetime('now')
       WHERE run_id = ? AND lease_token = ? AND status = 'running' AND cancel_requested_at IS NULL`,
    ).run(expires, this.runId, this.token);
    return result.changes === 1;
  }

  startHeartbeat(onOwnershipLost: () => void): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      try { if (!this.renew()) onOwnershipLost(); }
      catch { onOwnershipLost(); }
    }, Math.max(1_000, Math.floor(this.leaseMs / 3)));
    this.timer.unref();
  }

  finish(status: AutomationRunStatus): boolean {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const terminal = status === 'complete' ? 'complete' : 'failed';
    const result = getDb().prepare(
      `UPDATE runtime_automation_runs
       SET status = ?, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL,
           completed_at = CASE WHEN ? = 'complete' THEN datetime('now') ELSE completed_at END,
           updated_at = datetime('now')
       WHERE run_id = ? AND lease_token = ? AND status = 'running'`,
    ).run(terminal, terminal, this.runId, this.token);
    return result.changes === 1;
  }
}

export interface AutomationRunRecord {
  run_id: string;
  mission_id: string;
  status: 'running' | 'complete' | 'failed' | 'cancelled';
  attempt_count: number;
  cancellation_requested: boolean;
  lease_active: boolean;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export function getAutomationRunRecord(runId: string, missionId: string, now = new Date()): AutomationRunRecord | null {
  ensureRuntimeLedgerSchema();
  const row = getDb().prepare(
    `SELECT run_id, mission_id, status, attempt_count, cancel_requested_at, lease_expires_at,
            created_at, updated_at, completed_at
     FROM runtime_automation_runs WHERE run_id = ? AND mission_id = ?`,
  ).get(runId, missionId) as (Omit<AutomationRunRecord, 'cancellation_requested' | 'lease_active'> & {
    cancel_requested_at: string | null; lease_expires_at: string | null;
  }) | undefined;
  if (!row) return null;
  const { cancel_requested_at, lease_expires_at, ...safe } = row;
  return {
    ...safe,
    cancellation_requested: cancel_requested_at !== null,
    lease_active: safe.status === 'running' && lease_expires_at !== null && Date.parse(lease_expires_at) > now.getTime(),
  };
}

export function requestAutomationRunCancellation(runId: string, missionId: string):
  'cancelled' | 'not_found' | 'mission_mismatch' | 'not_active' {
  ensureRuntimeLedgerSchema();
  const db = getDb();
  return db.transaction(() => {
    const row = db.prepare(`SELECT mission_id, status FROM runtime_automation_runs WHERE run_id = ?`).get(runId) as
      | { mission_id: string; status: string } | undefined;
    if (!row) return 'not_found' as const;
    if (row.mission_id !== missionId) return 'mission_mismatch' as const;
    if (row.status !== 'running') return 'not_active' as const;
    const result = db.prepare(
      `UPDATE runtime_automation_runs
       SET status = 'cancelled', cancel_requested_at = datetime('now'), lease_token = NULL,
           lease_owner = NULL, lease_expires_at = NULL, updated_at = datetime('now')
       WHERE run_id = ? AND mission_id = ? AND status = 'running'`,
    ).run(runId, missionId);
    return result.changes === 1 ? 'cancelled' as const : 'not_active' as const;
  }).immediate();
}

/**
 * Return only interrupted runs that remain recoverable under their original
 * immutable mandate. This is an internal supervisor boundary; callers must
 * still acquire the lease atomically with claimAutomationRun before executing.
 */
export function interruptedAutomationRuns(authorityKey: string, now = new Date(), limit = 10): InterruptedAutomationRun[] {
  ensureRuntimeLedgerSchema();
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('automation_recovery_limit_invalid');
  const rows = getDb().prepare(
    `SELECT run_id, mission_id, mandate_fingerprint, mandate_json, attempt_count
     FROM runtime_automation_runs
     WHERE status = 'running' AND cancel_requested_at IS NULL
       AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
     ORDER BY updated_at ASC, run_id ASC LIMIT ?`,
  ).all(now.toISOString(), limit) as Array<{
    run_id: string; mission_id: string; mandate_fingerprint: string;
    mandate_json: string; attempt_count: number;
  }>;

  const recoverable: InterruptedAutomationRun[] = [];
  for (const row of rows) {
    try {
      const mandate = JSON.parse(row.mandate_json) as ExecutionMandate;
      if (!verifyMandateAuthority(mandate, authorityKey)) continue;
      if (mandateFingerprint(mandate) !== row.mandate_fingerprint) continue;
      if (mandate.mission_id !== row.mission_id) continue;
      if (!Number.isFinite(Date.parse(mandate.expires_at)) || Date.parse(mandate.expires_at) <= now.getTime()) continue;
      if (row.attempt_count >= mandate.max_fix_cycles + 1) continue;
      recoverable.push({ run_id: row.run_id, mission_id: row.mission_id, mandate, attempt_count: row.attempt_count });
    } catch { /* corrupted records fail closed and are never scheduled */ }
  }
  return recoverable;
}

export function claimAutomationRun(params: {
  runId: string;
  mandate: ExecutionMandate;
  owner: string;
  authorityKey: string;
  now?: Date;
  leaseMs?: number;
}): RunClaimResult {
  ensureRuntimeLedgerSchema();
  const db = getDb();
  const now = params.now ?? new Date();
  const leaseMs = params.leaseMs ?? 120_000;
  if (!Number.isFinite(leaseMs) || leaseMs < 3_000) throw new Error('automation_lease_duration_invalid');
  if (!verifyMandateAuthority(params.mandate, params.authorityKey)) return { outcome: 'authority_invalid' };
  const token = crypto.randomUUID();
  const fingerprint = mandateFingerprint(params.mandate);
  const leaseExpires = new Date(now.getTime() + leaseMs).toISOString();

  return db.transaction((): RunClaimResult => {
    const row = db.prepare(`SELECT * FROM runtime_automation_runs WHERE run_id = ? OR mandate_id = ?`).get(params.runId, params.mandate.mandate_id) as
      | { run_id: string; mandate_id: string; mandate_fingerprint: string; mandate_json: string; status: string; lease_expires_at: string | null; attempt_count: number }
      | undefined;
    if (!row) {
      db.prepare(
        `INSERT INTO runtime_automation_runs
         (run_id, mandate_id, mission_id, mandate_fingerprint, mandate_json, status, lease_token, lease_owner, lease_expires_at, attempt_count)
         VALUES (?,?,?,?,?, 'running', ?,?,?,1)`,
      ).run(params.runId, params.mandate.mandate_id, params.mandate.mission_id, fingerprint, JSON.stringify(params.mandate), token, params.owner, leaseExpires);
      return { outcome: 'acquired', lease: new AutomationRunLease(params.runId, token, leaseMs), attempt: 1, mandate: params.mandate };
    }
    if (row.run_id !== params.runId || row.mandate_id !== params.mandate.mandate_id) return { outcome: 'conflict' };
    let storedMandate: ExecutionMandate;
    try {
      storedMandate = JSON.parse(row.mandate_json) as ExecutionMandate;
      if (mandateFingerprint(storedMandate) !== row.mandate_fingerprint ||
          !verifyMandateAuthority(storedMandate, params.authorityKey)) return { outcome: 'authority_invalid' };
    } catch { return { outcome: 'conflict' }; }
    if (row.status === 'complete') return { outcome: 'completed', mandate: storedMandate };
    if (row.status === 'cancelled') return { outcome: 'cancelled', mandate: storedMandate };
    if (row.status === 'running' && row.lease_expires_at && Date.parse(row.lease_expires_at) > now.getTime()) return { outcome: 'busy' };
    if (!Number.isFinite(Date.parse(storedMandate.expires_at)) || Date.parse(storedMandate.expires_at) <= now.getTime()) return { outcome: 'mandate_expired' };
    if (row.attempt_count >= storedMandate.max_fix_cycles + 1) return { outcome: 'fix_cycle_limit_exceeded' };
    const attempt = row.attempt_count + 1;
    db.prepare(
      `UPDATE runtime_automation_runs SET status = 'running', lease_token = ?, lease_owner = ?,
       lease_expires_at = ?, attempt_count = ?, updated_at = datetime('now') WHERE run_id = ?`,
    ).run(token, params.owner, leaseExpires, attempt, params.runId);
    return { outcome: 'resumed', lease: new AutomationRunLease(params.runId, token, leaseMs), attempt, mandate: storedMandate };
  }).immediate();
}
