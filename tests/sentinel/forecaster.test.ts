/**
 * R-Sentinel — Forecaster Tests (MIP-013)
 *
 * Verifies OLS regression accuracy on synthetic series, trend classification,
 * time-to-threshold projection, confidence scoring, and the 60-sample window
 * bound. Also exercises the plane's public read model end-to-end.
 */

import {
  FLAT_SLOPE_EPSILON,
  FORECAST_WINDOW,
  MIN_SAMPLES,
  classifyTrend,
  confidenceFor,
  estimateExhaustion,
  forecast,
  forecastAll,
  linearRegression,
  minutesTo,
} from '../../src/sentinel/forecaster';
import { RSentinelPlane } from '../../src/planes/r-sentinel';
import type { ResourceMetric } from '../../src/planes/r-sentinel/types';

const T0 = 1_700_000_000_000;
const STEP_MS = 5_000; // 5-second cadence → 12 samples per minute

/** Build a series where utilisation = start + slopePerMinute × elapsedMinutes. */
function series(start: number, slopePerMinute: number, count: number): ResourceMetric[] {
  return Array.from({ length: count }, (_, i) => {
    const minutes = (i * STEP_MS) / 60_000;
    const value = start + slopePerMinute * minutes;
    return {
      name: 'ram.utilisation',
      value,
      unit: 'percent',
      timestamp: new Date(T0 + i * STEP_MS),
      resource: 'ram' as const,
      utilisationPercent: value,
      capacity: 100,
      collector: 'system' as const,
      available: true,
    };
  });
}

describe('R-Sentinel · Linear regression', () => {
  test('recovers the exact slope and intercept of a noiseless series', () => {
    const fit = linearRegression(series(50, 6, 24)); // +6 pp/min
    expect(fit).not.toBeNull();
    expect(fit!.slope).toBeCloseTo(6, 6);
    expect(fit!.intercept).toBeCloseTo(50, 6);
    expect(fit!.r2).toBeCloseTo(1, 6);
    expect(fit!.sampleCount).toBe(24);
  });

  test('recovers a negative slope for a recovering series', () => {
    const fit = linearRegression(series(90, -3, 24));
    expect(fit!.slope).toBeCloseTo(-3, 6);
    expect(fit!.r2).toBeCloseTo(1, 6);
  });

  test('reports a perfect fit and zero slope for a flat series', () => {
    const fit = linearRegression(series(40, 0, 20));
    expect(fit!.slope).toBeCloseTo(0, 8);
    expect(fit!.r2).toBe(1);
  });

  test('is robust to symmetric noise around a linear trend', () => {
    const base = series(40, 4, 40);
    const noisy = base.map((m, i) => {
      const noise = i % 2 === 0 ? 0.5 : -0.5;
      return { ...m, value: m.value + noise, utilisationPercent: m.value + noise };
    });
    const fit = linearRegression(noisy);
    expect(fit!.slope).toBeCloseTo(4, 1);
    expect(fit!.r2).toBeGreaterThan(0.95);
  });

  test('returns null below the minimum sample count', () => {
    expect(linearRegression(series(50, 5, MIN_SAMPLES - 1))).toBeNull();
    expect(linearRegression([])).toBeNull();
  });

  test('returns null when every sample shares one timestamp', () => {
    const collapsed = series(50, 5, 10).map((m) => ({ ...m, timestamp: new Date(T0) }));
    expect(linearRegression(collapsed)).toBeNull();
  });

  test('never fits more than the last 60 data points', () => {
    const fit = linearRegression(series(10, 1, 500));
    expect(fit!.sampleCount).toBe(FORECAST_WINDOW);
    expect(FORECAST_WINDOW).toBe(60);
  });

  test('uses only the most recent window when the trend reverses', () => {
    // 100 samples rising, then 60 samples falling: the fit must be negative.
    const rising = series(10, 2, 100);
    const lastRising = rising[rising.length - 1];
    const falling = Array.from({ length: 60 }, (_, i) => {
      const value = lastRising.value - 2 * ((i + 1) * STEP_MS) / 60_000;
      return {
        ...lastRising,
        value,
        utilisationPercent: value,
        timestamp: new Date(lastRising.timestamp.getTime() + (i + 1) * STEP_MS),
      };
    });
    const fit = linearRegression([...rising, ...falling]);
    expect(fit!.slope).toBeLessThan(0);
  });
});

