/**
 * RONOR Model Exchange v0.1 — Runtime Server
 * -------------------------------------------
 * Unified Request API + orchestration pipeline:
 *
 *   request → normalize → Policy Engine → Dynamic Router (score + rank)
 *           → Engine execution (with automatic fallback)
 *           → R-Assurance verification → Cost Ledger → Trace Ledger
 *           → structured response (decision transparency included)
 *
 * Endpoints:
 *   POST /api/query    — the Unified Request API
 *   GET  /api/registry — model registry + live scoring weights
 *   GET  /api/traces   — recent trace ledger entries
 *   GET  /api/costs    — cost ledger totals and breakdowns
 *
 * Run: OPENAI_API_KEY=sk-... node server/index.js   (Node 18+)
 */

import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { MODEL_REGISTRY, listModels } from "./registry.js";
import { applyPolicies } from "./policy.js";
import { rankModels, WEIGHTS } from "./router.js";
import { executeEngine } from "./engines.js";
import {
  recordTrace,
  listTraces,
  recordCost,
  computeCost,
  getCostLedger,
  assure,
} from "./ledger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TASK_TYPES = [
  "reasoning",
  "generation",
  "analysis",
  "summarization",
  "extraction",
  "calculation",
  "validation",
  "lookup",
];
const CONFIDENTIALITY_LEVELS = ["public", "internal", "confidential", "sovereign"];

function normalizeRequest(body) {
  const errors = [];

  const query = (body?.query ?? "").toString().trim();
  if (!query) errors.push("'query' is required.");
  if (query.length > 2000) errors.push("'query' exceeds 2000 characters.");

  const task_type = (body?.task_type ?? "reasoning").toString();
  if (!TASK_TYPES.includes(task_type))
    errors.push(`'task_type' must be one of: ${TASK_TYPES.join(", ")}.`);

  const confidentiality_level = (body?.confidentiality_level ?? "public").toString();
  if (!CONFIDENTIALITY_LEVELS.includes(confidentiality_level))
    errors.push(
      `'confidentiality_level' must be one of: ${CONFIDENTIALITY_LEVELS.join(", ")}.`,
    );

  const max_cost = body?.max_cost != null ? Number(body.max_cost) : null;
  if (max_cost != null && (!Number.isFinite(max_cost) || max_cost < 0))
    errors.push("'max_cost' must be a non-negative number (USD).");

  const max_latency = body?.max_latency != null ? Number(body.max_latency) : null;
  if (max_latency != null && (!Number.isFinite(max_latency) || max_latency < 0))
    errors.push("'max_latency' must be a non-negative number (ms).");

  const required_evidence_level =
    body?.required_evidence_level != null ? Number(body.required_evidence_level) : null;
  if (
    required_evidence_level != null &&
    (!Number.isFinite(required_evidence_level) ||
      required_evidence_level < 0 ||
      required_evidence_level > 100)
  )
    errors.push("'required_evidence_level' must be 0-100.");

  const allowed_providers = Array.isArray(body?.allowed_providers)
    ? body.allowed_providers.map(String)
    : [];

  return {
    request: {
      query,
      task_type,
      confidentiality_level,
      max_cost,
      max_latency,
      required_evidence_level,
      allowed_providers,
      requester: (body?.requester ?? "anonymous").toString(),
    },
    errors,
  };
}

