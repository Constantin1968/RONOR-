/**
 * R-Sentinel — Forecaster
 * MIP-013
 *
 * Ordinary least-squares linear regression over the most recent 60 samples of
 * a metric series (5 minutes at a 5-second cadence). The fitted slope is used
 * to project the time remaining until the YELLOW (70 %) and RED (95 %) bands,
 * and the coefficient of determination (R²), discounted by sample count, is
 * reported as forecast confidence.
 *
 * The model is deliberately simple and explainable: a governed runtime must be
 * able to state *why* it degraded itself, and a linear fit over a bounded
 * window is auditable by inspection.
 */

import { createLogger } from '../utils/logger';
import { SEVERITY_THRESHOLDS } from '../planes/r-sentinel/types';
import type {
  MetricTrend,
  ResourceForecast,
  ResourceKind,
  ResourceMetric,
} from '../planes/r-sentinel/types';

const logger = createLogger('Sentinel:Forecaster');

export const FORECAST_WINDOW = 60;
export const MIN_SAMPLES = 3;

/** Slope below this magnitude (percentage points/minute) is treated as flat. */
export const FLAT_SLOPE_EPSILON = 0.01;

export interface RegressionResult {
  /** Percentage points per minute. */
  slope: number;
  /** Utilisation at the window origin, in percent. */
  intercept: number;
  /** Coefficient of determination in [0, 1]. */
  r2: number;
  sampleCount: number;
  /** Minutes elapsed between the first and last sample. */
  spanMinutes: number;
}

function round(value: number, dp = 4): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function utilisationOf(metric: ResourceMetric): number {
  return metric.utilisationPercent ?? (metric.unit === 'percent' ? metric.value : 0);
}

/**
 * Ordinary least-squares fit of utilisation against elapsed minutes.
 * Returns null when fewer than MIN_SAMPLES points are available or the
 * samples share a single timestamp (zero variance in x).
 */
export function linearRegression(metrics: ResourceMetric[]): RegressionResult | null {
  const points = metrics.slice(-FORECAST_WINDOW);
  const n = points.length;
  if (n < MIN_SAMPLES) return null;

  const t0 = points[0].timestamp.getTime();
  const xs = points.map((m) => (m.timestamp.getTime() - t0) / 60_000); // minutes
  const ys = points.map(utilisationOf);

  const meanX = xs.reduce((s, v) => s + v, 0) / n;
  const meanY = ys.reduce((s, v) => s + v, 0) / n;

  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - meanX;
    sxx += dx * dx;
    sxy += dx * (ys[i] - meanY);
  }

  if (sxx === 0) return null; // all samples share one timestamp

  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let ssTot = 0;
  let ssRes = 0;
  for (let i = 0; i < n; i++) {
    const predicted = intercept + slope * xs[i];
    ssTot += (ys[i] - meanY) ** 2;
    ssRes += (ys[i] - predicted) ** 2;
  }
  // A perfectly flat series has zero total variance and is, trivially, a
  // perfect fit.
  const r2 = ssTot === 0 ? 1 : Math.max(0, Math.min(1, 1 - ssRes / ssTot));

  return {
    slope: round(slope),
    intercept: round(intercept),
    r2: round(r2),
    sampleCount: n,
    spanMinutes: round(xs[n - 1] - xs[0]),
  };
}

/** Classify the fitted slope into a trend label. */
export function classifyTrend(slope: number): MetricTrend {
  if (slope > FLAT_SLOPE_EPSILON) return 'rising';
  if (slope < -FLAT_SLOPE_EPSILON) return 'falling';
  return 'flat';
}

/**
 * Minutes until `target` percent is reached, given the current utilisation and
 * slope. Returns null when the target is already met or is unreachable on the
 * current trajectory.
 */
export function minutesTo(current: number, slope: number, target: number): number | null {
  if (current >= target) return 0;
  if (slope <= FLAT_SLOPE_EPSILON) return null;
  const minutes = (target - current) / slope;
  return Number.isFinite(minutes) && minutes >= 0 ? round(minutes, 2) : null;
}

