/**
 * R-Sentinel Plane
 * Plane 8 of 8 — Operational resource intelligence (MIP-013).
 *
 * Responsibilities:
 * - Continuous collection of host and runtime resource metrics
 * - Five-band severity evaluation (GREEN → BLACK) with hysteresis
 * - Bounded in-memory metric retention (fixed-size ring buffer)
 * - Linear-regression forecasting of time-to-YELLOW / time-to-RED
 * - Policy-gated, fully reversible graceful degradation
 *
 * R-Sentinel is an *observational* plane: `process()` is pass-through and never
 * mutates or blocks an inference request. It annotates the request with the
 * current operational severity so downstream planes may adapt voluntarily.
 */

import { createLogger } from '../../utils/logger';
import type { RONORRequest, PlaneHealth } from '../../types';
import { MetricRingBuffer, DEFAULT_WINDOW_MS, DEFAULT_INTERVAL_MS } from '../../sentinel/ring-buffer';
import { AlertEngine, DEFAULT_HYSTERESIS_BREACHES } from '../../sentinel/alert-engine';
import { ResponseController, DEGRADATION_LADDER } from '../../sentinel/response-controller';
import { forecast, estimateExhaustion, FORECAST_WINDOW } from '../../sentinel/forecaster';
import { collectSystemMetrics, resetCpuBaseline } from '../../sentinel/collectors/system';
import { collectGpuMetrics } from '../../sentinel/collectors/gpu';
import { collectRuntimeMetrics, registerSessionCounter, recordInference } from '../../sentinel/collectors/runtime';
import type {
  AlertSeverity,
  ResourceAlert,
  ResourceForecast,
  ResourceMetric,
  ResourceStatus,
  SentinelConfig,
} from './types';

const logger = createLogger('Plane:R-Sentinel');

const SENTINEL_ENABLED = process.env.SENTINEL_ENABLED !== 'false';
const SENTINEL_INTERVAL_MS = parseInt(process.env.SENTINEL_INTERVAL_MS || String(DEFAULT_INTERVAL_MS), 10);
const SENTINEL_BUFFER_WINDOW_MS = parseInt(
  process.env.SENTINEL_BUFFER_WINDOW_MS || String(DEFAULT_WINDOW_MS),
  10
);

export { registerSessionCounter, recordInference };

export class RSentinelPlane {
  private readonly config: SentinelConfig;
  private readonly buffer: MetricRingBuffer;
  private readonly alertEngine: AlertEngine;
  private readonly responseController: ResponseController;

  private timer: NodeJS.Timeout | null = null;
  private requestsTotal = 0;
  private errorsTotal = 0;
  private pollsTotal = 0;
  private lastCollectionAt: Date | null = null;
  private lastSeverity: AlertSeverity = 'GREEN';

  constructor(overrides: Partial<SentinelConfig> = {}) {
    const intervalMs =
      overrides.intervalMs ??
      (Number.isFinite(SENTINEL_INTERVAL_MS) && SENTINEL_INTERVAL_MS > 0
        ? SENTINEL_INTERVAL_MS
        : DEFAULT_INTERVAL_MS);

    this.config = {
      enabled: overrides.enabled ?? SENTINEL_ENABLED,
      intervalMs,
      hysteresisBreaches: overrides.hysteresisBreaches ?? DEFAULT_HYSTERESIS_BREACHES,
      bufferWindowMs:
        overrides.bufferWindowMs ??
        (Number.isFinite(SENTINEL_BUFFER_WINDOW_MS) && SENTINEL_BUFFER_WINDOW_MS > 0
          ? SENTINEL_BUFFER_WINDOW_MS
          : DEFAULT_WINDOW_MS),
      degradationEnabled:
        overrides.degradationEnabled ?? process.env.SENTINEL_DEGRADATION_ENABLED === 'true',
      maxDegradationLevel: overrides.maxDegradationLevel ?? DEGRADATION_LADDER.length,
    };

    this.buffer = new MetricRingBuffer(this.config.bufferWindowMs, this.config.intervalMs);
    this.alertEngine = new AlertEngine({
      hysteresisBreaches: this.config.hysteresisBreaches,
      exhaustionEstimator: (metric) => estimateExhaustion(this.buffer.get(metric.name)),
    });
    this.responseController = new ResponseController({
      degradationEnabled: this.config.degradationEnabled,
      maxLevel: this.config.maxDegradationLevel,
    });
  }

