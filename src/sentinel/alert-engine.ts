/**
 * R-Sentinel — Alert Engine
 * MIP-013
 *
 * Maps utilisation percentages onto the five-band severity ladder and applies
 * hysteresis so transient spikes never page an operator:
 *
 *   GREEN  < 70 %   ·  YELLOW 70–84 %  ·  ORANGE 85–94 %
 *   RED    95–98 %  ·  BLACK  >= 99 %
 *
 * A non-GREEN band must be observed on N consecutive polls (default 3) before
 * an alert is emitted; recovery to GREEN likewise requires N consecutive
 * observations before the condition is cleared. Each emitted alert carries a
 * deterministic SHA-256 audit record identifier so it can be anchored into the
 * existing RONOR hash-chain without a second hashing scheme.
 */

import { createHash } from 'crypto';
import { createLogger } from '../utils/logger';
import { SEVERITY_RANK, SEVERITY_THRESHOLDS } from '../planes/r-sentinel/types';
import type {
  AlertSeverity,
  ResourceAlert,
  ResourceKind,
  ResourceMetric,
} from '../planes/r-sentinel/types';

const logger = createLogger('Sentinel:AlertEngine');

export const DEFAULT_HYSTERESIS_BREACHES = 3;

/** Classify a utilisation percentage into a severity band. */
export function evaluateSeverity(utilisationPercent: number): AlertSeverity {
  // Non-finite readings (NaN, ±Infinity) are treated as no signal rather than
  // as an extreme, so a broken probe cannot trigger a degradation cascade.
  const value = Number.isFinite(utilisationPercent) ? utilisationPercent : 0;
  if (value >= SEVERITY_THRESHOLDS.BLACK) return 'BLACK';
  if (value >= SEVERITY_THRESHOLDS.RED) return 'RED';
  if (value >= SEVERITY_THRESHOLDS.ORANGE) return 'ORANGE';
  if (value >= SEVERITY_THRESHOLDS.YELLOW) return 'YELLOW';
  return 'GREEN';
}

/** Reversible, human-actionable recommendation per band and resource. */
export function recommendedActionFor(severity: AlertSeverity, resource: ResourceKind): string {
  switch (severity) {
    case 'GREEN':
      return 'No action required — resource within nominal envelope.';
    case 'YELLOW':
      return `Watch ${resource}: increase poll cadence and pre-warm capacity headroom.`;
    case 'ORANGE':
      return `Shed optional load on ${resource}: trim caches, defer batch work, cap new sessions.`;
    case 'RED':
      return `Engage graceful degradation for ${resource}: reduce concurrency and route to lighter models.`;
    case 'BLACK':
      return `Exhaustion imminent on ${resource}: freeze admissions, drain queues, escalate to operator (all steps reversible).`;
    default:
      return 'No action required.';
  }
}

function causeFor(metric: ResourceMetric, severity: AlertSeverity, utilisation: number): string {
  const resource = metric.resource ?? 'ram';
  return `${resource} utilisation at ${utilisation.toFixed(2)}% (${metric.name}) crossed the ${severity} threshold of ${SEVERITY_THRESHOLDS[severity]}%.`;
}

/** Deterministic audit identifier: sha256(resource|severity|utilisation|timestamp). */
export function computeAuditRecordId(
  resource: ResourceKind,
  severity: AlertSeverity,
  utilisation: number,
  timestamp: Date
): string {
  const payload = `${resource}|${severity}|${utilisation.toFixed(4)}|${timestamp.toISOString()}`;
  return `sentinel-${createHash('sha256').update(payload).digest('hex').slice(0, 32)}`;
}

interface SeriesState {
  currentSeverity: AlertSeverity;
  candidateSeverity: AlertSeverity;
  consecutive: number;
}

export interface AlertEvaluation {
  /** Alerts emitted on this evaluation (severity transitions only). */
  alerts: ResourceAlert[];
  /** Highest severity currently confirmed across all series. */
  aggregateSeverity: AlertSeverity;
}

export interface AlertEngineOptions {
  hysteresisBreaches?: number;
  /** Optional exhaustion-time provider (wired to the forecaster). */
  exhaustionEstimator?: (metric: ResourceMetric) => Date | null;
}

