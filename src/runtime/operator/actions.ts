/**
 * RONOR Operator — acțiuni tipizate (schelet Tranșa 1)
 * ────────────────────────────────────────────────────
 * Înlocuiește filtrarea de text din `effect-policy.ts` cu operații tipizate.
 * Regula G1.1: tipul efectiv al operației decide, niciodată textul comenzii.
 * Un `repo.read` nu poate deveni scriere/comitere/ștergere indiferent de formă
 * (direct, via `python -c`, via cale spre secrete).
 *
 * Trei straturi, în ordine:
 *   1. tipul trebuie să fie delegat de mandat (`operatorTypesFromMandate`);
 *   2. argumentele sunt o listă albă pe tip: orice cheie necunoscută e refuzată
 *      (`unknown_arg:<cheie>`), deci un `repo.read` nu poate purta un `cmd`;
 *   3. modelele interzise rămân ca plasă de siguranță pe textul liber permis
 *      (mesaj de comitere, text de notificare), inclusiv interpretoarele cu cod
 *      în linie (`node -e`, `bash -c`, `sh -c`, `perl -e`, `python3 -c`,
 *      `python3.11 -c` și orice `pythonX.Y -c`, `ruby -e`, `php -r`).
 *
 * Acest modul NU execută nimic. Doar evaluează: ALLOWED sau DENIED cu motiv.
 * Execuția aparține sandbox-ului + supervisorului (altă tranșă).
 */

import type { AutomationAction, ExecutionMandate } from '../automation/contracts';

export const OPERATOR_ACTION_TYPES = [
  'ops.observe',
  'repo.read',
  'repo.edit',
  'tests.run',
  'vcs.commit_local',
  'ops.actuate',
  'notify.send',
] as const;

export type OperatorActionType = (typeof OPERATOR_ACTION_TYPES)[number];

/**
 * Corespondența tip operator → acțiune de mandat. Un tip fără corespondent
 * (`null`) nu poate fi delegat de vocabularul mandatului (`AUTOMATION_ACTIONS`)
 * și este deci refuzat întotdeauna. `ops.observe` și `ops.actuate` au acum
 * acțiuni proprii (`ops_observe`, `ops_actuate`); execuția lor aparține numai
 * executorului cu mandat (`src/runtime/executor`), iar `ops.actuate` cere în
 * plus o aprobare legată de hash-ul acțiunii și cu expirare.
 */
export const OPERATOR_TYPE_MANDATE_ACTION: Readonly<Record<OperatorActionType, AutomationAction | null>> = {
  'ops.observe': 'ops_observe',
  'repo.read': 'read_repo',
  'repo.edit': 'edit_worktree',
  'tests.run': 'run_tests',
  'vcs.commit_local': 'commit_local',
  'ops.actuate': 'ops_actuate',
  'notify.send': 'external_send',
};

/**
 * Tipurile permise, derivate numai din mandat: acțiunea corespondentă trebuie
 * să fie în `allowed_actions` și să nu fie în `denied_actions`.
 */
export function operatorTypesFromMandate(
  mandate: Pick<ExecutionMandate, 'allowed_actions' | 'denied_actions'>,
): OperatorActionType[] {
  const allowed = Array.isArray(mandate.allowed_actions) ? mandate.allowed_actions : [];
  const denied = Array.isArray(mandate.denied_actions) ? mandate.denied_actions : [];
  return OPERATOR_ACTION_TYPES.filter((type) => {
    const action = OPERATOR_TYPE_MANDATE_ACTION[type];
    return action !== null && allowed.includes(action) && !denied.includes(action);
  });
}

/** Lista albă de argumente pe tip. Orice altă cheie e refuzată. */
const ALLOWED_ARG_KEYS: Readonly<Record<OperatorActionType, readonly string[]>> = {
  'ops.observe': ['target'],
  'repo.read': ['path'],
  'repo.edit': ['path', 'diffHash'],
  'tests.run': ['suiteId'],
  'vcs.commit_local': ['message'],
  'ops.actuate': ['device', 'command'],
  'notify.send': ['channel', 'text'],
};

