/**
 * O unitate fictivă care imită systemd, pentru testele executorului.
 *
 * `systemctl` e un script /bin/sh care se comportă ca un client:
 *   - `start`/`restart` creează un „job”: dacă unitatea nu e deja în
 *     `activating`, pornește procesul unității cu `setsid`, deci într-o sesiune
 *     și un grup de procese proprii, separat de client (ca un copil al lui
 *     PID 1, în cgroup-ul unității). Apoi clientul așteaptă sfârșitul jobului,
 *     ca `systemctl start` fără `--no-block`. Dacă unitatea e deja în
 *     `activating`, clientul se alipește jobului existent, ca systemd;
 *   - `stop` trimite SIGTERM grupului unității, `kill --signal=SIGKILL` trimite
 *     SIGKILL; ambele așteaptă moartea procesului și scriu `inactive dead`;
 *   - `show` tipărește `ActiveState` și `SubState` din fișierul de stare.
 * Procesul unității scrie `inceput`, doarme `delaySec`, apoi scrie `final`
 * (efectul final) și trece unitatea în `inactive dead` (oneshot) sau
 * `failed failed`. O unitate `stubborn` ignoră `stop` și `kill`: oprirea nu
 * se poate confirma.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export interface FakeUnit {
  delaySec?: number;
  fail?: boolean;
  stubborn?: boolean;
}

export interface FakeSystemd {
  systemctl: string;
  calls(): string[];
  markers(): string[];
  state(unit: string): { activeState: string; subState: string };
  setState(unit: string, activeState: string, subState: string): void;
  unitPid(unit: string): number | null;
  processGroup(pid: number): number | null;
  alive(pid: number): boolean;
  killAll(): void;
}

export function createFakeSystemd(dir: string, units: Record<string, FakeUnit>): FakeSystemd {
  const bin = path.join(dir, 'bin');
  const unitsDir = path.join(dir, 'units');
  const trace = path.join(dir, 'urme.log');
  const markers = path.join(dir, 'marcaje.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(unitsDir, { recursive: true });
  for (const [name, unit] of Object.entries(units)) {
    fs.mkdirSync(path.join(unitsDir, name), { recursive: true });
    fs.writeFileSync(
      path.join(unitsDir, `${name}.conf`),
      `DELAY=${unit.delaySec ?? 0}\nFAIL=${unit.fail ? 1 : 0}\nSTUBBORN=${unit.stubborn ? 1 : 0}\n`,
    );
  }
  const common = [
    `D='${dir}'`,
    'U="$D/units/$unit"',
    'mkdir -p "$U"',
    'DELAY=0; FAIL=0; STUBBORN=0',
    '[ -f "$D/units/$unit.conf" ] && . "$D/units/$unit.conf"',
    'setstate() { printf "%s %s\\n" "$1" "$2" > "$U/state.tmp" && mv "$U/state.tmp" "$U/state"; }',
    'getstate() { if [ -f "$U/state" ]; then cat "$U/state"; else echo "inactive dead"; fi; }',
  ];
  const unitScript = path.join(bin, 'unit.sh');
  fs.writeFileSync(
    unitScript,
    [
      '#!/bin/sh',
      'unit=$1',
      ...common,
      'echo $$ > "$U/pid"',
      `echo "inceput $unit $$" >> '${markers}'`,
      'sleep "$DELAY"',
      'if [ "$FAIL" = 1 ]; then echo failed > "$U/result"; rm -f "$U/pid"; setstate failed failed; exit 1; fi',
      `echo "final $unit $$" >> '${markers}'`,
      'echo success > "$U/result"; rm -f "$U/pid"; setstate inactive dead',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const systemctl = path.join(bin, 'systemctl');
  fs.writeFileSync(
    systemctl,
    [
      '#!/bin/sh',
      `echo "apel $*" >> '${trace}'`,
      'verb=$1',
      'unit=""; for a in "$@"; do unit=$a; done',
      ...common,
      'case "$verb" in',
      '  show)',
      '    set -- $(getstate); echo "ActiveState=$1"; echo "SubState=$2"',
      '    echo "MainPID=$(cat "$U/pid" 2>/dev/null || echo 0)"; echo "NRestarts=0"; exit 0 ;;',
      '  start|restart)',
      '    set -- $(getstate)',
      '    if [ "$1" != activating ]; then',
      '      rm -f "$U/result"; setstate activating start',
      `      setsid /bin/sh '${unitScript}' "$unit" </dev/null >/dev/null 2>&1 &`,
      '    fi',
      '    while :; do set -- $(getstate); [ "$1" = activating ] || break; sleep 0.05; done',
      '    r=$(cat "$U/result" 2>/dev/null)',
      '    [ "$r" = success ] && exit 0',
      '    echo "Job for $unit failed or was canceled ($r)" >&2; exit 1 ;;',
      '  stop|kill)',
      '    [ "$STUBBORN" = 1 ] && exit 0',
      '    pid=$(cat "$U/pid" 2>/dev/null)',
      '    sig=TERM; [ "$verb" = kill ] && sig=KILL',
      '    [ -n "$pid" ] && kill -s $sig -- -"$pid" 2>/dev/null',
      '    i=0; while [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null && [ $i -lt 100 ]; do sleep 0.05; i=$((i+1)); done',
      '    rm -f "$U/pid"; echo canceled > "$U/result"; setstate inactive dead; exit 0 ;;',
      'esac',
      'exit 1',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );

  const read = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
  const alive = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const unitPid = (unit: string) => {
    const file = path.join(unitsDir, unit, 'pid');
    if (!fs.existsSync(file)) return null;
    const pid = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  };
  return {
    systemctl,
    calls: () => read(trace),
    markers: () => read(markers),
    state(unit) {
      const file = path.join(unitsDir, unit, 'state');
      const [activeState, subState] = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split(' ') : ['inactive', 'dead'];
      return { activeState, subState };
    },
    setState(unit, activeState, subState) {
      fs.mkdirSync(path.join(unitsDir, unit), { recursive: true });
      fs.writeFileSync(path.join(unitsDir, unit, 'state'), `${activeState} ${subState}\n`);
    },
    unitPid,
    processGroup(pid) {
      try {
        const out = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], { encoding: 'utf8' }).trim();
        return out ? Number(out) : null;
      } catch {
        return null;
      }
    },
    alive,
    killAll() {
      for (const unit of Object.keys(units)) {
        const pid = unitPid(unit);
        if (pid && alive(pid)) {
          try {
            process.kill(-pid, 'SIGKILL');
          } catch {
            /* încheiat deja */
          }
        }
      }
    },
  };
}
