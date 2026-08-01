/**
 * R-Sentinel — Type Definitions
 * MIP-013 · Operational Resource Intelligence Plane
 *
 * The Sentinel plane observes the physical and runtime substrate on which
 * RONOR executes (RAM, CPU, storage, GPU, context sessions, token throughput,
 * inference latency), evaluates it against a five-band severity ladder, and
 * emits reversible, policy-gated degradation recommendations.
 */

import { z } from 'zod';

// ============================================================
// Severity Ladder
// ============================================================

/**
 * Five-band operational severity ladder.
 *   GREEN  — nominal            (< 70 %)
 *   YELLOW — watch              (70–84 %)
 *   ORANGE — pressure           (85–94 %)
 *   RED    — critical           (95–98 %)
 *   BLACK  — exhaustion imminent (>= 99 %)
 */
export type AlertSeverity = 'GREEN' | 'YELLOW' | 'ORANGE' | 'RED' | 'BLACK';

export const ALERT_SEVERITIES: readonly AlertSeverity[] = [
  'GREEN',
  'YELLOW',
  'ORANGE',
  'RED',
  'BLACK',
] as const;

/** Ordinal rank of a severity band — higher is worse. */
export const SEVERITY_RANK: Readonly<Record<AlertSeverity, number>> = {
  GREEN: 0,
  YELLOW: 1,
  ORANGE: 2,
  RED: 3,
  BLACK: 4,
};

/** Lower bound (inclusive, percent utilisation) of each severity band. */
export const SEVERITY_THRESHOLDS: Readonly<Record<AlertSeverity, number>> = {
  GREEN: 0,
  YELLOW: 70,
  ORANGE: 85,
  RED: 95,
  BLACK: 99,
};

// ============================================================
// Monitored Resources
// ============================================================

export type ResourceKind =
  | 'ram'
  | 'cpu'
  | 'storage'
  | 'gpu'
  | 'gpu-memory'
  | 'context-sessions'
  | 'token-throughput'
  | 'inference-latency';

export type MetricTrend = 'rising' | 'falling' | 'flat';

export type CollectorId = 'system' | 'gpu' | 'runtime';

// ============================================================
// Core Interfaces
// ============================================================

/** A single point-in-time observation of one resource dimension. */
export interface ResourceMetric {
  /** Canonical metric name, e.g. `ram.utilisation`. */
  name: string;
  /** Observed value, expressed in `unit`. */
  value: number;
  /** Unit of measure, e.g. `percent`, `bytes`, `ms`, `count`, `tokens/s`. */
  unit: string;
  /** Observation time. */
  timestamp: Date;
  /** Resource dimension this metric belongs to (optional for free-form metrics). */
  resource?: ResourceKind;
  /** Utilisation as a percentage of capacity, when a capacity is known. */
  utilisationPercent?: number;
  /** Absolute capacity in `unit`, when known. */
  capacity?: number;
  /** Collector that produced the metric. */
  collector?: CollectorId;
  /** Whether the underlying probe succeeded (false → value is a safe default). */
  available?: boolean;
  /** Free-form collector annotations. */
  metadata?: Record<string, unknown>;
}

/** A raised (or cleared) resource condition, ready for audit. */
export interface ResourceAlert {
  severity: AlertSeverity;
  /** Resource dimension the alert concerns. */
  resource: ResourceKind;
  /** Human-readable causal statement. */
  cause: string;
  /** Utilisation percentage at the moment the alert fired. */
  currentUtilisation: number;
  /** Headroom remaining, as a percentage of capacity. */
  remainingCapacity: number;
  /** Projected exhaustion time, or null when no exhaustion is projected. */
  estimatedExhaustion: Date | null;
  /** Reversible operator/runtime action recommended for this severity. */
  recommendedAction: string;
  timestamp: Date;
  /** Deterministic audit identifier (SHA-256 derived, see alert-engine). */
  auditRecordId: string;
  /** Consecutive breaches observed before the alert was emitted (hysteresis). */
  consecutiveBreaches?: number;
  /** Previous severity, when this alert represents a transition. */
  previousSeverity?: AlertSeverity;
}

/** Forward projection for one resource dimension. */
export interface ResourceForecast {
  resource: ResourceKind;
  currentUtilisation: number;
  trend: MetricTrend;
  /** Minutes until the YELLOW band is reached, or null when not projected. */
  estimatedTimeToYellow: number | null;
  /** Minutes until the RED band is reached, or null when not projected. */
  estimatedTimeToRed: number | null;
  recommendation: string;
  /** Forecast confidence in [0, 1], derived from R² and sample count. */
  confidence: number;
  /** Slope of the fitted line, in percentage points per minute. */
  slopePercentPerMinute?: number;
  /** Number of data points used for the fit. */
  sampleCount?: number;
}

/** Aggregate snapshot returned by the status endpoint. */
export interface ResourceStatus {
  severity: AlertSeverity;
  metrics: ResourceMetric[];
  alerts: ResourceAlert[];
  forecasts: ResourceForecast[];
  degradationLevel: number;
  collectedAt: Date;
}

// ============================================================
// Degradation Ladder
// ============================================================

export interface DegradationStep {
  /** Ladder position, 1 (mildest) … 8 (most severe). */
  level: number;
  id: string;
  description: string;
  /** Severity band at which this step becomes eligible. */
  triggerSeverity: AlertSeverity;
  /** Every Sentinel action must be reversible — enforced by tests. */
  reversible: true;
  /** Whether the step requires explicit configuration authorisation. */
  requiresAuthorisation: boolean;
}

export interface DegradationAction {
  step: DegradationStep;
  applied: boolean;
  /** `applied` reason, or the reason authorisation was withheld. */
  reason: string;
  timestamp: Date;
}

// ============================================================
// Configuration
// ============================================================

export interface SentinelConfig {
  enabled: boolean;
  intervalMs: number;
  /** Consecutive breaches required before an alert is emitted. */
  hysteresisBreaches: number;
  /** Retention window of the metric ring buffer, in milliseconds. */
  bufferWindowMs: number;
  /** Whether the response controller may execute degradation steps. */
  degradationEnabled: boolean;
  /** Highest ladder level the controller may reach (1–8). */
  maxDegradationLevel: number;
}

// ============================================================
// Zod Schemas (runtime validation at trust boundaries)
// ============================================================

export const AlertSeveritySchema = z.enum(['GREEN', 'YELLOW', 'ORANGE', 'RED', 'BLACK']);

export const ResourceMetricSchema = z.object({
  name: z.string().min(1),
  value: z.number().finite(),
  unit: z.string().min(1),
  timestamp: z.date(),
  resource: z
    .enum([
      'ram',
      'cpu',
      'storage',
      'gpu',
      'gpu-memory',
      'context-sessions',
      'token-throughput',
      'inference-latency',
    ])
    .optional(),
  utilisationPercent: z.number().min(0).max(100).optional(),
  capacity: z.number().nonnegative().optional(),
  collector: z.enum(['system', 'gpu', 'runtime']).optional(),
  available: z.boolean().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const SentinelQuerySchema = z.object({
  resource: z.string().min(1).optional(),
  severity: AlertSeveritySchema.optional(),
  limit: z.coerce.number().int().positive().max(500).optional(),
});

export type SentinelQuery = z.infer<typeof SentinelQuerySchema>;