export interface TypedOperatorAction {
  type: OperatorActionType;
  args: Record<string, unknown>;
}

export type OperatorDecision =
  | { allowed: true; reason: 'typed_action_permitted' }
  | { allowed: false; reason: string };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_ARGS_BYTES = 8_000;

/**
 * Interpretoare cu cod în linie. Numele poate avea cale (`/usr/bin/python3`),
 * poate fi urmat de alte opțiuni, iar opțiunea de cod poate fi grupată
 * (`bash -lc`, `python3 -Ic`, `perl -ne`).
 */
const OPTS = String.raw`(?:\s+-{1,2}[\w=.-]*)*?`;
const INLINE_INTERPRETER_PATTERNS: RegExp[] = [
  // python, python3, python3.11 și orice pythonX.Y: -c
  new RegExp(String.raw`(?:^|[^\w.-])python(?:\d+(?:\.\d+)*)?` + OPTS + String.raw`\s+-[A-Za-z]*c(?![\w-])`, 'i'),
  // node / nodejs: -e, -p, --eval, --print
  new RegExp(String.raw`(?:^|[^\w.-])node(?:js)?` + OPTS + String.raw`\s+(?:-[A-Za-z]*[ep](?![\w-])|--(?:eval|print)\b)`, 'i'),
  // bash, sh, dash, zsh, ksh: -c
  new RegExp(String.raw`(?:^|[^\w.-])(?:ba|da|z|k)?sh` + OPTS + String.raw`\s+-[A-Za-z]*c[A-Za-z]*(?![\w-])`, 'i'),
  // perl: -e, -E
  new RegExp(String.raw`(?:^|[^\w.-])perl(?:\d+(?:\.\d+)*)?` + OPTS + String.raw`\s+-[A-Za-z]*e(?![\w-])`, 'i'),
  // ruby: -e
  new RegExp(String.raw`(?:^|[^\w.-])ruby(?:\d+(?:\.\d+)*)?` + OPTS + String.raw`\s+-[A-Za-z]*e(?![\w-])`, 'i'),
  // php, php8.3: -r
  new RegExp(String.raw`(?:^|[^\w.-])php(?:\d+(?:\.\d+)*)?` + OPTS + String.raw`\s+-[A-Za-z]*r(?![\w-])`, 'i'),
];

