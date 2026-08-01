/**
 * R-Sentinel — Runtime Collector
 * MIP-013
 *
 * Observes RONOR's own logical resources rather than the host's physical ones:
 *   · context sessions   — active sessions held by R-Context
 *   · token throughput   — tokens/second observed across recent inferences
 *   · inference latency  — rolling mean latency reported by the runtime
 *
 * The collector is deliberately *pull-free*: it does not import other planes
 * (which would create a circular dependency and violate the plane isolation
 * rule). Instead planes publish counters into a lightweight, in-process
 * registry which the collector samples. When no plane has published, the
 * collector reports zeroed metrics with `available: false`.
 */

import { createLogger } from '../../utils/logger';
import type { ResourceMetric } from '../../planes/r-sentinel/types';

const logger = createLogger('Sentinel:Collector:Runtime');

const MAX_SESSIONS = parseInt(process.env.SENTINEL_MAX_SESSIONS || '1000', 10);
const MAX_TOKENS_PER_SECOND = parseInt(process.env.SENTINEL_MAX_TOKENS_PER_SECOND || '20000', 10);
const LATENCY_BUDGET_MS = parseInt(process.env.SENTINEL_LATENCY_BUDGET_MS || '30000', 10);
const LATENCY_WINDOW = 50;

export interface RuntimeSnapshot {
  activeSessions: number;
  tokensPerSecond: number;
  meanLatencyMs: number;
  observations: number;
}

interface RuntimeState {
  sessionCounter: (() => number) | null;
  tokensObserved: number;
  windowStartedAt: number;
  latencies: number[];
  observations: number;
}

const state: RuntimeState = {
  sessionCounter: null,
  tokensObserved: 0,
  windowStartedAt: Date.now(),
  latencies: [],
  observations: 0,
};

/**
 * Register a callback that returns the current number of active context
 * sessions. Called by the plane owner (e.g. bootstrap) to avoid a hard import
 * of R-Context inside the Sentinel plane.
 */
export function registerSessionCounter(counter: () => number): void {
  state.sessionCounter = counter;
  logger.debug('Session counter registered with Sentinel runtime collector');
}

/** Report a completed inference so throughput and latency can be derived. */
export function recordInference(tokens: number, latencyMs: number): void {
  if (Number.isFinite(tokens) && tokens > 0) state.tokensObserved += tokens;
  if (Number.isFinite(latencyMs) && latencyMs >= 0) {
    state.latencies.push(latencyMs);
    if (state.latencies.length > LATENCY_WINDOW) state.latencies.shift();
  }
  state.observations++;
}

/** Reset all runtime counters (used by tests and on plane restart). */
export function resetRuntimeCounters(): void {
  state.sessionCounter = null;
  state.tokensObserved = 0;
  state.windowStartedAt = Date.now();
  state.latencies = [];
  state.observations = 0;
}

function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Current runtime snapshot; consumes the throughput window. */
export function snapshotRuntime(now: Date = new Date()): RuntimeSnapshot {
  const elapsedMs = Math.max(1, now.getTime() - state.windowStartedAt);
  const tokensPerSecond = (state.tokensObserved / elapsedMs) * 1000;
  const meanLatencyMs =
    state.latencies.length > 0
      ? state.latencies.reduce((sum, v) => sum + v, 0) / state.latencies.length
      : 0;

  // Roll the throughput window forward.
  state.tokensObserved = 0;
  state.windowStartedAt = now.getTime();

  let activeSessions = 0;
  if (state.sessionCounter) {
    try {
      const value = state.sessionCounter();
      activeSessions = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
    } catch (error) {
      logger.debug(
        `Session counter threw: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }

  return {
    activeSessions,
    tokensPerSecond: round(tokensPerSecond),
    meanLatencyMs: round(meanLatencyMs),
    observations: state.observations,
  };
}

/** Collect the runtime metric set (sessions, throughput, latency). */
export function collectRuntimeMetrics(now: Date = new Date()): ResourceMetric[] {
  const snapshot = snapshotRuntime(now);
  const hasPublisher = state.sessionCounter !== null || snapshot.observations > 0;

  const sessionUtilisation = clampPercent((snapshot.activeSessions / Math.max(1, MAX_SESSIONS)) * 100);
  const throughputUtilisation = clampPercent(
    (snapshot.tokensPerSecond / Math.max(1, MAX_TOKENS_PER_SECOND)) * 100
  );
  const latencyUtilisation = clampPercent(
    (snapshot.meanLatencyMs / Math.max(1, LATENCY_BUDGET_MS)) * 100
  );

  return [
    {
      name: 'context.sessions',
      value: snapshot.activeSessions,
      unit: 'count',
      timestamp: now,
      resource: 'context-sessions',
      utilisationPercent: round(sessionUtilisation),
      capacity: MAX_SESSIONS,
      collector: 'runtime',
      available: hasPublisher,
      metadata: { maxSessions: MAX_SESSIONS },
    },
    {
      name: 'runtime.token.throughput',
      value: snapshot.tokensPerSecond,
      unit: 'tokens/s',
      timestamp: now,
      resource: 'token-throughput',
      utilisationPercent: round(throughputUtilisation),
      capacity: MAX_TOKENS_PER_SECOND,
      collector: 'runtime',
      available: hasPublisher,
      metadata: { maxTokensPerSecond: MAX_TOKENS_PER_SECOND, observations: snapshot.observations },
    },
    {
      name: 'runtime.inference.latency',
      value: snapshot.meanLatencyMs,
      unit: 'ms',
      timestamp: now,
      resource: 'inference-latency',
      utilisationPercent: round(latencyUtilisation),
      capacity: LATENCY_BUDGET_MS,
      collector: 'runtime',
      available: hasPublisher,
      metadata: { latencyBudgetMs: LATENCY_BUDGET_MS, samples: snapshot.observations },
    },
  ];
}