  async init(): Promise<void> {
    resetCpuBaseline();

    if (!this.config.enabled) {
      logger.warn('R-Sentinel plane disabled by configuration (SENTINEL_ENABLED=false)');
      return;
    }

    // Prime the buffer so the first status query is never empty.
    await this.collect();
    this.start();

    logger.info(
      `R-Sentinel plane initialised ✓ (interval ${this.config.intervalMs}ms · window ${this.config.bufferWindowMs}ms · ${this.buffer.capacityPerSeries} samples/series · hysteresis ${this.config.hysteresisBreaches})`
    );
  }

  /** Start the polling loop (idempotent; the timer is unref'd). */
  start(): void {
    if (this.timer || !this.config.enabled) return;
    this.timer = setInterval(() => {
      void this.collect().catch((error) => {
        this.errorsTotal++;
        logger.error('Sentinel collection cycle failed:', error);
      });
    }, this.config.intervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  /** Stop the polling loop. Safe to call repeatedly. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
      logger.info('R-Sentinel polling loop stopped');
    }
  }

  /**
   * One collection cycle: collect → buffer → evaluate → reconcile.
   * Returns the metrics collected in this cycle.
   */
  async collect(now: Date = new Date()): Promise<ResourceMetric[]> {
    const [system, gpu] = await Promise.all([collectSystemMetrics(now), collectGpuMetrics(now)]);
    const runtime = collectRuntimeMetrics(now);
    const metrics = [...system, ...gpu, ...runtime];

    this.buffer.recordAll(metrics);
    this.pollsTotal++;
    this.lastCollectionAt = now;

    const evaluation = this.alertEngine.evaluateBatch(metrics);
    this.lastSeverity = evaluation.aggregateSeverity;
    this.responseController.reconcile(this.lastSeverity, now);

    return metrics;
  }

  /**
   * Pass-through: annotates the request with the current operational severity.
   * R-Sentinel never blocks or rewrites an inference request.
   */
  async process(request: RONORRequest): Promise<RONORRequest> {
    this.requestsTotal++;
    return {
      ...request,
      metadata: {
        ...(request.metadata ?? {}),
        sentinel: {
          severity: this.lastSeverity,
          degradationLevel: this.responseController.level,
          observedAt: (this.lastCollectionAt ?? new Date()).toISOString(),
        },
      },
    };
  }

  // ----------------------------------------------------------
  // Read models (consumed by the API router)
  // ----------------------------------------------------------

  getConfig(): SentinelConfig {
    return { ...this.config };
  }

  getMetrics(): ResourceMetric[] {
    return this.buffer.latestAll();
  }

  getSeries(name: string): ResourceMetric[] {
    return this.buffer.get(name);
  }

  getAlerts(): ResourceAlert[] {
    return this.alertEngine.getActiveAlerts();
  }

  getSeverity(): AlertSeverity {
    return this.lastSeverity;
  }

  getForecasts(): ResourceForecast[] {
    const out: ResourceForecast[] = [];
    for (const name of this.buffer.names()) {
      const series = this.buffer.recent(name, FORECAST_WINDOW);
      const latest = series[series.length - 1];
      // Unavailable probes (e.g. absent GPU) would forecast pure noise.
      if (!latest || latest.available === false) continue;
      const result = forecast(series);
      if (result) out.push(result);
    }
    return out;
  }

  getStatus(): ResourceStatus {
    return {
      severity: this.lastSeverity,
      metrics: this.getMetrics(),
      alerts: this.getAlerts(),
      forecasts: this.getForecasts(),
      degradationLevel: this.responseController.level,
      collectedAt: this.lastCollectionAt ?? new Date(),
    };
  }

  getResponseController(): ResponseController {
    return this.responseController;
  }

  getDiagnostics(): Record<string, unknown> {
    return {
      enabled: this.config.enabled,
      polling: this.timer !== null,
      pollsTotal: this.pollsTotal,
      intervalMs: this.config.intervalMs,
      seriesTracked: this.buffer.names().length,
      samplesRetained: this.buffer.totalSamples,
      capacityPerSeries: this.buffer.capacityPerSeries,
      hysteresisBreaches: this.alertEngine.breachesRequired,
      alertsEmittedTotal: this.alertEngine.totalAlertsEmitted,
      degradationLevel: this.responseController.level,
      degradationAuthorised: this.responseController.policyAuthorised,
      lastCollectionAt: this.lastCollectionAt?.toISOString() ?? null,
    };
  }

  async health(): Promise<PlaneHealth> {
    const severity = this.lastSeverity;
    const status: PlaneHealth['status'] = !this.config.enabled
      ? 'offline'
      : severity === 'RED' || severity === 'BLACK'
        ? 'degraded'
        : 'healthy';

    return {
      planeId: 'r-sentinel',
      status,
      latencyMs: 1,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      lastChecked: new Date(),
    };
  }
}

export * from './types';
