/**
 * RONOR Operator — acțiuni tipizate (schelet Tranșa 1)
 * ────────────────────────────────────────────────────
 * Înlocuiește filtrarea de text din `effect-policy.ts` cu operații tipizate.
 * Regula G1.1: tipul efectiv al operației decide, niciodată textul comenzii.
 * Un `repo.read` nu poate deveni scriere/comitere/ștergere indiferent de formă
 * (direct, via `python -c`, via cale spre secrete).
 *
 * Acest modul NU execută nimic. Doar evaluează: ALLOWED sau DENIED cu motiv.
 * Execuția aparține sandbox-ului + supervisorului (altă tranșă).
 */

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

export interface TypedOperatorAction {
  type: OperatorActionType;
  args: Record<string, unknown>;
}

export type OperatorDecision =
  | { allowed: true; reason: 'typed_action_permitted' }
  | { allowed: false; reason: string };

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/;
const MAX_ARGS_BYTES = 8_000;

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
  [/python\d?\s+-c\b/i, 'interpreter_escape_forbidden'],
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
  switch (type) {
    case 'ops.observe': {
      if (typeof args.target !== 'string' || args.target.length < 1 || args.target.length > 300) return 'invalid_args';
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
      if (typeof args.device !== 'string' || args.device.length < 1 || args.device.length > 120) return 'invalid_args';
      if (typeof args.command !== 'string' || args.command.length < 1 || args.command.length > 120) return 'invalid_args';
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
 * `allowed` = tipurile delegate explicit prin mandat (niciodată text liber).
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
