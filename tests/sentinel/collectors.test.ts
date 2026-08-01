/**
 * R-Sentinel — Collector Tests (MIP-013)
 *
 * Verifies that every collector returns well-formed, schema-valid metrics and
 * degrades gracefully when a probe is unavailable (no GPU, no `df`).
 */

import {
  collectRam,
  collectCpu,
  collectStorage,
  collectSystemMetrics,
  parseDfOutput,
  resetCpuBaseline,
} from '../../src/sentinel/collectors/system';
import {
  collectGpuMetrics,
  parseNvidiaSmiOutput,
  resetGpuAvailability,
} from '../../src/sentinel/collectors/gpu';
import {
  collectRuntimeMetrics,
  recordInference,
  registerSessionCounter,
  resetRuntimeCounters,
} from '../../src/sentinel/collectors/runtime';
import { ResourceMetricSchema } from '../../src/planes/r-sentinel/types';
import type { ResourceMetric } from '../../src/planes/r-sentinel/types';

function expectValidMetric(metric: ResourceMetric): void {
  const parsed = ResourceMetricSchema.safeParse(metric);
  expect(parsed.success).toBe(true);
  expect(metric.name.length).toBeGreaterThan(0);
  expect(Number.isFinite(metric.value)).toBe(true);
  expect(metric.timestamp instanceof Date).toBe(true);
}

describe('R-Sentinel · System Collector', () => {
  beforeEach(() => resetCpuBaseline());

  test('RAM collector reports a valid utilisation percentage', () => {
    const metric = collectRam();
    expectValidMetric(metric);
    expect(metric.name).toBe('ram.utilisation');
    expect(metric.resource).toBe('ram');
    expect(metric.unit).toBe('percent');
    expect(metric.available).toBe(true);
    expect(metric.value).toBeGreaterThan(0);
    expect(metric.value).toBeLessThanOrEqual(100);
    expect(metric.capacity).toBeGreaterThan(0);
  });

  test('RAM utilisation is consistent with the reported byte counts', () => {
    const metric = collectRam();
    const meta = metric.metadata as { totalBytes: number; usedBytes: number };
    const expected = (meta.usedBytes / meta.totalBytes) * 100;
    expect(Math.abs(metric.value - expected)).toBeLessThan(0.5);
  });

  test('CPU collector falls back to load average on first sample, then uses tick deltas', () => {
    const first = collectCpu();
    expectValidMetric(first);
    expect((first.metadata as { method: string }).method).toBe('loadavg');

    const second = collectCpu();
    expect(second.value).toBeGreaterThanOrEqual(0);
    expect(second.value).toBeLessThanOrEqual(100);
    expect((second.metadata as { cores: number }).cores).toBeGreaterThan(0);
  });

  test('storage collector returns a bounded utilisation percentage', async () => {
    const metric = await collectStorage('/');
    expectValidMetric(metric);
    expect(metric.resource).toBe('storage');
    expect(metric.value).toBeGreaterThanOrEqual(0);
    expect(metric.value).toBeLessThanOrEqual(100);
  });

  test('storage collector degrades gracefully for a non-existent mount', async () => {
    const metric = await collectStorage('/definitely/not/a/real/mount/point-xyz');
    expect(metric.available).toBe(false);
    expect(metric.value).toBe(0);
    expect((metric.metadata as { reason: string }).reason).toBe('df_unavailable');
  });

  test('df parser extracts total, used and available bytes', () => {
    const sample = [
      'Filesystem     1K-blocks     Used Available Use% Mounted on',
      '/dev/root       61608176 20502212  41089580  34% /',
    ].join('\n');
    const parsed = parseDfOutput(sample);
    expect(parsed).not.toBeNull();
    expect(parsed!.totalBytes).toBe(61608176 * 1024);
    expect(parsed!.usedBytes).toBe(20502212 * 1024);
    expect(parsed!.utilisationPercent).toBeCloseTo(
      (20502212 / (20502212 + 41089580)) * 100,
      2
    );
  });

  test('df parser rejects unusable output', () => {
    expect(parseDfOutput('')).toBeNull();
    expect(parseDfOutput('Filesystem 1K-blocks Used Available Use% Mounted on')).toBeNull();
  });

  test('system collector returns RAM, CPU and storage metrics', async () => {
    const metrics = await collectSystemMetrics();
    expect(metrics).toHaveLength(3);
    metrics.forEach(expectValidMetric);
    expect(metrics.map((m) => m.resource).sort()).toEqual(['cpu', 'ram', 'storage']);
    metrics.forEach((m) => expect(m.collector).toBe('system'));
  });
});