/** Modele textuale care nu au ce căuta în argumentele unei acțiuni tipizate. */
const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bgit\s+(?:-\S+\s+)*push\b/i, 'git_push_forbidden'],
  [/\bgit\s+remote\s+(?:add|set-url|rename|remove)\b/i, 'git_remote_mutation_forbidden'],
  [/(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200)/i, 'cloud_metadata_forbidden'],
  [/(?:https?:\/\/)?(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/i, 'private_network_forbidden'],
  [/(?:^|[\s"'=:])(?:\.\.\/|\.\.\\|~\/|\/etc(?:\/|\b)|\/root(?:\/|\b)|\/home(?:\/|\b)|\/var\/run(?:\/|\b)|\/run\/secrets(?:\/|\b)|[A-Za-z]:\\)/im, 'workspace_escape_forbidden'],
  [/\b(?:curl|wget|ftp|sftp|scp|ssh|nc|ncat|telnet|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'network_client_forbidden'],
  [/\b(?:sudo|su)\b/i, 'privilege_escalation_forbidden'],
  [/\b(?:rm\s+-rf|mkfs|shutdown|reboot|poweroff)\b/i, 'destructive_command_forbidden'],
  [/\/run\/secrets/i, 'secrets_path_forbidden'],
  ...INLINE_INTERPRETER_PATTERNS.map((pattern): [RegExp, string] => [pattern, 'interpreter_inline_code_forbidden']),
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringsOf(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 8 || out.length > 200) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsOf(item, out, depth + 1);
  else if (value && typeof value === 'object')
    for (const item of Object.values(value as Record<string, unknown>)) stringsOf(item, out, depth + 1);
  return out;
}

function checkForbidden(args: Record<string, unknown>): string | null {
  const texts = stringsOf(args);
  const joined = texts.join('\n');
  if (Buffer.byteLength(joined, 'utf8') > MAX_ARGS_BYTES) return 'args_oversized';
  if (joined.includes('\0')) return 'args_nul_byte_forbidden';
  for (const text of texts) {
    for (const [pattern, reason] of FORBIDDEN_PATTERNS) {
      if (pattern.test(text)) return reason;
    }
  }
  return null;
}

function isRelativeSafePath(path: unknown): boolean {
  if (typeof path !== 'string' || path.length < 1 || path.length > 500) return false;
  if (path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:\\/.test(path)) return false;
  if (path === '..' || path.startsWith('../') || path.includes('/../') || path.includes('..\\')) return false;
  return true;
}

function validateArgs(type: OperatorActionType, args: Record<string, unknown>): string | null {
  const permittedKeys = ALLOWED_ARG_KEYS[type];
  for (const key of Object.keys(args)) {
    if (!permittedKeys.includes(key)) return `unknown_arg:${key.slice(0, 60)}`;
  }
  switch (type) {
    case 'ops.observe': {
      // Identificator din lista albă a executorului, nu o adresă sau o comandă.
      if (typeof args.target !== 'string' || !SAFE_ID.test(args.target)) return 'invalid_args';
      return null;
    }
    case 'repo.read': {
      if (!isRelativeSafePath(args.path)) return 'invalid_args';
      return null;
    }
    case 'repo.edit': {
      if (!isRelativeSafePath(args.path)) return 'invalid_args';
      if (args.diffHash !== undefined && (typeof args.diffHash !== 'string' || args.diffHash.length > 128)) return 'invalid_args';
      return null;
    }
    case 'tests.run': {
      if (typeof args.suiteId !== 'string' || !SAFE_ID.test(args.suiteId)) return 'invalid_args';
      return null;
    }
    case 'vcs.commit_local': {
      if (typeof args.message !== 'string' || args.message.length < 1 || args.message.length > 500) return 'invalid_args';
      return null;
    }
    case 'ops.actuate': {
      // `device` e un identificator din lista albă a executorului, iar `command`
      // un verb din vocabularul închis al acelei intrări; niciodată o linie de comandă.
      if (typeof args.device !== 'string' || !SAFE_ID.test(args.device)) return 'invalid_args';
      if (typeof args.command !== 'string' || !SAFE_ID.test(args.command)) return 'invalid_args';
      return null;
    }
    case 'notify.send': {
      if (typeof args.channel !== 'string' || args.channel.length < 1 || args.channel.length > 120) return 'invalid_args';
      if (typeof args.text !== 'string' || args.text.length < 1 || args.text.length > 2_000) return 'invalid_args';
      return null;
    }
  }
}

export function isOperatorActionType(value: unknown): value is OperatorActionType {
  return typeof value === 'string' && (OPERATOR_ACTION_TYPES as readonly string[]).includes(value);
}

/**
 * Evaluează o acțiune tipizată în raport cu capabilitățile mandatului.
 * `allowed` = tipurile delegate explicit prin mandat (niciodată text liber);
 * în bucla operatorului vine numai din `operatorTypesFromMandate(mandate)`.
 */
export function evaluateTypedOperatorAction(
  action: unknown,
  allowed: readonly OperatorActionType[],
): OperatorDecision {
  if (!isRecord(action)) return { allowed: false, reason: 'action_malformed' };
  const { type, args } = action as { type?: unknown; args?: unknown };
  if (!isOperatorActionType(type)) return { allowed: false, reason: 'unknown_action_type' };
  if (!isRecord(args)) return { allowed: false, reason: 'invalid_args' };
  if (!allowed.includes(type)) return { allowed: false, reason: `action_not_allowed:${type}` };
  const invalid = validateArgs(type, args);
  if (invalid) return { allowed: false, reason: invalid };
  const forbidden = checkForbidden(args);
  if (forbidden) return { allowed: false, reason: forbidden };
  return { allowed: true, reason: 'typed_action_permitted' };
}
