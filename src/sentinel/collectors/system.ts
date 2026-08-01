/**
 * R-Sentinel — System Collector
 * MIP-013
 *
 * Probes the host substrate using Node.js built-ins only:
 *   · RAM      — os.totalmem() / os.freemem()
 *   · CPU      — os.cpus() delta sampling + os.loadavg() fallback
 *   · Storage  — `df -k` via child_process (POSIX), degrades gracefully
 *
 * Every probe is defensive: a failed probe yields a metric with
 * `available: false` rather than throwing, so the Sentinel loop never
 * destabilises the runtime it is observing.
 */

import os from 'os';
import { execFile } from 'child_process';
import { createLogger } from '../../utils/logger';
import type { ResourceMetric } from '../../planes/r-sentinel/types';

const logger = createLogger('Sentinel:Collector:System');

const STORAGE_MOUNT = process.env.SENTINEL_STORAGE_MOUNT || '/';
const DF_TIMEOUT_MS = parseInt(process.env.SENTINEL_DF_TIMEOUT_MS || '2000', 10);

interface CpuSnapshot {
  idle: number;
  total: number;
}

let previousCpuSnapshot: CpuSnapshot | null = null;

function cpuSnapshot(): CpuSnapshot {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function round(value: number, dp = 2): number {
  const factor = 10 ** dp;
  return Math.round(value * factor) / factor;
}

/** RAM utilisation from os.totalmem() / os.freemem(). */
export function collectRam(now: Date = new Date()): ResourceMetric {
  const total = os.totalmem();
  const free = os.freemem();
  const used = Math.max(0, total - free);
  const utilisation = total > 0 ? clampPercent((used / total) * 100) : 0;

  return {
    name: 'ram.utilisation',
    value: round(utilisation),
    unit: 'percent',
    timestamp: now,
    resource: 'ram',
    utilisationPercent: round(utilisation),
    capacity: total,
    collector: 'system',
    available: true,
    metadata: { totalBytes: total, freeBytes: free, usedBytes: used },
  };
}

/**
 * CPU utilisation. The first invocation has no prior snapshot, so it falls
 * back to a normalised 1-minute load average; subsequent invocations use the
 * exact idle/total tick delta between polls.
 */
export function collectCpu(now: Date = new Date()): ResourceMetric {
  const snapshot = cpuSnapshot();
  const cores = Math.max(1, os.cpus().length);
  let utilisation: number;
  let method: 'tick-delta' | 'loadavg';

  if (previousCpuSnapshot && snapshot.total > previousCpuSnapshot.total) {
    const idleDelta = snapshot.idle - previousCpuSnapshot.idle;
    const totalDelta = snapshot.total - previousCpuSnapshot.total;
    utilisation = clampPercent((1 - idleDelta / totalDelta) * 100);
    method = 'tick-delta';
  } else {
    const [oneMinute] = os.loadavg();
    utilisation = clampPercent((oneMinute / cores) * 100);
    method = 'loadavg';
  }

  previousCpuSnapshot = snapshot;

  return {
    name: 'cpu.utilisation',
    value: round(utilisation),
    unit: 'percent',
    timestamp: now,
    resource: 'cpu',
    utilisationPercent: round(utilisation),
    capacity: 100,
    collector: 'system',
    available: true,
    metadata: { cores, loadAverage: os.loadavg(), method },
  };
}

/** Reset the CPU delta baseline (used by tests and on plane restart). */
export function resetCpuBaseline(): void {
  previousCpuSnapshot = null;
}

function runDf(mount: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('df', ['-k', mount], { timeout: DF_TIMEOUT_MS }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Parse `df -k` output into a utilisation percentage plus raw block counts. */
export function parseDfOutput(stdout: string): {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  utilisationPercent: number;
} | null {
  const lines = stdout
    .trim()
    .split('\n')
    .filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;

  // The data row may wrap onto a second line for long device names; join and
  // take the trailing numeric columns.
  const columns = lines.slice(1).join(' ').trim().split(/\s+/);
  const numeric = columns.filter((c) => /^\d+$/.test(c)).map((c) => parseInt(c, 10));
  if (numeric.length < 3) return null;

  const [totalBlocks, usedBlocks, availableBlocks] = numeric;
  const totalBytes = totalBlocks * 1024;
  const usedBytes = usedBlocks * 1024;
  const availableBytes = availableBlocks * 1024;
  const denominator = usedBytes + availableBytes;
  const utilisationPercent =
    denominator > 0 ? clampPercent((usedBytes / denominator) * 100) : 0;

  return { totalBytes, usedBytes, availableBytes, utilisationPercent };
}

/** Storage utilisation for the configured mount point via `df -k`. */
export async function collectStorage(
  mount: string = STORAGE_MOUNT,
  now: Date = new Date()
): Promise<ResourceMetric> {
  try {
    const stdout = await runDf(mount);
    const parsed = parseDfOutput(stdout);
    if (!parsed) throw new Error('unparsable df output');

    return {
      name: 'storage.utilisation',
      value: round(parsed.utilisationPercent),
      unit: 'percent',
      timestamp: now,
      resource: 'storage',
      utilisationPercent: round(parsed.utilisationPercent),
      capacity: parsed.totalBytes,
      collector: 'system',
      available: true,
      metadata: {
        mount,
        totalBytes: parsed.totalBytes,
        usedBytes: parsed.usedBytes,
        availableBytes: parsed.availableBytes,
      },
    };
  } catch (error) {
    logger.debug(
      `Storage probe unavailable for ${mount}: ${error instanceof Error ? error.message : String(error)}`
    );
    return {
      name: 'storage.utilisation',
      value: 0,
      unit: 'percent',
      timestamp: now,
      resource: 'storage',
      utilisationPercent: 0,
      collector: 'system',
      available: false,
      metadata: { mount, reason: 'df_unavailable' },
    };
  }
}

/** Collect the full system metric set (RAM, CPU, storage). */
export async function collectSystemMetrics(now: Date = new Date()): Promise<ResourceMetric[]> {
  const [storage] = await Promise.all([collectStorage(STORAGE_MOUNT, now)]);
  return [collectRam(now), collectCpu(now), storage];
}
