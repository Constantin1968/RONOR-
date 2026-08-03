/**
 * RONOR Model Exchange — Dynamic Router
 * ─────────────────────────────────────
 * For every eligible engine computes:
 *
 *   Eligible Model Score =
 *       + Quality
 *       − Cost
 *       − Latency
 *       − Operational Risk
 *       + Data Sovereignty
 *       + Evidence Reliability
 *
 * All terms are normalised to a 0–100 scale before weighting so scores are
 * comparable across engines. The router selects the highest-scoring
 * configuration that satisfies all policy constraints, and returns the FULL
 * scoring table so the decision is transparent and auditable.
 *
 * Ported from RONOR Model Exchange v0.1 router.js.
 */

import type { ModelRegistryEntry } from "./registry";
import { estimateCost, type UnifiedRequest } from "./policy";

// Term weights — visible, tunable governance parameters.
export const WEIGHTS = {
  quality: 1.0,
  cost: 0.8,
  latency: 0.5,
  operational_risk: 0.6,
  sovereignty: 0.7,
  evidence: 0.6,
} as const;

const MAX_REASONABLE_COST = 0.05;      // USD/request → 100 penalty points
const MAX_REASONABLE_LATENCY = 8000;   // ms → 100 penalty points

export interface ScoreTerms {
  quality: number;
  cost: number;
  latency: number;
  operational_risk: number;
  sovereignty: number;
  evidence: number;
}

export interface ScoredModel {
  model_id: string;
  display_name: string;
  provider: string;
  status: string;
  estimated_cost_usd: number;
  terms: ScoreTerms;
  weighted: ScoreTerms;
  total: number;
  pinned_by_policy?: string;
}

export function scoreModel(model: ModelRegistryEntry, request: UnifiedRequest): ScoredModel {
  const estCost = estimateCost(model, request);

  const terms: ScoreTerms = {
    quality: model.quality_score,
    cost: Math.min(100, (estCost / MAX_REASONABLE_COST) * 100),
    latency: Math.min(100, (model.latency_avg_ms / MAX_REASONABLE_LATENCY) * 100),
    operational_risk: model.operational_risk,
    sovereignty: (model.sovereignty_level / 3) * 100,
    evidence: model.evidence_reliability,
  };

  const weighted: ScoreTerms = {
    quality: +(WEIGHTS.quality * terms.quality).toFixed(2),
    cost: +(-WEIGHTS.cost * terms.cost).toFixed(2),
    latency: +(-WEIGHTS.latency * terms.latency).toFixed(2),
    operational_risk: +(-WEIGHTS.operational_risk * terms.operational_risk).toFixed(2),
    sovereignty: +(WEIGHTS.sovereignty * terms.sovereignty).toFixed(2),
    evidence: +(WEIGHTS.evidence * terms.evidence).toFixed(2),
  };

  const total = +Object.values(weighted).reduce((a, b) => a + b, 0).toFixed(2);

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
export function rankModels(
  eligible: ModelRegistryEntry[],
  request: UnifiedRequest,
  deterministicFirst: boolean,
): ScoredModel[] {
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
