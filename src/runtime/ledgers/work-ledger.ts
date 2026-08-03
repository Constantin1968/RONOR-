/**
 * RONOR Runtime — L7 · Work Ledger
 * ────────────────────────────────
 * Every governed request produces exactly one work row and one row per provider
 * attempt. The invariant that makes the ledger trustworthy is that it is written
 * on EVERY terminal path — completion, policy rejection, governance block,
 * exhausted fallback, unhandled error. A ledger that records only successes
 * measures optimism, not work.
 *
 * The prompt is never stored. A `prompt_digest` (SHA-256) is recorded instead,
 * which is enough to prove that two requests were identical, to detect replay,
 * and to correlate a complaint with a row, without turning the operational
 * database into an uncontrolled copy of everything anyone ever asked. For a
 * runtime that accepts material classified up to RESTRICTED, that distinction is
 * the difference between a ledger and a liability.
 *
 * Prepared by AMB.
 */

import crypto from 'crypto';
import { getDb } from '../../audit/hash-chain';
import { ensureRuntimeLedgerSchema } from './schema';

export type WorkSurface = 'query' | 'agent' | 'worker' | 'tool' | 'ingest';

export type WorkStatus =
  | 'completed'
  | 'completed-after-fallback'
  | 'rejected-policy'
  | 'rejected-governance'
  | 'all-providers-failed'
  | 'content-refused'
  | 'error';

export interface WorkRecord {
  request_id: string;
  mission_id?: string | null;
  operator_id?: string | null;
  api_key_id?: string | null;
  task_type: string;
  confidentiality: string;
  surface: WorkSurface;
  agent_id?: string | null;
  status: WorkStatus;
  chosen_model_id?: string | null;
  chosen_provider?: string | null;
  transport?: string | null;
  input_tokens: number;
  output_tokens: number;
  usage_estimated: boolean;
  cost_usd: number;
  latency_ms: number;
  attempts: number;
  fallback_used: boolean;
  verified_confidence?: number | null;
  citations_count: number;
  mi9_verdict?: string | null;
  trace_hash?: string | null;
  /** Raw prompt. Digested here and discarded — never persisted. */
  prompt?: string;
}

export interface AttemptRecord {
  request_id: string;
  attempt_no: number;
  model_id: string;
  provider: string;
  transport: string;
  ok: boolean;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  failure_kind?: string | null;
  failure_message?: string | null;
  fallback_reason?: string | null;
}

export function digestPrompt(prompt: string): string {
  return crypto.createHash('sha256').update(prompt, 'utf8').digest('hex');
}

export function recordWork(record: WorkRecord): number {
  ensureRuntimeLedgerSchema();
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO runtime_work
      (request_id, mission_id, operator_id, api_key_id, task_type, confidentiality,
       surface, agent_id, status, chosen_model_id, chosen_provider, transport,
       input_tokens, output_tokens, usage_estimated, cost_usd, latency_ms,
       attempts, fallback_used, verified_confidence, citations_count,
       mi9_verdict, trace_hash, prompt_digest)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(request_id) DO UPDATE SET
      status = excluded.status,
      chosen_model_id = excluded.chosen_model_id,
      chosen_provider = excluded.chosen_provider,
      transport = excluded.transport,
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      usage_estimated = excluded.usage_estimated,
      cost_usd = excluded.cost_usd,
      latency_ms = excluded.latency_ms,
      attempts = excluded.attempts,
      fallback_used = excluded.fallback_used,
      verified_confidence = excluded.verified_confidence,
      citations_count = excluded.citations_count,
      mi9_verdict = excluded.mi9_verdict,
      trace_hash = excluded.trace_hash
  `);
  const info = stmt.run(
    record.request_id,
    record.mission_id ?? null,
    record.operator_id ?? null,
    record.api_key_id ?? null,
    record.task_type,
    record.confidentiality,
    record.surface,
    record.agent_id ?? null,
    record.status,
    record.chosen_model_id ?? null,
    record.chosen_provider ?? null,
    record.transport ?? null,
    Math.max(0, Math.round(record.input_tokens)),
    Math.max(0, Math.round(record.output_tokens)),
    record.usage_estimated ? 1 : 0,
    record.cost_usd,
    Math.max(0, Math.round(record.latency_ms)),
    record.attempts,
    record.fallback_used ? 1 : 0,
    record.verified_confidence ?? null,
    record.citations_count,
    record.mi9_verdict ?? null,
    record.trace_hash ?? null,
    record.prompt ? digestPrompt(record.prompt) : null,
  );
  return Number(info.lastInsertRowid);
}

export function recordAttempts(attempts: AttemptRecord[]): number {
  if (attempts.length === 0) return 0;
  ensureRuntimeLedgerSchema();
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO runtime_attempts
      (request_id, attempt_no, model_id, provider, transport, ok, latency_ms,
       input_tokens, output_tokens, cost_usd, failure_kind, failure_message, fallback_reason)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
  `);
  // One transaction: a partially-written attempt list would misreport the
  // fallback depth of a request, which is exactly the number an operator uses to
  // judge provider health.
  const tx = db.transaction((rows: AttemptRecord[]) => {
    for (const a of rows) {
      stmt.run(
        a.request_id,
        a.attempt_no,
        a.model_id,
        a.provider,
        a.transport,
        a.ok ? 1 : 0,
        Math.max(0, Math.round(a.latency_ms)),
        Math.max(0, Math.round(a.input_tokens)),
        Math.max(0, Math.round(a.output_tokens)),
        a.cost_usd,
        a.failure_kind ?? null,
        a.failure_message ?? null,
        a.fallback_reason ?? null,
      );
    }
  });
  tx(attempts);
  return attempts.length;
}

