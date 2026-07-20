/**
 * RONOR Model Exchange — HTTP Routes
 * ──────────────────────────────────
 * Exposes the Model Exchange × Governance Spine pipeline over HTTP:
 *
 *   GET  /registry            → list all known models with capabilities and economics
 *   POST /route               → dry-run: policy filter + router scoring, no execution
 *   POST /query               → full pipeline: policy → router → MI9 → execute → assure → audit → work-ledger
 *   GET  /ledger/cost         → aggregated Cost Ledger view
 */

import { Router } from "express";
import { listModels } from "../model-exchange/registry.js";
import type { UnifiedRequest } from "../model-exchange/policy.js";
import { runUnifiedQuery } from "../model-exchange/orchestrator.js";
import { getCostLedger } from "../model-exchange/work-ledger.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger("API:ModelExchange");

export const modelExchangeRouter = Router();

// ---------------------------------------------------------------------------
// GET /registry
// ---------------------------------------------------------------------------
modelExchangeRouter.get("/registry", (_req, res) => {
  res.json({
    ok: true,
    models: listModels(),
    generated_at: new Date().toISOString(),
  });
});

// ---------------------------------------------------------------------------
// POST /route  — dry-run scoring only
// ---------------------------------------------------------------------------
modelExchangeRouter.post("/route", async (req, res) => {
  try {
    const request = coerceRequest(req.body);
    if (!request) return res.status(400).json({ ok: false, error: "invalid_request" });

    const result = await runUnifiedQuery(request, { dryRun: true });
    res.json({ ok: true, ...result });
  } catch (err) {
    logger.error("route failed", { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "route_failed" });
  }
});

// ---------------------------------------------------------------------------
// POST /query  — full pipeline
// ---------------------------------------------------------------------------
modelExchangeRouter.post("/query", async (req, res) => {
  try {
    const request = coerceRequest(req.body);
    if (!request) return res.status(400).json({ ok: false, error: "invalid_request" });

    const result = await runUnifiedQuery(request);
    const httpStatus =
      result.status === "completed" || result.status === "escalated"
        ? 200
        : result.status === "rejected-policy"
          ? 400
          : result.status === "rejected-governance"
            ? 403
            : 500;
    res.status(httpStatus).json({ ok: !result.rejected, ...result });
  } catch (err) {
    logger.error("query failed", { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "query_failed" });
  }
});

// ---------------------------------------------------------------------------
// GET /ledger/cost
// ---------------------------------------------------------------------------
modelExchangeRouter.get("/ledger/cost", (_req, res) => {
  try {
    const summary = getCostLedger();
    res.json({ ok: true, ...summary, generated_at: new Date().toISOString() });
  } catch (err) {
    logger.error("ledger/cost failed", { err: err instanceof Error ? err.message : String(err) });
    res.status(500).json({ ok: false, error: "ledger_read_failed" });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function coerceRequest(body: unknown): UnifiedRequest | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  if (typeof b.query !== "string" || !b.query.trim()) return null;
  const task_type = typeof b.task_type === "string" ? b.task_type : "reasoning";
  const confidentiality_level =
    typeof b.confidentiality_level === "string" ? b.confidentiality_level : "internal";

  return {
    query: b.query,
    task_type: task_type as UnifiedRequest["task_type"],
    confidentiality_level: confidentiality_level as UnifiedRequest["confidentiality_level"],
    allowed_providers: Array.isArray(b.allowed_providers) ? (b.allowed_providers as string[]) : undefined,
    max_latency: typeof b.max_latency === "number" ? b.max_latency : undefined,
    max_cost: typeof b.max_cost === "number" ? b.max_cost : undefined,
    required_evidence_level:
      typeof b.required_evidence_level === "number" ? b.required_evidence_level : undefined,
    jurisdiction_pin: b.jurisdiction_pin as UnifiedRequest["jurisdiction_pin"],
    operator_id: typeof b.operator_id === "string" ? b.operator_id : undefined,
    mission_id: typeof b.mission_id === "string" ? b.mission_id : undefined,
  };
}
