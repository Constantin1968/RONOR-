/**
 * R-Sentinel — Metric Ring Buffer
 * MIP-013
 *
 * A fixed-capacity circular buffer holding the most recent metric
 * observations (default: the last 5 minutes at a 5-second cadence).
 * Capacity is allocated once at construction and never grows, so the
 * Sentinel plane cannot itself become a source of memory pressure.
 */

import type { ResourceMetric } from '../planes/r-sentinel/types';

export const DEFAULT_WINDOW_MS = 5 * 60 * 1000; // 5 minutes
export const DEFAULT_INTERVAL_MS = 5_000; // 5 seconds

/**
 * Generic fixed-size circular buffer.
 * Writes overwrite the oldest slot once capacity is reached.
 */
export class RingBuffer<T> {
  private readonly slots: (T | undefined)[];
  private writeIndex = 0;
  private size = 0;

  constructor(public readonly capacity: number) {
    if (!Number.isFinite(capacity) || capacity < 1) {
      throw new Error('RingBuffer capacity must be a positive integer');
    }
    this.slots = new Array<T | undefined>(Math.floor(capacity));
  }

  push(item: T): void {
    this.slots[this.writeIndex] = item;
    this.writeIndex = (this.writeIndex + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  /** Items in chronological order (oldest first). */
  toArray(): T[] {
    if (this.size === 0) return [];
    const out: T[] = [];
    const start = this.size < this.capacity ? 0 : this.writeIndex;
    for (let i = 0; i < this.size; i++) {
      const item = this.slots[(start + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  /** The most recent `n` items in chronological order. */
  last(n: number): T[] {
    if (n <= 0) return [];
    const all = this.toArray();
    return all.slice(Math.max(0, all.length - n));
  }

  get length(): number {
    return this.size;
  }

  get isFull(): boolean {
    return this.size === this.capacity;
  }

  clear(): void {
    this.slots.fill(undefined);
    this.writeIndex = 0;
    this.size = 0;
  }
}

/**
 * Metric-aware ring buffer: one fixed-size series per metric name, so a
 * forecast over `ram.utilisation` is never diluted by `cpu.utilisation`.
 */
export class MetricRingBuffer {
  private readonly series = new Map<string, RingBuffer<ResourceMetric>>();

  /** Number of samples retained per metric series. */
  public readonly capacityPerSeries: number;

  constructor(
    public readonly windowMs: number = DEFAULT_WINDOW_MS,
    public readonly intervalMs: number = DEFAULT_INTERVAL_MS
  ) {
    const safeInterval = intervalMs > 0 ? intervalMs : DEFAULT_INTERVAL_MS;
    this.capacityPerSeries = Math.max(2, Math.ceil(windowMs / safeInterval));
  }

  record(metric: ResourceMetric): void {
    let buffer = this.series.get(metric.name);
    if (!buffer) {
      buffer = new RingBuffer<ResourceMetric>(this.capacityPerSeries);
      this.series.set(metric.name, buffer);
    }
    buffer.push(metric);
  }

  recordAll(metrics: ResourceMetric[]): void {
    for (const metric of metrics) this.record(metric);
  }

  /** Chronological series for one metric name. */
  get(name: string): ResourceMetric[] {
    return this.series.get(name)?.toArray() ?? [];
  }

  /** The most recent `n` samples for one metric name. */
  recent(name: string, n: number): ResourceMetric[] {
    return this.series.get(name)?.last(n) ?? [];
  }

  /** The single latest sample for one metric name, if any. */
  latest(name: string): ResourceMetric | undefined {
    const items = this.series.get(name)?.last(1) ?? [];
    return items[0];
  }

  /** The latest sample of every known metric. */
  latestAll(): ResourceMetric[] {
    const out: ResourceMetric[] = [];
    for (const name of this.series.keys()) {
      const metric = this.latest(name);
      if (metric) out.push(metric);
    }
    return out;
  }

  names(): string[] {
    return [...this.series.keys()];
  }

  /** Total samples retained across all series. */
  get totalSamples(): number {
    let total = 0;
    for (const buffer of this.series.values()) total += buffer.length;
    return total;
  }

  clear(): void {
    for (const buffer of this.series.values()) buffer.clear();
    this.series.clear();
  }
}