export class AlertEngine {
  private readonly hysteresisBreaches: number;
  private readonly exhaustionEstimator?: (metric: ResourceMetric) => Date | null;
  private readonly series = new Map<string, SeriesState>();
  private readonly activeAlerts = new Map<string, ResourceAlert>();
  private alertsEmitted = 0;

  constructor(options: AlertEngineOptions = {}) {
    const configured =
      options.hysteresisBreaches ??
      parseInt(process.env.SENTINEL_HYSTERESIS_BREACHES || String(DEFAULT_HYSTERESIS_BREACHES), 10);
    this.hysteresisBreaches = Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_HYSTERESIS_BREACHES;
    this.exhaustionEstimator = options.exhaustionEstimator;
  }

  get breachesRequired(): number {
    return this.hysteresisBreaches;
  }

  get totalAlertsEmitted(): number {
    return this.alertsEmitted;
  }

  /**
   * Evaluate one metric. Returns an alert only when a new severity band has
   * been confirmed by `hysteresisBreaches` consecutive observations.
   */
  evaluate(metric: ResourceMetric): ResourceAlert | null {
    // Unavailable probes must not fabricate alerts.
    if (metric.available === false) return null;

    const utilisation = metric.utilisationPercent ?? (metric.unit === 'percent' ? metric.value : 0);
    const observed = evaluateSeverity(utilisation);
    const key = metric.name;

    let state = this.series.get(key);
    if (!state) {
      state = { currentSeverity: 'GREEN', candidateSeverity: observed, consecutive: 1 };
      this.series.set(key, state);
    } else if (observed === state.candidateSeverity) {
      state.consecutive++;
    } else {
      state.candidateSeverity = observed;
      state.consecutive = 1;
    }

    // Already in the confirmed band — nothing to transition to.
    if (observed === state.currentSeverity) {
      if (observed === 'GREEN') this.activeAlerts.delete(key);
      return null;
    }

    if (state.consecutive < this.hysteresisBreaches) return null;

    const previousSeverity = state.currentSeverity;
    state.currentSeverity = observed;

    if (observed === 'GREEN') {
      this.activeAlerts.delete(key);
      logger.info(`${key} recovered to GREEN after ${state.consecutive} consecutive observations`);
      return null;
    }

    const resource: ResourceKind = metric.resource ?? 'ram';
    const timestamp = metric.timestamp ?? new Date();
    const alert: ResourceAlert = {
      severity: observed,
      resource,
      cause: causeFor(metric, observed, utilisation),
      currentUtilisation: Number(utilisation.toFixed(2)),
      remainingCapacity: Number(Math.max(0, 100 - utilisation).toFixed(2)),
      estimatedExhaustion: this.exhaustionEstimator ? this.exhaustionEstimator(metric) : null,
      recommendedAction: recommendedActionFor(observed, resource),
      timestamp,
      auditRecordId: computeAuditRecordId(resource, observed, utilisation, timestamp),
      consecutiveBreaches: state.consecutive,
      previousSeverity,
    };

    this.activeAlerts.set(key, alert);
    this.alertsEmitted++;
    logger.warn(
      `ALERT ${observed} · ${resource} · ${alert.currentUtilisation}% (was ${previousSeverity}) · audit ${alert.auditRecordId}`
    );

    return alert;
  }

  /** Evaluate a full metric batch. */
  evaluateBatch(metrics: ResourceMetric[]): AlertEvaluation {
    const alerts: ResourceAlert[] = [];
    for (const metric of metrics) {
      const alert = this.evaluate(metric);
      if (alert) alerts.push(alert);
    }
    return { alerts, aggregateSeverity: this.aggregateSeverity() };
  }

  /** Currently confirmed, non-GREEN alerts. */
  getActiveAlerts(): ResourceAlert[] {
    return [...this.activeAlerts.values()].sort(
      (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
    );
  }

  /** Confirmed severity for a single metric series. */
  severityFor(metricName: string): AlertSeverity {
    return this.series.get(metricName)?.currentSeverity ?? 'GREEN';
  }

  /** Highest confirmed severity across all series. */
  aggregateSeverity(): AlertSeverity {
    let worst: AlertSeverity = 'GREEN';
    for (const state of this.series.values()) {
      if (SEVERITY_RANK[state.currentSeverity] > SEVERITY_RANK[worst]) worst = state.currentSeverity;
    }
    return worst;
  }

  reset(): void {
    this.series.clear();
    this.activeAlerts.clear();
    this.alertsEmitted = 0;
  }
}
