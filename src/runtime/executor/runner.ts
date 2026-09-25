/**
 * Rularea unui plan fix: proces fără shell sau cerere HTTP pe loopback.
 *
 * - `spawn` cu `shell: false`, mediu minim (fără tokenuri, fără `DOCKER_HOST`),
 *   grup de procese propriu, ca oprirea să ajungă și la copiii procesului;
 * - la semnalul de oprire (STOP, revocare, expirarea timpului): SIGTERM pe
 *   grup, apoi SIGKILL după `killGraceMs`;
 * - pentru o actuare `systemd` (D1), oprirea nu se oprește la client: procesul
 *   lansat e numai `systemctl`, care cere lui PID 1 un job, iar efectul rulează
 *   în unitate, în alt grup de procese. La oprire, runner-ul cere și oprirea
 *   unității (`systemctl stop`, apoi `systemctl kill --signal=SIGKILL`, numai
 *   formele din lista albă sudoers) și citește starea ei până când
 *   `ActiveState` confirmă că e inactivă. Rezultatul spune dacă oprirea a fost
 *   confirmată; executorul scrie `interrupted` numai în acest caz;
 * - ieșirea e plafonată; se păstrează numai amprenta ei și un prefix scurt.
 */
import { spawn } from 'node:child_process';
import type { ExecutionPlan, SystemdControl } from './catalog';

export interface HaltReport {
  /** Adevărat numai dacă `ActiveState` a fost citit `inactive` sau `failed` după oprire. */
  confirmed: boolean;
  activeState: string | null;
  subState: string | null;
  steps: Array<{ verb: 'stop' | 'kill'; exitCode: number | null }>;
}

export interface RunResult {
  outcome: 'completed' | 'aborted' | 'timed_out' | 'spawn_failed';
  exitCode: number | null;
  output: string;
  /** Prezent numai când o actuare `systemd` a fost oprită (STOP, revocare sau expirarea timpului). */
  halt?: HaltReport;
}

export type UnitState = { ok: true; activeState: string; subState: string } | { ok: false; reason: string };

/** Stările în care unitatea are un job în curs: nicio actuare nouă nu pornește peste ele (D2). */
export const TRANSITIONAL_STATES: readonly string[] = ['activating', 'deactivating', 'reloading'];
/** Stările care confirmă că efectul unității s-a oprit. */
export const HALTED_STATES: readonly string[] = ['inactive', 'failed'];

export interface RunnerOptions {
  killGraceMs?: number;
  /** Cât așteaptă fiecare comandă de oprire a unității. */
  haltTimeoutMs?: number;
  /** Cât se citește starea după fiecare comandă de oprire, până la confirmare. */
  confirmMs?: number;
  pollMs?: number;
}

export type PlanRunner = (plan: ExecutionPlan, signal: AbortSignal) => Promise<RunResult>;

const OUTPUT_CAP = 64 * 1024;
const MINIMAL_ENV = { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C.UTF-8', SYSTEMD_PAGER: '', SYSTEMD_COLORS: '0' };

/** Rulează o comandă scurtă din lista albă (fără shell, mediu minim) și întoarce codul și ieșirea. */
export function runArgv(argv: string[], timeoutMs: number): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let output = '';
    let timedOut = false;
    let done = false;
    const child = spawn(argv[0], argv.slice(1), { shell: false, env: MINIMAL_ENV, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const collect = (chunk: Buffer) => {
      if (output.length < OUTPUT_CAP) output += chunk.toString('utf8').slice(0, OUTPUT_CAP - output.length);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* încheiat deja */
      }
    }, timeoutMs);
    const end = (exitCode: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ exitCode, output, timedOut });
    };
    child.on('error', (error) => {
      output = String(error.message).slice(0, 500);
      end(null);
    });
    child.on('close', (code) => end(code));
  });
}

const STATE_TOKEN = /^[a-z][a-z-]{0,31}$/;

