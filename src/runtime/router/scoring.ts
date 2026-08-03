/**
 * RONOR Runtime — L1 · 6D Router
 * ──────────────────────────────
 * Score = +Quality −Cost −Latency −OperationalRisk +Sovereignty +Evidence
 *
 * Six dimensions, normalised to 0–100 before weighting so that a dollar and a
 * millisecond are comparable, then weighted by governance parameters that are
 * visible and tunable rather than buried. The full table is returned on every
 * decision, because "the router chose X" is an assertion and "here is the score
 * of every candidate and every term that produced it" is evidence.
 *
 * What makes this the RUNTIME router rather than the demonstration router:
 *
 *   · LATENCY IS THE OBSERVED p50 from the calibrator, falling back to the
 *     catalogue seed only during warm-up. The score therefore tracks reality:
 *     a provider that slows down loses traffic without an operator intervening.
 *   · COST IS COMPUTED FROM PUBLISHED PER-MILLION RATES against the actual
 *     prompt size, not a fixed nominal request.
 *   · RELIABILITY MODULATES QUALITY. An engine returning malformed bodies at a
 *     20% rate is not a 92-quality engine in practice, and a router that ignored
 *     that would keep choosing it while the fallback chain silently paid for the
 *     retries.
 *
 * Prepared by AMB.
 */

import { telemetryFor, type ModelTelemetry } from './calibrator';
import type { CatalogueEntry } from './catalogue';
import { estimateRequestCost } from './policy';

/** Governance-visible term weights. */
export const RUNTIME_WEIGHTS = {
  quality: 1.0,
  cost: 0.8,
  latency: 0.5,
  operational_risk: 0.6,
  sovereignty: 0.7,
  evidence: 0.6,
} as const;

/** Normalisation ceilings. A request at or above these scores a full penalty. */
export const MAX_REASONABLE_COST_USD = 0.05;
export const MAX_REASONABLE_LATENCY_MS = 15_000;

export interface ScoreTerms {
  quality: number;
  cost: number;
  latency: number;
  operational_risk: number;
  sovereignty: number;
  evidence: number;
}

export interface ScoredCandidate {
  model_id: string;
  provider: string;
  display_name: string;
  vendor_model: string;
  estimated_cost_usd: number;
  observed_latency_ms: number;
  latency_observed: boolean;
  success_rate: number;
  samples: number;
  terms: ScoreTerms;
  weighted: ScoreTerms;
  total: number;
  pinned_by_policy?: string;
}

export function scoreCandidate(
  entry: CatalogueEntry,
  promptChars: number,
  telemetry: ModelTelemetry = telemetryFor(entry.id),
): ScoredCandidate {
  const estCost = estimateRequestCost(entry, promptChars);

  // Observed reliability discounts the declared quality. A perfect window leaves
  // quality untouched; a failing provider is scored as the engine it currently
  // is rather than the engine its datasheet describes.
  const effectiveQuality = entry.quality_score * telemetry.successRate;

  const terms: ScoreTerms = {
    quality: +effectiveQuality.toFixed(2),
    cost: +Math.min(100, (estCost / MAX_REASONABLE_COST_USD) * 100).toFixed(2),
    latency: +Math.min(100, (telemetry.latencyMs / MAX_REASONABLE_LATENCY_MS) * 100).toFixed(2),
    operational_risk: entry.operational_risk,
    sovereignty: +((entry.sovereignty_level / 3) * 100).toFixed(2),
    evidence: entry.evidence_reliability,
  };

  const weighted: ScoreTerms = {
    quality: +(RUNTIME_WEIGHTS.quality * terms.quality).toFixed(2),
    cost: +(-RUNTIME_WEIGHTS.cost * terms.cost).toFixed(2),
    latency: +(-RUNTIME_WEIGHTS.latency * terms.latency).toFixed(2),
    operational_risk: +(-RUNTIME_WEIGHTS.operational_risk * terms.operational_risk).toFixed(2),
    sovereignty: +(RUNTIME_WEIGHTS.sovereignty * terms.sovereignty).toFixed(2),
    evidence: +(RUNTIME_WEIGHTS.evidence * terms.evidence).toFixed(2),
  };

  const total = +Object.values(weighted)
    .reduce((a, b) => a + b, 0)
    .toFixed(2);

  return {
    model_id: entry.id,
    provider: entry.provider,
    display_name: entry.displayName,
    vendor_model: entry.vendorModel,
    estimated_cost_usd: estCost,
    observed_latency_ms: telemetry.latencyMs,
    latency_observed: telemetry.latencyObserved,
    success_rate: +telemetry.successRate.toFixed(4),
    samples: telemetry.samples,
    terms,
    weighted,
    total,
  };
}

/**
 * Rank the eligible set.
 *
 * Ties break on cost, then on latency, then on identifier. Deterministic tie
 * breaking matters more than it appears to: without it, two engines with equal
 * scores would alternate arbitrarily between requests and the audit chain would
 * record a routing decision no reviewer could reproduce.
 */
export function rankCandidates(
  eligible: CatalogueEntry[],
  promptChars: number,
  deterministicFirst: boolean,
): ScoredCandidate[] {
  const scored = eligible.map((e) => scoreCandidate(e, promptChars));

  scored.sort((a, b) => {
    if (b.total !== a.total) return b.total - a.total;
    if (a.estimated_cost_usd !== b.estimated_cost_usd) {
      return a.estimated_cost_usd - b.estimated_cost_usd;
    }
    if (a.observed_latency_ms !== b.observed_latency_ms) {
      return a.observed_latency_ms - b.observed_latency_ms;
    }
    return a.model_id.localeCompare(b.model_id);
  });

  if (deterministicFirst) {
    const idx = scored.findIndex((s) => s.provider === 'deterministic');
    if (idx > 0) {
      const [det] = scored.splice(idx, 1);
      det.pinned_by_policy = 'P3_DETERMINISTIC_FIRST';
      scored.unshift(det);
    } else if (idx === 0) {
      scored[0].pinned_by_policy = 'P3_DETERMINISTIC_FIRST';
    }
  }

  return scored;
}
