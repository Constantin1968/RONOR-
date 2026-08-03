/**
 * RONOR Model Exchange — Work Ledger, Cost Ledger, R-Assurance
 * ────────────────────────────────────────────────────────────
 * WorkLedger  : Every request produces one entry recording who requested it,
 *               what engine executed it, what cost it incurred, what result
 *               was returned, and what verification passed. Persisted in the
 *               same SQLite database used by the audit hash-chain so operators
 *               can reconcile work-done ↔ evidence-recorded in one query.
 *
 * CostLedger  : Running economics per engine and per task type, in USD.
 *               Aggregated from work-ledger rows.
 *
 * R-Assurance : Verification layer applied after execution — confidence
 *               scoring + source attribution + consistency checks.
 *
 * Ported from RONOR Model Exchange v0.1 ledger.js. In v0.1 both ledgers were
 * in-memory; in the merged spine they persist to SQLite so audits survive
 * process restarts and can be exported for DNV / regulatory review.
 */

import type { ModelRegistryEntry } from "./registry";
import type { ExecutionResult, EngineSource } from "./engines";
import { getDb } from "../audit/hash-chain";

// ---------------------------------------------------------------------------
// Schema bootstrap
// ---------------------------------------------------------------------------
export function ensureWorkLedgerSchema(): void {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS work_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id TEXT,
      operator_id TEXT,
      task_type TEXT NOT NULL,
      chosen_model_id TEXT NOT NULL,
      status TEXT NOT NULL,           -- attempted | completed | rejected | escalated
      input_tokens INTEGER DEFAULT 0,
      output_tokens INTEGER DEFAULT 0,
      cost_usd REAL DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      simulated INTEGER DEFAULT 0,
      verified_confidence INTEGER,
      trace_hash TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_work_ledger_mission ON work_ledger(mission_id);
    CREATE INDEX IF NOT EXISTS idx_work_ledger_model ON work_ledger(chosen_model_id);
    CREATE INDEX IF NOT EXISTS idx_work_ledger_created ON work_ledger(created_at);
  `);
}

// ---------------------------------------------------------------------------
// Cost computation
// ---------------------------------------------------------------------------
export function computeCost(model: ModelRegistryEntry, inputTokens: number, outputTokens: number): number {
  const cost =
    (inputTokens / 1000) * model.cost_per_1k_input_tokens +
    (outputTokens / 1000) * model.cost_per_1k_output_tokens;
  return +cost.toFixed(6);
}

// ---------------------------------------------------------------------------
// Write a Work Ledger entry
// ---------------------------------------------------------------------------
export interface WorkLedgerEntry {
  mission_id?: string;
  operator_id?: string;
  task_type: string;
  chosen_model_id: string;
  status: "attempted" | "completed" | "rejected" | "escalated";
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  latency_ms: number;
  simulated: boolean;
  verified_confidence: number | null;
  trace_hash: string | null;
}

export function recordWork(entry: WorkLedgerEntry): number {
  const db = getDb();
  const stmt = db.prepare(`
    INSERT INTO work_ledger
      (mission_id, operator_id, task_type, chosen_model_id, status,
       input_tokens, output_tokens, cost_usd, latency_ms,
       simulated, verified_confidence, trace_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    entry.mission_id ?? null,
    entry.operator_id ?? null,
    entry.task_type,
    entry.chosen_model_id,
    entry.status,
    entry.input_tokens,
    entry.output_tokens,
    entry.cost_usd,
    entry.latency_ms,
    entry.simulated ? 1 : 0,
    entry.verified_confidence,
    entry.trace_hash,
  );
  return Number(result.lastInsertRowid);
}

// ---------------------------------------------------------------------------
// Cost Ledger — aggregated view
// ---------------------------------------------------------------------------
export interface CostLedgerSummary {
  total_requests: number;
  total_cost_usd: number;
  by_model: Record<string, { requests: number; input_tokens: number; output_tokens: number; cost_usd: number }>;
  by_task_type: Record<string, { requests: number; cost_usd: number }>;
}

