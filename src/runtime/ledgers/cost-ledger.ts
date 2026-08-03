/**
 * RONOR Runtime — L7 · Cost-of-Intelligence and Value Ledgers
 * ─────────────────────────────────────────────────────────
 * The Cost-of-Intelligence ledger answers the question a CFO actually asks:
 * not "what does the model cost per million tokens" but "what did this
 * organisation spend to obtain answers last week, on which engines, for which
 * missions, and how much of that spend bought nothing because a provider
 * failed".
 *
 * Three properties distinguish it from a naive token counter:
 *
 *   1. WASTED SPEND IS A FIRST-CLASS FIGURE. Tokens billed on a failed attempt
 *      are real money. Reporting only successful-request cost understates spend
 *      precisely when the runtime is unhealthy, which is when accurate numbers
 *      matter most.
 *   2. MEASURED AND INFERRED SPEND ARE SEPARATED. Some vendors omit usage; we
 *      estimate it. Presenting both in one total would make the number look more
 *      precise than it is.
 *   3. VALUE IS TRACKED AGAINST A COUNTERFACTUAL. The router's whole economic
 *      claim is that it obtains adequate answers for less than the premium
 *      engine would have cost. That claim is only auditable if the premium
 *      alternative's cost is recorded at decision time, so it is.
 *
 * Prepared by AMB.
 */

import { getDb } from '../../audit/hash-chain';
import { ensureRuntimeLedgerSchema } from './schema';

export interface CostByModel {
  model_id: string;
  provider: string;
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** Portion of `cost_usd` derived from estimated rather than reported usage. */
  estimated_cost_usd: number;
  avg_latency_ms: number;
  success_rate: number;
}

export interface CostSummary {
  generated_at: string;
  total_requests: number;
  total_cost_usd: number;
  /** Spend on attempts that did not produce an answer. */
  wasted_cost_usd: number;
  /** Share of total spend backed by vendor-reported token counts. */
  measured_cost_usd: number;
  estimated_cost_usd: number;
  total_input_tokens: number;
  total_output_tokens: number;
  avg_cost_per_request_usd: number;
  avg_latency_ms: number;
  fallback_rate: number;
  by_model: CostByModel[];
  by_provider: Array<{ provider: string; requests: number; cost_usd: number; success_rate: number }>;
  by_task_type: Array<{ task_type: string; requests: number; cost_usd: number }>;
  by_status: Array<{ status: string; requests: number }>;
}