describe('R-Sentinel · GPU Collector', () => {
  beforeEach(() => resetGpuAvailability());

  test('always returns two shape-stable metrics, GPU present or not', async () => {
    const metrics = await collectGpuMetrics();
    expect(metrics).toHaveLength(2);
    metrics.forEach(expectValidMetric);
    expect(metrics.map((m) => m.name)).toEqual(['gpu.utilisation', 'gpu.memory.utilisation']);
    metrics.forEach((m) => expect(m.collector).toBe('gpu'));
    // In CI there is no NVIDIA GPU: the collector must report unavailability
    // rather than throwing or fabricating values.
    metrics.forEach((m) => {
      expect(typeof m.available).toBe('boolean');
      if (m.available === false) expect(m.value).toBe(0);
    });
  });

  test('nvidia-smi parser reads multi-GPU CSV output', () => {
    const sample = [
      '0, NVIDIA A100-SXM4-40GB, 42, 40960, 20480, 61',
      '1, NVIDIA A100-SXM4-40GB, 91, 40960, 38912, 74',
    ].join('\n');
    const readings = parseNvidiaSmiOutput(sample);
    expect(readings).toHaveLength(2);
    expect(readings[0].index).toBe(0);
    expect(readings[0].utilisationPercent).toBe(42);
    expect(readings[0].memoryUtilisationPercent).toBeCloseTo(50, 2);
    expect(readings[1].memoryUtilisationPercent).toBeCloseTo(95, 2);
    expect(readings[1].temperatureC).toBe(74);
  });

  test('nvidia-smi parser ignores malformed rows', () => {
    expect(parseNvidiaSmiOutput('')).toHaveLength(0);
    expect(parseNvidiaSmiOutput('garbage, output')).toHaveLength(0);
    expect(parseNvidiaSmiOutput('0, GPU, 10, notanumber, 5, 40')).toHaveLength(0);
  });
});

describe('R-Sentinel · Runtime Collector', () => {
  beforeEach(() => resetRuntimeCounters());

  test('returns three runtime metrics marked unavailable before any publisher registers', () => {
    const metrics = collectRuntimeMetrics();
    expect(metrics).toHaveLength(3);
    metrics.forEach(expectValidMetric);
    expect(metrics.map((m) => m.resource)).toEqual([
      'context-sessions',
      'token-throughput',
      'inference-latency',
    ]);
    metrics.forEach((m) => expect(m.available).toBe(false));
  });

  test('reports the session count published by the registered counter', () => {
    registerSessionCounter(() => 250);
    const metrics = collectRuntimeMetrics();
    const sessions = metrics.find((m) => m.resource === 'context-sessions')!;
    expect(sessions.value).toBe(250);
    expect(sessions.available).toBe(true);
    // 250 of a 1000-session reference capacity → 25 % utilisation.
    expect(sessions.utilisationPercent).toBeCloseTo(25, 1);
  });

  test('survives a throwing session counter', () => {
    registerSessionCounter(() => {
      throw new Error('plane unavailable');
    });
    const metrics = collectRuntimeMetrics();
    const sessions = metrics.find((m) => m.resource === 'context-sessions')!;
    expect(sessions.value).toBe(0);
  });

  test('derives throughput and mean latency from recorded inferences', () => {
    recordInference(1000, 100);
    recordInference(2000, 300);
    const metrics = collectRuntimeMetrics();

    const throughput = metrics.find((m) => m.resource === 'token-throughput')!;
    const latency = metrics.find((m) => m.resource === 'inference-latency')!;

    expect(throughput.available).toBe(true);
    expect(throughput.value).toBeGreaterThan(0);
    expect(throughput.unit).toBe('tokens/s');
    expect(latency.value).toBeCloseTo(200, 0);
    expect(latency.unit).toBe('ms');
  });

  test('all utilisation percentages remain within [0, 100]', () => {
    registerSessionCounter(() => 10_000_000);
    recordInference(1_000_000_000, 10_000_000);
    for (const metric of collectRuntimeMetrics()) {
      expect(metric.utilisationPercent!).toBeGreaterThanOrEqual(0);
      expect(metric.utilisationPercent!).toBeLessThanOrEqual(100);
    }
  });
});
