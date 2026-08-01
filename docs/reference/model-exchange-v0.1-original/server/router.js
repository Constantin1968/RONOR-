/**
 * RONOR Model Exchange v0.1 — Dynamic Router
 * -------------------------------------------
 * The brain. For every eligible engine it computes:
 *
 *   Eligible Model Score =
 *       + Quality
 *       − Cost
 *       − Latency
 *       − Operational Risk
 *       + Data Sovereignty
 *       + Evidence Reliability
 *
 * All terms are normalized to a 0–100 scale before weighting, so the score
 * is comparable across engines. The router selects the highest-scoring
 * (i.e. lowest total-cost-of-intelligence) configuration that satisfies all
 * policy constraints, and returns the FULL scoring table so the decision is
 * transparent and auditable in the dashboard.
 */

import { estimateCost } from "./policy.js";

// Term weights — visible, tunable governance parameters.
export const WEIGHTS = {
  quality: 1.0,
  cost: 0.8,
  latency: 0.5,
  operational_risk: 0.6,
  sovereignty: 0.7,
  evidence: 0.6,
};

const MAX_REASONABLE_COST = 0.05; // USD/request → 100 penalty points at this cost
const MAX_REASONABLE_LATENCY = 8000; // ms → 100 penalty points at this latency

export function scoreModel(model, request) {
  const estCost = estimateCost(model, request);

  const terms = {
    quality: model.quality_score, // 0-100, higher better
    cost: Math.min(100, (estCost / MAX_REASONABLE_COST) * 100), // penalty
    latency: Math.min(100, (model.latency_avg_ms / MAX_REASONABLE_LATENCY) * 100), // penalty
    operational_risk: model.operational_risk, // 0-100 penalty
    sovereignty: (model.sovereignty_level / 3) * 100, // 0-100 bonus
    evidence: model.evidence_reliability, // 0-100 bonus
  };

  const weighted = {
    quality: +(WEIGHTS.quality * terms.quality).toFixed(2),
    cost: +(-WEIGHTS.cost * terms.cost).toFixed(2),
    latency: +(-WEIGHTS.latency * terms.latency).toFixed(2),
    operational_risk: +(-WEIGHTS.operational_risk * terms.operational_risk).toFixed(2),
    sovereignty: +(WEIGHTS.sovereignty * terms.sovereignty).toFixed(2),
    evidence: +(WEIGHTS.evidence * terms.evidence).toFixed(2),
  };

  const total = +Object.values(weighted)
    .reduce((a, b) => a + b, 0)
    .toFixed(2);

  return {
    model_id: model.id,
    display_name: model.display_name,
    provider: model.provider,
    status: model.status,
    estimated_cost_usd: +estCost.toFixed(6),
    terms,
    weighted,
    total,
  };
}

/**
 * Rank eligible engines. Deterministic-first policy (P3) pins the
 * deterministic engine to the top regardless of score, because for exact
 * tasks a probabilistic model is never the right first choice.
 */
export function rankModels(eligible, request, deterministicFirst) {
  const scored = eligible.map((m) => scoreModel(m, request));
  scored.sort((a, b) => b.total - a.total);

  if (deterministicFirst) {
    const idx = scored.findIndex((s) => s.model_id === "ronor/deterministic-core");
    if (idx > 0) {
      const [det] = scored.splice(idx, 1);
      det.pinned_by_policy = "P3_DETERMINISTIC_FIRST";
      scored.unshift(det);
    } else if (idx === 0) {
      scored[0].pinned_by_policy = "P3_DETERMINISTIC_FIRST";
    }
  }

  return scored;
}