export function getCostSummary(sinceIso?: string): CostSummary {
  ensureRuntimeLedgerSchema();
  const db = getDb();
  const where = sinceIso ? `WHERE created_at >= ?` : '';
  const params = sinceIso ? [sinceIso] : [];

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS requests,
              COALESCE(SUM(cost_usd),0) AS cost,
              COALESCE(SUM(input_tokens),0) AS input_tokens,
              COALESCE(SUM(output_tokens),0) AS output_tokens,
              COALESCE(AVG(latency_ms),0) AS avg_latency,
              COALESCE(SUM(fallback_used),0) AS fallbacks,
              COALESCE(SUM(CASE WHEN usage_estimated = 1 THEN cost_usd ELSE 0 END),0) AS est_cost
         FROM runtime_work ${where}`,
    )
    .get(...params) as {
    requests: number;
    cost: number;
    input_tokens: number;
    output_tokens: number;
    avg_latency: number;
    fallbacks: number;
    est_cost: number;
  };

  // Wasted spend comes from the ATTEMPTS table, because a failed attempt has no
  // work row of its own — it is subsumed into the request that eventually
  // succeeded, and its cost would otherwise be invisible.
  const attWhere = sinceIso ? `WHERE created_at >= ? AND ok = 0` : `WHERE ok = 0`;
  const wasted = db
    .prepare(`SELECT COALESCE(SUM(cost_usd),0) AS wasted FROM runtime_attempts ${attWhere}`)
    .get(...params) as { wasted: number };

  const byModelRows = db
    .prepare(
      `SELECT a.model_id AS model_id,
              a.provider AS provider,
              COUNT(*) AS requests,
              COALESCE(SUM(a.input_tokens),0) AS input_tokens,
              COALESCE(SUM(a.output_tokens),0) AS output_tokens,
              COALESCE(SUM(a.cost_usd),0) AS cost_usd,
              COALESCE(AVG(a.latency_ms),0) AS avg_latency_ms,
              COALESCE(AVG(a.ok),0) AS success_rate
         FROM runtime_attempts a
         ${sinceIso ? 'WHERE a.created_at >= ?' : ''}
         GROUP BY a.model_id, a.provider
         ORDER BY cost_usd DESC`,
    )
    .all(...params) as Array<CostByModel & { success_rate: number }>;

  const estimatedByModel = db
    .prepare(
      `SELECT chosen_model_id AS model_id,
              COALESCE(SUM(CASE WHEN usage_estimated = 1 THEN cost_usd ELSE 0 END),0) AS est
         FROM runtime_work ${where} GROUP BY chosen_model_id`,
    )
    .all(...params) as Array<{ model_id: string | null; est: number }>;
  const estMap = new Map(estimatedByModel.map((r) => [r.model_id ?? '', r.est]));

  const byProvider = db
    .prepare(
      `SELECT provider,
              COUNT(*) AS requests,
              COALESCE(SUM(cost_usd),0) AS cost_usd,
              COALESCE(AVG(ok),0) AS success_rate
         FROM runtime_attempts ${sinceIso ? 'WHERE created_at >= ?' : ''}
         GROUP BY provider ORDER BY cost_usd DESC`,
    )
    .all(...params) as Array<{ provider: string; requests: number; cost_usd: number; success_rate: number }>;

  const byTask = db
    .prepare(
      `SELECT task_type, COUNT(*) AS requests, COALESCE(SUM(cost_usd),0) AS cost_usd
         FROM runtime_work ${where} GROUP BY task_type ORDER BY cost_usd DESC`,
    )
    .all(...params) as Array<{ task_type: string; requests: number; cost_usd: number }>;

  const byStatus = db
    .prepare(
      `SELECT status, COUNT(*) AS requests FROM runtime_work ${where}
        GROUP BY status ORDER BY requests DESC`,
    )
    .all(...params) as Array<{ status: string; requests: number }>;

  const round = (n: number, dp = 8) => +Number(n).toFixed(dp);

  return {
    generated_at: new Date().toISOString(),
    total_requests: totals.requests,
    total_cost_usd: round(totals.cost),
    wasted_cost_usd: round(wasted.wasted),
    measured_cost_usd: round(totals.cost - totals.est_cost),
    estimated_cost_usd: round(totals.est_cost),
    total_input_tokens: totals.input_tokens,
    total_output_tokens: totals.output_tokens,
    avg_cost_per_request_usd: totals.requests ? round(totals.cost / totals.requests) : 0,
    avg_latency_ms: Math.round(totals.avg_latency),
    fallback_rate: totals.requests ? +(totals.fallbacks / totals.requests).toFixed(4) : 0,
    by_model: byModelRows.map((r) => ({
      model_id: r.model_id,
      provider: r.provider,
      requests: r.requests,
      input_tokens: r.input_tokens,
      output_tokens: r.output_tokens,
      cost_usd: round(r.cost_usd),
      estimated_cost_usd: round(estMap.get(r.model_id) ?? 0),
      avg_latency_ms: Math.round(r.avg_latency_ms),
      success_rate: +Number(r.success_rate).toFixed(4),
    })),
    by_provider: byProvider.map((r) => ({
      provider: r.provider,
      requests: r.requests,
      cost_usd: round(r.cost_usd),
      success_rate: +Number(r.success_rate).toFixed(4),
    })),
    by_task_type: byTask.map((r) => ({ ...r, cost_usd: round(r.cost_usd) })),
    by_status: byStatus,
  };
}

// ---------------------------------------------------------------------------
// Value ledger
// ---------------------------------------------------------------------------

export interface ValueRecord {
  request_id: string;
  mission_id?: string | null;
  cost_usd: number;
  /** What the highest-quality eligible engine would have cost for this request. */
  premium_cost_usd: number;
  /** Score-point gap between the chosen engine and the premium alternative. */
  quality_delta: number;
  verified_confidence?: number | null;
  declared_value_usd?: number | null;
  value_unit?: string | null;
}

export function recordValue(record: ValueRecord): number {
  ensureRuntimeLedgerSchema();
  const avoided = +(record.premium_cost_usd - record.cost_usd).toFixed(8);
  const info = getDb()
    .prepare(
      `INSERT INTO runtime_value
         (request_id, mission_id, cost_usd, premium_cost_usd, cost_avoided_usd,
          quality_delta, verified_confidence, declared_value_usd, value_unit)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .run(
      record.request_id,
      record.mission_id ?? null,
      record.cost_usd,
      record.premium_cost_usd,
      avoided,
      record.quality_delta,
      record.verified_confidence ?? null,
      record.declared_value_usd ?? null,
      record.value_unit ?? null,
    );
  return Number(info.lastInsertRowid);
}

export interface ValueSummary {
  generated_at: string;
  requests_valued: number;
  total_cost_usd: number;
  total_premium_cost_usd: number;
  /** Positive: the router bought adequate answers for less than the premium path. */
  total_cost_avoided_usd: number;
  /**
   * Negative on average when routing traded quality for price. Reported plainly
   * because a saving that degraded every answer is not a saving an operator
   * would have authorised had they been shown the trade.
   */
  avg_quality_delta: number;
  avg_verified_confidence: number | null;
  declared_value_usd: number;
  /** Declared value divided by spend. Null until an operator declares a value. */
  value_multiple: number | null;
}

export function getValueSummary(): ValueSummary {
  ensureRuntimeLedgerSchema();
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(cost_usd),0) AS cost,
              COALESCE(SUM(premium_cost_usd),0) AS premium,
              COALESCE(SUM(cost_avoided_usd),0) AS avoided,
              AVG(quality_delta) AS q,
              AVG(verified_confidence) AS conf,
              COALESCE(SUM(declared_value_usd),0) AS declared
         FROM runtime_value`,
    )
    .get() as {
    n: number;
    cost: number;
    premium: number;
    avoided: number;
    q: number | null;
    conf: number | null;
    declared: number;
  };

  return {
    generated_at: new Date().toISOString(),
    requests_valued: row.n,
    total_cost_usd: +row.cost.toFixed(8),
    total_premium_cost_usd: +row.premium.toFixed(8),
    total_cost_avoided_usd: +row.avoided.toFixed(8),
    avg_quality_delta: row.q === null ? 0 : +row.q.toFixed(2),
    avg_verified_confidence: row.conf === null ? null : Math.round(row.conf),
    declared_value_usd: +row.declared.toFixed(2),
    value_multiple: row.cost > 0 && row.declared > 0 ? +(row.declared / row.cost).toFixed(2) : null,
  };
}