// ---------------------------------------------------------------------------
// Read surfaces
// ---------------------------------------------------------------------------

export interface WorkRow {
  id: number;
  request_id: string;
  mission_id: string | null;
  operator_id: string | null;
  task_type: string;
  confidentiality: string;
  surface: string;
  agent_id: string | null;
  status: string;
  chosen_model_id: string | null;
  chosen_provider: string | null;
  transport: string | null;
  input_tokens: number;
  output_tokens: number;
  usage_estimated: number;
  cost_usd: number;
  latency_ms: number;
  attempts: number;
  fallback_used: number;
  verified_confidence: number | null;
  citations_count: number;
  mi9_verdict: string | null;
  trace_hash: string | null;
  created_at: string;
}

export function listWork(limit = 50, offset = 0): WorkRow[] {
  ensureRuntimeLedgerSchema();
  return getDb()
    .prepare(
      `SELECT id, request_id, mission_id, operator_id, task_type, confidentiality,
              surface, agent_id, status, chosen_model_id, chosen_provider, transport,
              input_tokens, output_tokens, usage_estimated, cost_usd, latency_ms,
              attempts, fallback_used, verified_confidence, citations_count,
              mi9_verdict, trace_hash, created_at
         FROM runtime_work ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(Math.min(500, Math.max(1, limit)), Math.max(0, offset)) as WorkRow[];
}

export function getWork(requestId: string): WorkRow | null {
  ensureRuntimeLedgerSchema();
  return (
    (getDb()
      .prepare(`SELECT * FROM runtime_work WHERE request_id = ?`)
      .get(requestId) as WorkRow | undefined) ?? null
  );
}

export function attemptsFor(requestId: string): Array<Record<string, unknown>> {
  ensureRuntimeLedgerSchema();
  return getDb()
    .prepare(`SELECT * FROM runtime_attempts WHERE request_id = ? ORDER BY attempt_no ASC`)
    .all(requestId) as Array<Record<string, unknown>>;
}

/**
 * Seed the router calibrator from persisted attempts.
 *
 * Read from `runtime_attempts` rather than `runtime_work`, because a request
 * that succeeded after two failures contains three latency facts and only the
 * attempts table holds all three. Seeding from work rows would teach the
 * calibrator that every provider is healthy.
 */
export function recentAttemptSamples(
  perModel = 50,
): Array<{ model_id: string; latency_ms: number; ok: boolean }> {
  ensureRuntimeLedgerSchema();
  const rows = getDb()
    .prepare(
      `SELECT model_id, latency_ms, ok FROM runtime_attempts
        ORDER BY id DESC LIMIT ?`,
    )
    .all(perModel * 20) as Array<{ model_id: string; latency_ms: number; ok: number }>;

  // Oldest-first so the calibrator's ring ends up holding the most recent
  // samples after the bounded window evicts the rest.
  return rows
    .reverse()
    .map((r) => ({ model_id: r.model_id, latency_ms: r.latency_ms, ok: r.ok === 1 }));
}
