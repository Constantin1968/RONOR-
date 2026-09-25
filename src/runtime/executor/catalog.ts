/**
 * Lista albă a executorului: singurele acțiuni pe care le poate face, fiecare
 * cu argumente tipizate și un vocabular închis de verbe.
 *
 * Nicio intrare nu primește text liber care să ajungă într-o linie de comandă:
 * apelantul numește o intrare (`target` / `device`) și un verb, iar executorul
 * construiește singur vectorul de argumente din configurația gazdei. Unitățile
 * care ar da acces la Docker, la rețea sau la sistemul de bază sunt refuzate
 * la încărcarea configurației, nu la execuție.
 */
import path from 'node:path';

export type ActuateCommand = 'restart' | 'start' | 'stop';
const ACTUATE_COMMANDS: readonly ActuateCommand[] = ['restart', 'start', 'stop'];

export interface HttpObserveEntry {
  id: string;
  type: 'ops.observe';
  kind: 'http_get';
  url: string;
  timeout_ms: number;
}

export interface SystemdObserveEntry {
  id: string;
  type: 'ops.observe';
  kind: 'systemd_status';
  unit: string;
  timeout_ms: number;
}

export interface SystemdActuateEntry {
  id: string;
  type: 'ops.actuate';
  kind: 'systemd';
  unit: string;
  commands: ActuateCommand[];
  timeout_ms: number;
}

export type CatalogEntry = HttpObserveEntry | SystemdObserveEntry | SystemdActuateEntry;

export interface ExecutorCatalog {
  host_id: string;
  /** Prefixul fix al comenzii, de exemplu `["/usr/bin/sudo", "-n", "/usr/bin/systemctl"]`. */
  systemctl: string[];
  entries: CatalogEntry[];
}

/**
 * Pentru o actuare `systemd`, procesul lansat (`systemctl start`) e numai
 * clientul care cere lui PID 1 un job; efectul rulează în unitate, în alt grup
 * de procese. Oprirea trebuie să acționeze asupra unității (D1), iar starea ei
 * se citește înainte de actuare (D2) și după oprire, ca confirmare.
 */
export interface SystemdControl {
  unit: string;
  /** `systemctl show --property=ActiveState,SubState -- <unit>` */
  stateArgv: string[];
  /** În ordine: `systemctl stop -- <unit>`, apoi `systemctl kill --signal=SIGKILL -- <unit>`. */
  haltArgv: string[][];
}

export function systemdControl(catalog: Pick<ExecutorCatalog, 'systemctl'>, unitName: string): SystemdControl {
  return {
    unit: unitName,
    stateArgv: [...catalog.systemctl, 'show', '--property=ActiveState,SubState', '--', unitName],
    haltArgv: [
      [...catalog.systemctl, 'stop', '--', unitName],
      [...catalog.systemctl, 'kill', '--signal=SIGKILL', '--', unitName],
    ],
  };
}

export type ExecutionPlan =
  | { kind: 'spawn'; argv: string[]; timeoutMs: number; resource: string; systemd?: SystemdControl }
  | { kind: 'http_get'; url: string; timeoutMs: number; resource: string };

const SAFE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const UNIT = /^[a-z0-9][a-z0-9@._-]{0,80}\.service$/;
/** Unități pe care executorul nu le atinge niciodată, oricum ar fi configurat. */
const FORBIDDEN_UNIT = /^(docker|containerd|podman|ssh|sshd|tailscaled|ufw|nftables|iptables|firewalld|systemd-|dbus|polkit|sudo|cron|getty|user@)/;

function fail(reason: string): never {
  throw new Error(`executor_catalog_invalid:${reason}`);
}

function timeout(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 100 || value > 600_000) fail(`${where}.timeout_ms`);
  return value;
}

function unit(value: unknown, where: string): string {
  if (typeof value !== 'string' || !UNIT.test(value)) fail(`${where}.unit`);
  if (FORBIDDEN_UNIT.test(value)) fail(`${where}.unit_forbidden:${value}`);
  return value;
}

function loopbackUrl(value: unknown, where: string): string {
  if (typeof value !== 'string') fail(`${where}.url`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    fail(`${where}.url`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') fail(`${where}.url_protocol`);
  if (parsed.hostname !== '127.0.0.1' && parsed.hostname !== '[::1]' && parsed.hostname !== 'localhost') fail(`${where}.url_not_loopback`);
  if (parsed.username || parsed.password) fail(`${where}.url_credentials`);
  return parsed.toString();
}

function systemctlPrefix(value: unknown): string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) fail('systemctl');
  const argv = value.map((item) => {
    if (typeof item !== 'string' || item.length === 0 || item.length > 200) fail('systemctl');
    return item;
  });
  if (!path.isAbsolute(argv[0])) fail('systemctl.not_absolute');
  const last = argv[argv.length - 1];
  if (!path.isAbsolute(last) || path.basename(last) !== 'systemctl') fail('systemctl.not_systemctl');
  if (argv.length > 1) {
    if (path.basename(argv[0]) !== 'sudo') fail('systemctl.wrapper_not_sudo');
    if (argv.length !== 3 || argv[1] !== '-n') fail('systemctl.sudo_must_be_non_interactive');
  }
  return argv;
}