/**
 * Confidence in [0, 1]: goodness of fit (R²) attenuated by how full the
 * 60-sample window is. A perfect fit over 6 samples is less trustworthy than
 * a perfect fit over 60.
 */
export function confidenceFor(r2: number, sampleCount: number): number {
  const sampleFactor = Math.min(1, sampleCount / FORECAST_WINDOW);
  return round(Math.max(0, Math.min(1, r2 * (0.5 + 0.5 * sampleFactor))), 3);
}

function recommendationFor(
  resource: ResourceKind,
  trend: MetricTrend,
  timeToRed: number | null,
  timeToYellow: number | null
): string {
  if (trend === 'falling') {
    return `${resource} is recovering — hold current posture and reverse any active degradation steps.`;
  }
  if (trend === 'flat') {
    return `${resource} is stable — no capacity action required.`;
  }
  if (timeToRed !== null && timeToRed <= 15) {
    return `${resource} projected to reach RED in ~${timeToRed} min — pre-authorise graceful degradation now.`;
  }
  if (timeToYellow !== null && timeToYellow <= 30) {
    return `${resource} projected to reach YELLOW in ~${timeToYellow} min — schedule capacity headroom or shed optional load.`;
  }
  return `${resource} rising slowly — continue monitoring at current cadence.`;
}

/** Build a forecast for one metric series. */
export function forecast(metrics: ResourceMetric[]): ResourceForecast | null {
  const points = metrics.slice(-FORECAST_WINDOW);
  if (points.length === 0) return null;

  const latest = points[points.length - 1];
  const resource: ResourceKind = latest.resource ?? 'ram';
  const current = round(utilisationOf(latest), 2);

  const fit = linearRegression(points);
  if (!fit) {
    return {
      resource,
      currentUtilisation: current,
      trend: 'flat',
      estimatedTimeToYellow: null,
      estimatedTimeToRed: null,
      recommendation: `Insufficient history for ${resource} — collecting baseline (${points.length}/${MIN_SAMPLES} samples minimum).`,
      confidence: 0,
      slopePercentPerMinute: 0,
      sampleCount: points.length,
    };
  }

  const trend = classifyTrend(fit.slope);
  const timeToYellow = minutesTo(current, fit.slope, SEVERITY_THRESHOLDS.YELLOW);
  const timeToRed = minutesTo(current, fit.slope, SEVERITY_THRESHOLDS.RED);

  return {
    resource,
    currentUtilisation: current,
    trend,
    estimatedTimeToYellow: timeToYellow,
    estimatedTimeToRed: timeToRed,
    recommendation: recommendationFor(resource, trend, timeToRed, timeToYellow),
    confidence: confidenceFor(fit.r2, fit.sampleCount),
    slopePercentPerMinute: fit.slope,
    sampleCount: fit.sampleCount,
  };
}

/**
 * Projected exhaustion (100 % utilisation) time for a rising series, or null
 * when exhaustion is not projected. Consumed by the alert engine.
 */
export function estimateExhaustion(metrics: ResourceMetric[]): Date | null {
  const points = metrics.slice(-FORECAST_WINDOW);
  if (points.length === 0) return null;
  const fit = linearRegression(points);
  if (!fit || fit.slope <= FLAT_SLOPE_EPSILON) return null;

  const latest = points[points.length - 1];
  const current = utilisationOf(latest);
  const minutes = minutesTo(current, fit.slope, 100);
  if (minutes === null) return null;

  return new Date(latest.timestamp.getTime() + minutes * 60_000);
}

/** Forecast every series in a name → samples map. */
export function forecastAll(seriesByName: Map<string, ResourceMetric[]>): ResourceForecast[] {
  const out: ResourceForecast[] = [];
  for (const [name, metrics] of seriesByName) {
    const result = forecast(metrics);
    if (result) out.push(result);
    else logger.debug(`No forecast produced for ${name}`);
  }
  return out;
}