describe('R-Sentinel · Trend and projection', () => {
  test('classifies trends against the flat-slope epsilon', () => {
    expect(classifyTrend(1)).toBe('rising');
    expect(classifyTrend(-1)).toBe('falling');
    expect(classifyTrend(0)).toBe('flat');
    expect(classifyTrend(FLAT_SLOPE_EPSILON / 2)).toBe('flat');
  });

  test('projects minutes to a threshold from slope and current value', () => {
    expect(minutesTo(50, 5, 70)).toBeCloseTo(4, 6); // 20 pp at 5 pp/min
    expect(minutesTo(50, 2, 95)).toBeCloseTo(22.5, 6);
  });

  test('returns 0 when the threshold is already met', () => {
    expect(minutesTo(96, 1, 95)).toBe(0);
  });

  test('returns null when the threshold is unreachable', () => {
    expect(minutesTo(50, 0, 70)).toBeNull();
    expect(minutesTo(50, -3, 70)).toBeNull();
  });

  test('confidence rises with both fit quality and sample count', () => {
    expect(confidenceFor(1, 60)).toBeCloseTo(1, 3);
    expect(confidenceFor(1, 6)).toBeLessThan(confidenceFor(1, 60));
    expect(confidenceFor(0.5, 60)).toBeCloseTo(0.5, 3);
    expect(confidenceFor(0, 60)).toBe(0);
    expect(confidenceFor(1, 6)).toBeGreaterThan(0);
  });
});

describe('R-Sentinel · Forecast output', () => {
  test('projects time to YELLOW and RED for a rising series', () => {
    // 50 % rising at 5 pp/min → YELLOW (70) in 4 min, RED (95) in 9 min.
    const result = forecast(series(50, 5, 24));
    expect(result).not.toBeNull();
    expect(result!.resource).toBe('ram');
    expect(result!.trend).toBe('rising');
    expect(result!.currentUtilisation).toBeCloseTo(50 + 5 * ((23 * STEP_MS) / 60_000), 1);
    expect(result!.estimatedTimeToYellow).not.toBeNull();
    expect(result!.estimatedTimeToRed).not.toBeNull();
    expect(result!.estimatedTimeToRed!).toBeGreaterThan(result!.estimatedTimeToYellow!);
    expect(result!.confidence).toBeGreaterThan(0.5);
    expect(result!.slopePercentPerMinute).toBeCloseTo(5, 4);
  });

  test('projection matches the analytical answer', () => {
    // Exactly 12 samples (1 minute) at +6 pp/min from 40 % → last value 45.5 %.
    const result = forecast(series(40, 6, 12))!;
    const current = result.currentUtilisation;
    expect(result.estimatedTimeToYellow).toBeCloseTo((70 - current) / 6, 1);
    expect(result.estimatedTimeToRed).toBeCloseTo((95 - current) / 6, 1);
  });

  test('a falling series below YELLOW yields no threshold projections and a recovery note', () => {
    const result = forecast(series(60, -4, 24))!;
    expect(result.trend).toBe('falling');
    expect(result.estimatedTimeToYellow).toBeNull();
    expect(result.estimatedTimeToRed).toBeNull();
    expect(result.recommendation.toLowerCase()).toContain('recovering');
  });

  test('a falling series already above YELLOW reports 0 to YELLOW but no path to RED', () => {
    const result = forecast(series(80, -4, 24))!;
    expect(result.trend).toBe('falling');
    expect(result.estimatedTimeToYellow).toBe(0);
    expect(result.estimatedTimeToRed).toBeNull();
  });

  test('a flat series is reported as stable', () => {
    const result = forecast(series(45, 0, 24))!;
    expect(result.trend).toBe('flat');
    expect(result.recommendation.toLowerCase()).toContain('stable');
  });

  test('a series already above YELLOW reports zero minutes to YELLOW', () => {
    const result = forecast(series(80, 3, 24))!;
    expect(result.estimatedTimeToYellow).toBe(0);
    expect(result.estimatedTimeToRed).toBeGreaterThan(0);
  });

  test('an imminent RED breach escalates the recommendation', () => {
    const result = forecast(series(88, 4, 24))!;
    expect(result.estimatedTimeToRed).not.toBeNull();
    expect(result.estimatedTimeToRed!).toBeLessThanOrEqual(15);
    expect(result.recommendation).toContain('RED');
  });

  test('an under-sampled series yields zero confidence rather than a guess', () => {
    const result = forecast(series(50, 5, 2))!;
    expect(result.confidence).toBe(0);
    expect(result.trend).toBe('flat');
    expect(result.recommendation).toContain('Insufficient history');
  });

  test('an empty series produces no forecast', () => {
    expect(forecast([])).toBeNull();
  });

  test('forecastAll produces one forecast per series', () => {
    const map = new Map<string, ResourceMetric[]>([
      ['ram.utilisation', series(50, 5, 24)],
      ['cpu.utilisation', series(20, 0, 24)],
      ['storage.utilisation', []],
    ]);
    expect(forecastAll(map)).toHaveLength(2);
  });
});

