/**
 * RONOR Model Exchange v0.1 — Trace Ledger, Cost Ledger, R-Assurance
 * -------------------------------------------------------------------
 * Trace Ledger : append-only audit log. Every request produces one immutable
 *                trace entry: who, what engine, what constraints, what cost,
 *                what result, what verification. Hash-chained for integrity.
 * Cost Ledger  : running economics per engine and per task type.
 * R-Assurance  : verification layer — confidence scoring + source attribution
 *                + consistency checks on engine output.
 *
 * v0.1 stores both ledgers in memory (reset on restart). The interface is
 * designed to swap in a durable store (SQLite/D1/Postgres) without changes.
 */

import { createHash, randomUUID } from "crypto";

// ---------------------------------------------------------------------------
// Trace Ledger
// ---------------------------------------------------------------------------
const traces = [];
let lastHash = "GENESIS";

export function recordTrace(entry) {
  const trace_id = `rnr-${randomUUID().slice(0, 13)}`;
  const timestamp = new Date().toISOString();
  const payload = { trace_id, timestamp, prev_hash: lastHash, ...entry };
  const hash = createHash("sha256")
    .update(JSON.stringify(payload))
    .digest("hex")
    .slice(0, 16);
  const record = { ...payload, hash };
  traces.push(record);
  lastHash = hash;
  if (traces.length > 500) traces.shift(); // bounded memory for v0.1
  return record;
}

export function listTraces(limit = 50) {
  return traces.slice(-limit).reverse();
}

// ---------------------------------------------------------------------------
// Cost Ledger
// ---------------------------------------------------------------------------
const costLedger = {
  total_requests: 0,
  total_cost_usd: 0,
  by_model: {}, // id → { requests, input_tokens, output_tokens, cost_usd }
  by_task_type: {}, // task_type → { requests, cost_usd }
};

export function computeCost(model, inputTokens, outputTokens) {
  const cost =
    (inputTokens / 1000) * model.cost_per_1k_input_tokens +
    (outputTokens / 1000) * model.cost_per_1k_output_tokens;
  return +cost.toFixed(6);
}

export function recordCost(model, taskType, inputTokens, outputTokens) {
  const cost = computeCost(model, inputTokens, outputTokens);

  costLedger.total_requests += 1;
  costLedger.total_cost_usd = +(costLedger.total_cost_usd + cost).toFixed(6);

  const m = (costLedger.by_model[model.id] ??= {
    requests: 0,
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: 0,
  });
  m.requests += 1;
  m.input_tokens += inputTokens;
  m.output_tokens += outputTokens;
  m.cost_usd = +(m.cost_usd + cost).toFixed(6);

  const t = (costLedger.by_task_type[taskType] ??= { requests: 0, cost_usd: 0 });
  t.requests += 1;
  t.cost_usd = +(t.cost_usd + cost).toFixed(6);

  return cost;
}

export function getCostLedger() {
  return costLedger;
}

// ---------------------------------------------------------------------------
// R-Assurance — verification layer
// ---------------------------------------------------------------------------
export function assure(model, execution, request) {
  const checks = [];

  // Check A1: engine self-reported confidence, calibrated by engine class
  const baseConfidence = execution.confidence ?? 0;
  checks.push({
    check: "A1_SELF_REPORTED_CONFIDENCE",
    result: `${baseConfidence}%`,
    passed: baseConfidence >= 30,
  });

  // Check A2: source attribution present
  const hasSources = (execution.sources?.length ?? 0) > 0;
  checks.push({
    check: "A2_SOURCE_ATTRIBUTION",
    result: hasSources
      ? `${execution.sources.length} sources attached`
      : "no sources attached",
    passed: hasSources,
  });

  // Check A3: answer non-empty and substantive
  const substantive = (execution.answer?.length ?? 0) >= 40;
  checks.push({
    check: "A3_SUBSTANTIVE_ANSWER",
    result: `${execution.answer?.length ?? 0} chars`,
    passed: substantive,
  });

  // Check A4: determinism bonus — reproducible engines get full assurance
  const deterministic = model.engine === "deterministic";
  checks.push({
    check: "A4_REPRODUCIBILITY",
    result: deterministic ? "bit-exact reproducible" : "probabilistic output",
    passed: deterministic,
  });

  // Check A5: simulation flag disclosure
  checks.push({
    check: "A5_SIMULATION_DISCLOSURE",
    result: execution.simulated ? "SIMULATED response (flagged)" : "live execution",
    passed: true, // disclosure itself always passes; the flag informs the score
  });

  // Composite verified-confidence score
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
