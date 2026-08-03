/**
 * RONOR Runtime — L1 · Telemetry Calibrator
 * ─────────────────────────────────────────
 * The 6D router is only as honest as its inputs. A router that scores latency
 * from a constant in a source file cannot notice that a provider has degraded,
 * and will keep sending traffic to it while an operator watches the dashboard
 * and wonders. This module is what makes the latency and reliability terms
 * OBSERVED rather than DECLARED.
 *
 * Design:
 *
 *   · An in-process ring of recent samples per model, bounded so memory is
 *     constant under sustained load. p50 is used rather than the mean because a
 *     single 40-second outlier should not permanently reprice a fast model.
 *   · A warm-up threshold. Below `MIN_SAMPLES` the seed latency from the
 *     catalogue is used, because a p50 over two samples is noise wearing the
 *     costume of a measurement.
 *   · Success rate over the same window, which feeds the reliability term. A
 *     provider that authenticates but returns malformed bodies scores down
 *     without an operator having to notice and intervene.
 *   · The ring is seeded from the Work Ledger on boot, so a restart does not
 *     discard everything the runtime learned. That read is best-effort: if the
 *     ledger is unavailable the calibrator simply starts cold, because routing
 *     must not depend on a database being reachable.
 *
 * Prepared by AMB.
 */

import { getCatalogueEntry } from './catalogue';

/** Samples retained per model. */
export const WINDOW_SIZE = 50;
/** Below this, the catalogue seed is used instead of the observed p50. */
export const MIN_SAMPLES = 3;

interface Sample {
  latencyMs: number;
  ok: boolean;
  at: number;
}

const windows = new Map<string, Sample[]>();

export function recordSample(modelId: string, latencyMs: number, ok: boolean): void {
  let ring = windows.get(modelId);
  if (!ring) {
    ring = [];
    windows.set(modelId, ring);
  }
  ring.push({ latencyMs: Math.max(0, Math.round(latencyMs)), ok, at: Date.now() });
  if (ring.length > WINDOW_SIZE) ring.shift();
}

export interface ModelTelemetry {
  modelId: string;
  samples: number;
  /** Observed p50 latency, or the catalogue seed while warming up. */
  latencyMs: number;
  /** True when `latencyMs` is measured rather than seeded. */
  latencyObserved: boolean;
  /** 0–1 over the window. 1 while no samples exist — absence is not evidence of failure. */
  successRate: number;
  lastSampleAt: string | null;
}

export function telemetryFor(modelId: string): ModelTelemetry {
  const ring = windows.get(modelId) ?? [];
  const entry = getCatalogueEntry(modelId);
  const seed = entry?.latency_seed_ms ?? 5000;

  if (ring.length < MIN_SAMPLES) {
    return {
      modelId,
      samples: ring.length,
      latencyMs: seed,
      latencyObserved: false,
      // A model with no failures recorded is not thereby proven reliable, but
      // penalising it for the absence of data would freeze out every new model.
      successRate: ring.length ? ring.filter((s) => s.ok).length / ring.length : 1,
      lastSampleAt: ring.length ? new Date(ring[ring.length - 1].at).toISOString() : null,
    };
  }

  // p50 over successful calls only. Including failures would let a fast 401
  // masquerade as excellent latency, which is precisely backwards.
  const successful = ring.filter((s) => s.ok).map((s) => s.latencyMs).sort((a, b) => a - b);
  const p50 = successful.length
    ? successful[Math.floor((successful.length - 1) / 2)]
    : seed;

  return {
    modelId,
    samples: ring.length,
    latencyMs: p50,
    latencyObserved: successful.length >= MIN_SAMPLES,
    successRate: ring.filter((s) => s.ok).length / ring.length,
    lastSampleAt: new Date(ring[ring.length - 1].at).toISOString(),
  };
}

export function allTelemetry(): ModelTelemetry[] {
  return [...windows.keys()].map(telemetryFor);
}

/** Test and operator affordance; also used by the rollback drill. */
export function resetCalibrator(): void {
  windows.clear();
}

/**
 * Seed the calibrator from persisted ledger rows.
 *
 * Best-effort by design: a routing layer that refuses to start because a
 * database is asleep is a worse outcome than a routing layer that starts cold.
 */
export function seedFromLedger(
  rows: Array<{ model_id: string; latency_ms: number; ok: boolean }>,
): number {
  let seeded = 0;
  for (const r of rows) {
    if (!r.model_id || typeof r.latency_ms !== 'number') continue;
    recordSample(r.model_id, r.latency_ms, r.ok);
    seeded++;
  }
  return seeded;
}
