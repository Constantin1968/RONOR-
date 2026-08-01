/**
 * R-Sentinel — GPU Collector
 * MIP-013
 *
 * Thin, defensive wrapper around `nvidia-smi`. On hosts without NVIDIA
 * hardware (the common case for CI and CPU-only deployments) the collector
 * reports `available: false` and the Sentinel loop continues unaffected.
 * The binary is probed once and the result cached, so a missing GPU does not
 * incur a process spawn on every poll.
 */

import { execFile } from 'child_process';
import { createLogger } from '../../utils/logger';
import type { ResourceMetric } from '../../planes/r-sentinel/types';

const logger = createLogger('Sentinel:Collector:GPU');

const NVIDIA_SMI = process.env.SENTINEL_NVIDIA_SMI_PATH || 'nvidia-smi';
const GPU_TIMEOUT_MS = parseInt(process.env.SENTINEL_GPU_TIMEOUT_MS || '3000', 10);

const QUERY_FIELDS = [
  'index',
  'name',
  'utilization.gpu',
  'memory.total',
  'memory.used',
  'temperature.gpu',
] as const;

export interface GpuReading {
  index: number;
  name: string;
  utilisationPercent: number;
  memoryTotalMiB: number;
  memoryUsedMiB: number;
  memoryUtilisationPercent: number;
  temperatureC: number | null;
}

/** Tri-state availability cache: null = not yet probed. */
let gpuAvailable: boolean | null = null;

function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function runNvidiaSmi(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      NVIDIA_SMI,
      [`--query-gpu=${QUERY_FIELDS.join(',')}`, '--format=csv,noheader,nounits'],
      { timeout: GPU_TIMEOUT_MS },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      }
    );
  });
}

/** Parse `nvidia-smi --format=csv,noheader,nounits` output. */
export function parseNvidiaSmiOutput(stdout: string): GpuReading[] {
  const readings: GpuReading[] = [];
  const lines = stdout
    .trim()
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  for (const line of lines) {
    const parts = line.split(',').map((p) => p.trim());
    if (parts.length < 5) continue;

    const [indexRaw, name, utilRaw, memTotalRaw, memUsedRaw, tempRaw] = parts;
    const memoryTotalMiB = Number.parseFloat(memTotalRaw);
    const memoryUsedMiB = Number.parseFloat(memUsedRaw);
    if (!Number.isFinite(memoryTotalMiB) || !Number.isFinite(memoryUsedMiB)) continue;

    const temperature = tempRaw !== undefined ? Number.parseFloat(tempRaw) : Number.NaN;

    readings.push({
      index: Number.isFinite(Number.parseInt(indexRaw, 10)) ? Number.parseInt(indexRaw, 10) : 0,
      name: name || 'unknown-gpu',
      utilisationPercent: clampPercent(Number.parseFloat(utilRaw)),
      memoryTotalMiB,
      memoryUsedMiB,
      memoryUtilisationPercent:
        memoryTotalMiB > 0 ? clampPercent((memoryUsedMiB / memoryTotalMiB) * 100) : 0,
      temperatureC: Number.isFinite(temperature) ? temperature : null,
    });
  }

  return readings;
}

/** Whether `nvidia-smi` responded successfully at least once. */
export async function isGpuAvailable(): Promise<boolean> {
  if (gpuAvailable !== null) return gpuAvailable;
  try {
    await runNvidiaSmi();
    gpuAvailable = true;
  } catch {
    gpuAvailable = false;
    logger.debug('nvidia-smi not available — GPU metrics reported as unavailable');
  }
  return gpuAvailable;
}

/** Clear the availability cache (used by tests). */
export function resetGpuAvailability(): void {
  gpuAvailable = null;
}

function unavailableMetrics(now: Date, reason: string): ResourceMetric[] {
  return [
    {
      name: 'gpu.utilisation',
      value: 0,
      unit: 'percent',
      timestamp: now,
      resource: 'gpu',
      utilisationPercent: 0,
      collector: 'gpu',
      available: false,
      metadata: { reason, deviceCount: 0 },
    },
    {
      name: 'gpu.memory.utilisation',
      value: 0,
      unit: 'percent',
      timestamp: now,
      resource: 'gpu-memory',
      utilisationPercent: 0,
      collector: 'gpu',
      available: false,
      metadata: { reason, deviceCount: 0 },
    },
  ];
}

/**
 * Collect GPU metrics. Returns aggregate (max across devices) utilisation and
 * memory-utilisation metrics; always returns two metrics so downstream series
 * remain shape-stable whether or not a GPU is present.
 */
export async function collectGpuMetrics(now: Date = new Date()): Promise<ResourceMetric[]> {
  if (!(await isGpuAvailable())) {
    return unavailableMetrics(now, 'nvidia_smi_unavailable');
  }

  try {
    const readings = parseNvidiaSmiOutput(await runNvidiaSmi());
    if (readings.length === 0) return unavailableMetrics(now, 'no_devices_reported');

    const maxUtil = Math.max(...readings.map((r) => r.utilisationPercent));
    const maxMemUtil = Math.max(...readings.map((r) => r.memoryUtilisationPercent));
    const totalMemory = readings.reduce((sum, r) => sum + r.memoryTotalMiB, 0);
    const usedMemory = readings.reduce((sum, r) => sum + r.memoryUsedMiB, 0);

    return [
      {
        name: 'gpu.utilisation',
        value: round(maxUtil),
        unit: 'percent',
        timestamp: now,
        resource: 'gpu',
        utilisationPercent: round(maxUtil),
        capacity: 100,
        collector: 'gpu',
        available: true,
        metadata: {
          deviceCount: readings.length,
          devices: readings.map((r) => ({ index: r.index, name: r.name, temperatureC: r.temperatureC })),
        },
      },
      {
        name: 'gpu.memory.utilisation',
        value: round(maxMemUtil),
        unit: 'percent',
        timestamp: now,
        resource: 'gpu-memory',
        utilisationPercent: round(maxMemUtil),
        capacity: totalMemory,
        collector: 'gpu',
        available: true,
        metadata: {
          deviceCount: readings.length,
          totalMemoryMiB: totalMemory,
          usedMemoryMiB: usedMemory,
        },
      },
    ];
  } catch (error) {
    logger.debug(
      `GPU probe failed: ${error instanceof Error ? error.message : String(error)}`
    );
    return unavailableMetrics(now, 'nvidia_smi_error');
  }
}