/** Validează strict configurația gazdei; orice câmp necunoscut sau în afara politicii o refuză întreagă. */
export function parseExecutorCatalog(raw: unknown): ExecutorCatalog {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('root');
  const root = raw as Record<string, unknown>;
  for (const key of Object.keys(root)) if (!['host_id', 'systemctl', 'entries'].includes(key)) fail(`unknown_key:${key}`);
  if (typeof root.host_id !== 'string' || !SAFE_ID.test(root.host_id)) fail('host_id');
  const prefix = systemctlPrefix(root.systemctl);
  if (!Array.isArray(root.entries) || root.entries.length > 64) fail('entries');
  const seen = new Set<string>();
  const entries = root.entries.map((item, index): CatalogEntry => {
    const where = `entries[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail(where);
    const e = item as Record<string, unknown>;
    if (typeof e.id !== 'string' || !SAFE_ID.test(e.id)) fail(`${where}.id`);
    // Un identificator poate avea o intrare de observare și una de actuare, nu două de același tip.
    const identity = `${String(e.type)}:${e.id}`;
    if (seen.has(identity)) fail(`${where}.id_duplicate`);
    seen.add(identity);
    const allowedKeys: Record<string, string[]> = {
      http_get: ['id', 'type', 'kind', 'url', 'timeout_ms'],
      systemd_status: ['id', 'type', 'kind', 'unit', 'timeout_ms'],
      systemd: ['id', 'type', 'kind', 'unit', 'commands', 'timeout_ms'],
    };
    const keys = allowedKeys[String(e.kind)];
    if (!keys) fail(`${where}.kind`);
    for (const key of Object.keys(e)) if (!keys.includes(key)) fail(`${where}.unknown_key:${key}`);
    if (e.kind === 'http_get') {
      if (e.type !== 'ops.observe') fail(`${where}.type`);
      return { id: e.id, type: 'ops.observe', kind: 'http_get', url: loopbackUrl(e.url, where), timeout_ms: timeout(e.timeout_ms, where) };
    }
    if (e.kind === 'systemd_status') {
      if (e.type !== 'ops.observe') fail(`${where}.type`);
      return { id: e.id, type: 'ops.observe', kind: 'systemd_status', unit: unit(e.unit, where), timeout_ms: timeout(e.timeout_ms, where) };
    }
    if (e.type !== 'ops.actuate') fail(`${where}.type`);
    if (!Array.isArray(e.commands) || e.commands.length < 1) fail(`${where}.commands`);
    const commands = e.commands.map((command) => {
      if (!ACTUATE_COMMANDS.includes(command as ActuateCommand)) fail(`${where}.command:${String(command)}`);
      return command as ActuateCommand;
    });
    return { id: e.id, type: 'ops.actuate', kind: 'systemd', unit: unit(e.unit, where), commands: [...new Set(commands)], timeout_ms: timeout(e.timeout_ms, where) };
  });
  return { host_id: root.host_id, systemctl: prefix, entries };
}

export type PlanResult = { ok: true; plan: ExecutionPlan; entry: CatalogEntry } | { ok: false; reason: string };

/** Transformă o acțiune tipizată (deja admisă de mandat) într-un plan fix, fără text liber. */
export function planAction(catalog: ExecutorCatalog, action: { type: string; args: Record<string, unknown> }): PlanResult {
  if (action.type === 'ops.observe') {
    const entry = catalog.entries.find((e) => e.type === 'ops.observe' && e.id === action.args.target);
    if (!entry) return { ok: false, reason: 'target_not_in_allowlist' };
    if (Object.keys(action.args).length !== 1) return { ok: false, reason: 'unexpected_args' };
    if (entry.kind === 'http_get') {
      return { ok: true, entry, plan: { kind: 'http_get', url: entry.url, timeoutMs: entry.timeout_ms, resource: `observe:${entry.id}` } };
    }
    if (entry.kind === 'systemd_status') {
      return {
        ok: true,
        entry,
        plan: {
          kind: 'spawn',
          argv: [...catalog.systemctl, 'show', '--property=ActiveState,SubState,MainPID,NRestarts', '--', entry.unit],
          timeoutMs: entry.timeout_ms,
          resource: `unit:${entry.unit}`,
        },
      };
    }
    return { ok: false, reason: 'target_not_in_allowlist' };
  }
  if (action.type === 'ops.actuate') {
    const entry = catalog.entries.find((e) => e.type === 'ops.actuate' && e.id === action.args.device);
    if (!entry || entry.kind !== 'systemd') return { ok: false, reason: 'device_not_in_allowlist' };
    if (Object.keys(action.args).length !== 2) return { ok: false, reason: 'unexpected_args' };
    const command = action.args.command as ActuateCommand;
    if (!entry.commands.includes(command)) return { ok: false, reason: 'command_not_in_allowlist' };
    return {
      ok: true,
      entry,
      plan: {
        kind: 'spawn',
        argv: [...catalog.systemctl, command, '--', entry.unit],
        timeoutMs: entry.timeout_ms,
        resource: `unit:${entry.unit}`,
        systemd: systemdControl(catalog, entry.unit),
      },
    };
  }
  return { ok: false, reason: 'type_not_executable' };
}
