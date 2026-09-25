/**
 * Rularea unui plan fix: proces fără shell sau cerere HTTP pe loopback.
 *
 * - `spawn` cu `shell: false`, mediu minim (fără tokenuri, fără `DOCKER_HOST`),
 *   grup de procese propriu, ca oprirea să ajungă și la copiii procesului;
 * - la semnalul de oprire (STOP, revocare, expirarea timpului): SIGTERM pe
 *   grup, apoi SIGKILL după `killGraceMs`;
 * - ieșirea e plafonată; se păstrează numai amprenta ei și un prefix scurt.
 */
import { spawn } from 'node:child_process';
import type { ExecutionPlan } from './catalog';

export interface RunResult {
  outcome: 'completed' | 'aborted' | 'timed_out' | 'spawn_failed';
  exitCode: number | null;
  output: string;
}

export type PlanRunner = (plan: ExecutionPlan, signal: AbortSignal) => Promise<RunResult>;

const OUTPUT_CAP = 64 * 1024;
const MINIMAL_ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' };

export function createPlanRunner(options: { killGraceMs?: number } = {}): PlanRunner {
  const killGraceMs = options.killGraceMs ?? 2_000;

  return async function run(plan, signal) {
    if (signal.aborted) return { outcome: 'aborted', exitCode: null, output: '' };
    if (plan.kind === 'http_get') return runHttp(plan, signal);

    return new Promise<RunResult>((resolve) => {
      let output = '';
      let settled = false;
      let reason: 'aborted' | 'timed_out' | null = null;
      let killTimer: NodeJS.Timeout | null = null;
      const child = spawn(plan.argv[0], plan.argv.slice(1), {
        shell: false,
        env: MINIMAL_ENV,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: true,
      });
      const collect = (chunk: Buffer) => {
        if (output.length < OUTPUT_CAP) output += chunk.toString('utf8').slice(0, OUTPUT_CAP - output.length);
      };
      child.stdout?.on('data', collect);
      child.stderr?.on('data', collect);

      const terminate = (why: 'aborted' | 'timed_out') => {
        if (reason || settled) return;
        reason = why;
        const kill = (sig: NodeJS.Signals) => {
          try {
            if (child.pid) process.kill(-child.pid, sig);
          } catch {
            /* grupul s-a încheiat deja */
          }
        };
        kill('SIGTERM');
        killTimer = setTimeout(() => kill('SIGKILL'), killGraceMs);
      };
      const onAbort = () => terminate('aborted');
      signal.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(() => terminate('timed_out'), plan.timeoutMs);

      const finish = (result: RunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer) clearTimeout(killTimer);
        signal.removeEventListener('abort', onAbort);
        resolve(result);
      };
      child.on('error', (error) => finish({ outcome: 'spawn_failed', exitCode: null, output: String(error.message).slice(0, 500) }));
      child.on('close', (code) => {
        if (reason) finish({ outcome: reason, exitCode: code, output });
        else finish({ outcome: 'completed', exitCode: code, output });
      });
    });
  };
}

async function runHttp(plan: Extract<ExecutionPlan, { kind: 'http_get' }>, signal: AbortSignal): Promise<RunResult> {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal.addEventListener('abort', onAbort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, plan.timeoutMs);
  try {
    const response = await fetch(plan.url, { method: 'GET', redirect: 'manual', signal: controller.signal });
    const body = (await response.text()).slice(0, OUTPUT_CAP);
    return { outcome: 'completed', exitCode: response.status, output: body };
  } catch (error) {
    if (signal.aborted) return { outcome: 'aborted', exitCode: null, output: '' };
    if (timedOut) return { outcome: 'timed_out', exitCode: null, output: '' };
    return { outcome: 'spawn_failed', exitCode: null, output: String((error as Error).message).slice(0, 500) };
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', onAbort);
  }
}