describe('R-Sentinel · Exhaustion estimation', () => {
  test('projects an exhaustion timestamp for a rising series', () => {
    const points = series(50, 10, 24);
    const latest = points[points.length - 1];
    const exhaustion = estimateExhaustion(points);
    expect(exhaustion).not.toBeNull();
    const minutes = (exhaustion!.getTime() - latest.timestamp.getTime()) / 60_000;
    expect(minutes).toBeCloseTo((100 - latest.value) / 10, 1);
  });

  test('returns null for flat, falling, or empty series', () => {
    expect(estimateExhaustion(series(50, 0, 24))).toBeNull();
    expect(estimateExhaustion(series(50, -5, 24))).toBeNull();
    expect(estimateExhaustion([])).toBeNull();
  });
});

describe('R-Sentinel · Plane integration', () => {
  test('collects, buffers, forecasts and reports health', async () => {
    const plane = new RSentinelPlane({
      enabled: true,
      intervalMs: 5_000,
      degradationEnabled: false,
    });

    const metrics = await plane.collect();
    expect(metrics.length).toBeGreaterThanOrEqual(8); // 3 system + 2 GPU + 3 runtime
    await plane.collect();
    await plane.collect();

    const status = plane.getStatus();
    expect(status.metrics.length).toBeGreaterThanOrEqual(8);
    expect(['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLACK']).toContain(status.severity);
    expect(Array.isArray(status.forecasts)).toBe(true);
    expect(status.degradationLevel).toBeGreaterThanOrEqual(0);

    const health = await plane.health();
    expect(health.planeId).toBe('r-sentinel');
    expect(['healthy', 'degraded', 'offline']).toContain(health.status);

    const diagnostics = plane.getDiagnostics();
    expect(diagnostics.pollsTotal).toBe(3);
    expect(diagnostics.capacityPerSeries).toBe(60);
    expect(diagnostics.hysteresisBreaches).toBe(3);
    expect(diagnostics.degradationAuthorised).toBe(false);

    plane.stop();
  });

  test('process() is pass-through and annotates severity without mutating the prompt', async () => {
    const plane = new RSentinelPlane({ enabled: true, degradationEnabled: false });
    await plane.collect();

    const request = {
      id: 'req-1',
      sessionId: 'sess-1',
      prompt: 'Dispatch the 20 MWh BESS at 18:00.',
      createdAt: new Date(),
      metadata: { origin: 'test' },
    };

    const result = await plane.process(request);
    expect(result.prompt).toBe(request.prompt);
    expect(result.id).toBe(request.id);
    expect((result.metadata as Record<string, unknown>).origin).toBe('test');
    const sentinelMeta = (result.metadata as Record<string, Record<string, unknown>>).sentinel;
    expect(['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLACK']).toContain(sentinelMeta.severity);
    expect(typeof sentinelMeta.degradationLevel).toBe('number');

    plane.stop();
  });

  test('a disabled plane reports offline and does not poll', async () => {
    const plane = new RSentinelPlane({ enabled: false });
    await plane.init();
    const health = await plane.health();
    expect(health.status).toBe('offline');
    expect(plane.getDiagnostics().polling).toBe(false);
    plane.stop();
  });
});