/** Citește `ActiveState` și `SubState` ale unității, prin forma `systemctl show` din lista albă. */
export async function queryUnitState(control: SystemdControl, timeoutMs = 5_000): Promise<UnitState> {
  const result = await runArgv(control.stateArgv, timeoutMs);
  if (result.timedOut) return { ok: false, reason: 'unit_state_timeout' };
  if (result.exitCode !== 0) return { ok: false, reason: `unit_state_unavailable:${result.exitCode ?? 'fără cod'}` };
  const values: Record<string, string> = {};
  for (const line of result.output.split('\n')) {
    const match = /^(ActiveState|SubState)=(.*)$/.exec(line.trim());
    if (match) values[match[1]] = match[2];
  }
  const activeState = values.ActiveState;
  const subState = values.SubState;
  if (!activeState || !STATE_TOKEN.test(activeState) || !subState || !STATE_TOKEN.test(subState)) return { ok: false, reason: 'unit_state_unparsable' };
  return { ok: true, activeState, subState };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Oprește unitatea însăși și confirmă efectul: după fiecare comandă de oprire
 * (întâi `stop`, apoi `kill --signal=SIGKILL`), citește starea până la
 * `inactive`/`failed` sau până la expirarea ferestrei de confirmare.
 */
export async function haltUnit(control: SystemdControl, options: RunnerOptions = {}): Promise<HaltReport> {
  const haltTimeoutMs = options.haltTimeoutMs ?? 30_000;
  const confirmMs = options.confirmMs ?? 15_000;
  const pollMs = options.pollMs ?? 200;
  const verbs: Array<'stop' | 'kill'> = ['stop', 'kill'];
  const steps: HaltReport['steps'] = [];
  let last: UnitState = { ok: false, reason: 'unit_state_not_read' };
  for (let index = 0; index < control.haltArgv.length; index++) {
    const result = await runArgv(control.haltArgv[index], haltTimeoutMs);
    steps.push({ verb: verbs[index] ?? 'kill', exitCode: result.exitCode });
    const until = Date.now() + confirmMs;
    for (;;) {
      last = await queryUnitState(control);
      if (last.ok && HALTED_STATES.includes(last.activeState)) {
        return { confirmed: true, activeState: last.activeState, subState: last.subState, steps };
      }
      if (Date.now() >= until) break;
      await sleep(pollMs);
    }
  }
  return { confirmed: false, activeState: last.ok ? last.activeState : null, subState: last.ok ? last.subState : null, steps };
}

export function createPlanRunner(options: RunnerOptions = {}): PlanRunner {
  const killGraceMs = options.killGraceMs ?? 2_000;

  return async function run(plan, signal) {
    if (signal.aborted) return { outcome: 'aborted', exitCode: null, output: '' };
    if (plan.kind === 'http_get') return runHttp(plan, signal);

    return new Promise<RunResult>((resolve) => {
      let output = '';
      let settled = false;
      let closed = false;
      let halting: Promise<HaltReport> | null = null;
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
        if (reason || settled || closed) return;
        reason = why;
        // D1: clientul `systemctl` nu e efectul. Oprirea unității pornește
        // imediat și în paralel cu terminarea clientului.
        if (plan.systemd) halting = haltUnit(plan.systemd, options);
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
        closed = true;
        if (!reason) {
          finish({ outcome: 'completed', exitCode: code, output });
          return;
        }
        const why = reason;
        if (!halting) {
          finish({ outcome: why, exitCode: code, output });
          return;
        }
        // Rezultatul se dă numai după confirmarea (sau infirmarea) opririi unității.
        clearTimeout(timer);
        halting.then(
          (halt) => finish({ outcome: why, exitCode: code, output, halt }),
          () => finish({ outcome: why, exitCode: code, output, halt: { confirmed: false, activeState: null, subState: null, steps: [] } }),
        );
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