export function getCostLedger(): CostLedgerSummary {
  const db = getDb();
  const totalsRow = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_usd), 0) AS total FROM work_ledger`)
    .get() as { n: number; total: number };

  const byModelRows = db
    .prepare(
      `SELECT chosen_model_id AS model_id,
              COUNT(*) AS requests,
              COALESCE(SUM(input_tokens), 0) AS input_tokens,
              COALESCE(SUM(output_tokens), 0) AS output_tokens,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM work_ledger GROUP BY chosen_model_id`,
    )
    .all() as Array<{ model_id: string; requests: number; input_tokens: number; output_tokens: number; cost_usd: number }>;

  const byTaskRows = db
    .prepare(
      `SELECT task_type,
              COUNT(*) AS requests,
              COALESCE(SUM(cost_usd), 0) AS cost_usd
         FROM work_ledger GROUP BY task_type`,
    )
    .all() as Array<{ task_type: string; requests: number; cost_usd: number }>;

  const by_model: CostLedgerSummary["by_model"] = {};
  for (const r of byModelRows) {
    by_model[r.model_id] = {
      requests: r.requests,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cost_usd: +Number(r.cost_usd).toFixed(6),
    };
  }
  const by_task_type: CostLedgerSummary["by_task_type"] = {};
  for (const r of byTaskRows) {
    by_task_type[r.task_type] = {
      requests: r.requests,
      cost_usd: +Number(r.cost_usd).toFixed(6),
    };
  }

  return {
    total_requests: totalsRow.n,
    total_cost_usd: +Number(totalsRow.total).toFixed(6),
    by_model,
    by_task_type,
  };
}

// ---------------------------------------------------------------------------
// R-Assurance — verification layer
// ---------------------------------------------------------------------------
export interface AssuranceCheck {
  check: string;
  result: string;
  passed: boolean;
}

export interface AssuranceReport {
  verified_confidence: number;
  evidence_reliability: number;
  checks: AssuranceCheck[];
  sources: EngineSource[];
}

export function assure(
  model: ModelRegistryEntry,
  execution: ExecutionResult,
): AssuranceReport {
  const checks: AssuranceCheck[] = [];

  const baseConfidence = execution.confidence ?? 0;
  checks.push({
    check: "A1_SELF_REPORTED_CONFIDENCE",
    result: `${baseConfidence}%`,
    passed: baseConfidence >= 30,
  });

  const hasSources = (execution.sources?.length ?? 0) > 0;
  checks.push({
    check: "A2_SOURCE_ATTRIBUTION",
    result: hasSources ? `${execution.sources?.length} sources attached` : "no sources attached",
    passed: hasSources,
  });

  const substantive = (execution.answer?.length ?? 0) >= 40;
  checks.push({
    check: "A3_SUBSTANTIVE_ANSWER",
    result: `${execution.answer?.length ?? 0} chars`,
    passed: substantive,
  });

  const deterministic = model.engine === "deterministic";
  checks.push({
    check: "A4_REPRODUCIBILITY",
    result: deterministic ? "bit-exact reproducible" : "probabilistic output",
    passed: deterministic,
  });

  checks.push({
    check: "A5_SIMULATION_DISCLOSURE",
    result: execution.simulated ? "SIMULATED response (flagged)" : "live execution",
    passed: true,
  });

  let verified = baseConfidence;
  if (!hasSources) verified -= 15;
  if (!substantive) verified -= 20;
  if (deterministic) verified = 100;
  if (execution.simulated) verified = Math.min(verified, 50);
  verified = Math.max(0, Math.min(100, Math.round(verified)));

  return {
    verified_confidence: verified,
    evidence_reliability: model.evidence_reliability,
    checks,
    sources: execution.sources ?? [],
  };
}