async function handleQuery(req, res) {
  const startedAt = Date.now();
  const { request, errors } = normalizeRequest(req.body);

  if (errors.length > 0) {
    return res.status(400).json({ error: "Invalid request", details: errors });
  }

  // ---- 1. Policy Engine ---------------------------------------------------
  const policy = applyPolicies(request, MODEL_REGISTRY);

  if (policy.rejected) {
    const trace = recordTrace({
      requester: request.requester,
      query: request.query,
      task_type: request.task_type,
      constraints: {
        confidentiality_level: request.confidentiality_level,
        max_cost: request.max_cost,
        max_latency: request.max_latency,
        required_evidence_level: request.required_evidence_level,
        allowed_providers: request.allowed_providers,
      },
      policy_evaluations: policy.evaluations,
      outcome: "REJECTED_BY_POLICY",
      model_used: null,
      cost_usd: 0,
    });
    return res.status(422).json({
      status: "rejected",
      reason: policy.rejectionReason,
      policy_evaluations: policy.evaluations,
      trace_id: trace.trace_id,
    });
  }

  // ---- 2. Dynamic Router: score + rank ------------------------------------
  const ranking = rankModels(policy.eligible, request, policy.deterministicFirst);

  // ---- 3. Execute with automatic fallback ---------------------------------
  const attempts = [];
  let execution = null;
  let usedModel = null;

  for (const candidate of ranking) {
    const model = MODEL_REGISTRY.find((m) => m.id === candidate.model_id);
    const attempt = await executeEngine(model, request);
    attempts.push({
      model_id: model.id,
      ok: attempt.ok,
      error: attempt.ok ? null : attempt.error,
      latency_ms: attempt.latency_ms ?? null,
    });
    if (attempt.ok) {
      execution = attempt;
      usedModel = model;
      break;
    }
  }

  if (!execution) {
    const trace = recordTrace({
      requester: request.requester,
      query: request.query,
      task_type: request.task_type,
      constraints: {
        confidentiality_level: request.confidentiality_level,
        max_cost: request.max_cost,
        max_latency: request.max_latency,
        required_evidence_level: request.required_evidence_level,
        allowed_providers: request.allowed_providers,
      },
      policy_evaluations: policy.evaluations,
      routing_scores: ranking,
      attempts,
      outcome: "ALL_ENGINES_FAILED",
      model_used: null,
      cost_usd: 0,
    });
    return res.status(502).json({
      status: "failed",
      reason: "All eligible engines failed to execute the request.",
      attempts,
      routing: { scores: ranking, weights: WEIGHTS },
      trace_id: trace.trace_id,
    });
  }

  // ---- 4. R-Assurance ------------------------------------------------------
  const assurance = assure(usedModel, execution, request);

  // ---- 5. Cost Ledger -------------------------------------------------------
  const costUsd = recordCost(
    usedModel,
    request.task_type,
    execution.input_tokens ?? 0,
    execution.output_tokens ?? 0,
  );

  // ---- 6. Trace Ledger -------------------------------------------------------
  const trace = recordTrace({
    requester: request.requester,
    query: request.query,
    task_type: request.task_type,
    constraints: {
      confidentiality_level: request.confidentiality_level,
      max_cost: request.max_cost,
      max_latency: request.max_latency,
      required_evidence_level: request.required_evidence_level,
      allowed_providers: request.allowed_providers,
    },
    policy_evaluations: policy.evaluations,
    routing_scores: ranking,
    attempts,
    outcome: "OK",
    model_used: usedModel.id,
    simulated: execution.simulated,
    cost_usd: costUsd,
    verified_confidence: assurance.verified_confidence,
  });

  // ---- 7. Unified response ---------------------------------------------------
  return res.json({
    status: "ok",
    trace_id: trace.trace_id,
    answer: execution.answer,
    model: {
      id: usedModel.id,
      provider: usedModel.provider,
      display_name: usedModel.display_name,
      simulated: !!execution.simulated,
    },
    routing: {
      formula:
        "Score = +Quality −Cost −Latency −OperationalRisk +DataSovereignty +EvidenceReliability (normalized 0-100, weighted)",
      weights: WEIGHTS,
      scores: ranking,
      selected: usedModel.id,
      fallback_attempts: attempts,
      deterministic_first: policy.deterministicFirst,
    },
    policy: { evaluations: policy.evaluations },
    assurance,
    cost: {
      this_request_usd: costUsd,
      input_tokens: execution.input_tokens ?? 0,
      output_tokens: execution.output_tokens ?? 0,
      cost_per_1k_input: usedModel.cost_per_1k_input_tokens,
      cost_per_1k_output: usedModel.cost_per_1k_output_tokens,
      ledger_totals: getCostLedger(),
    },
    latency_ms: Date.now() - startedAt,
    engine_latency_ms: execution.latency_ms ?? null,
  });
}

// ---------------------------------------------------------------------------
async function startServer() {
  const app = express();
  app.use(express.json({ limit: "32kb" }));

  // Clean JSON error for malformed bodies
  app.use((err, _req, res, next) => {
    if (err?.type === "entity.parse.failed" || err instanceof SyntaxError) {
      return res.status(400).json({ error: "Invalid JSON body." });
    }
    return next(err);
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      status: "ok",
      service: "RONOR Model Exchange",
      version: "0.1.0",
      engines: {
        openai: process.env.OPENAI_API_KEY ? "live" : "unconfigured",
        anthropic: process.env.ANTHROPIC_API_KEY ? "live" : "simulated",
        deterministic_core: "live",
      },
      timestamp: new Date().toISOString(),
    });
  });

  app.post("/api/query", handleQuery);

  app.get("/api/registry", (_req, res) => {
    res.json({
      models: listModels().map((m) => ({
        ...m,
        available:
          m.engine === "openai"
            ? !!process.env.OPENAI_API_KEY
            : m.engine === "anthropic"
              ? true // simulated when key absent
              : true,
        live: m.engine === "anthropic" ? !!process.env.ANTHROPIC_API_KEY : true,
      })),
      weights: WEIGHTS,
    });
  });

  app.get("/api/traces", (req, res) => {
    const limit = Math.min(200, Number(req.query.limit) || 50);
    res.json({ traces: listTraces(limit) });
  });

  app.get("/api/costs", (_req, res) => {
    res.json(getCostLedger());
  });

  // Static dashboard (built frontend)
  const staticPath = path.resolve(__dirname, "..", "dist");
  app.use(express.static(staticPath));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(staticPath, "index.html"), (err) => {
      if (err) res.status(404).json({ error: "Dashboard not built. Run: npm run build" });
    });
  });

  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`RONOR Model Exchange v0.1 running on http://localhost:${port}/`);
    console.log(
      `Engines: OpenAI=${process.env.OPENAI_API_KEY ? "LIVE" : "MISSING KEY"} | Anthropic=${process.env.ANTHROPIC_API_KEY ? "LIVE" : "SIMULATED"} | DeterministicCore=LIVE`,
    );
  });
}

startServer().catch(console.error);
