import type { AutomationAction } from './contracts';

/**
 * Refusal diagnostics. Carries only the identifier of the rule that matched,
 * three numbers and one closed enumeration, never any part of the scanned text:
 * no matched substring, no path, no command, no model prose, no object key from
 * the payload. A credential cannot travel in this object.
 */
export interface EffectDiagnostics {
  rule: string | null;
  scanned_actions: number;
  scanned_chars: number;
  match_index: number | null;
  match_locus: MatchLocus | null;
}

/**
 * Where a forbidden pattern was found inside the pending action.
 *
 * `command` is a field the worker proposes to execute. `content` is a field the
 * worker proposes to write into a file. `other` is any remaining field.
 *
 * This is a known blind spot of the scanner, recorded rather than silently
 * worked around: the scan admits no distinction between the two, so a forbidden
 * token appearing only inside file content is refused exactly like a command.
 * That produces false refusals, including on the maintenance of this policy's
 * own tests, whose fixtures necessarily contain forbidden commands.
 *
 * The locus is deliberately diagnostic only. Refusing content-borne matches is
 * not a false guarantee: a file written today can be executed tomorrow by a
 * test, a hook or a build step, so a content-borne token is not provably
 * harmless and must not become an allowance without a deliberate decision and
 * a containment argument that does not exist yet. Recording where the match sat
 * supplies the evidence for that decision without pre-empting it.
 */
export type MatchLocus = 'command' | 'content' | 'other';

export interface EffectDecision { allowed: boolean; reason: string; diagnostics?: EffectDiagnostics; }

/** Fields a worker proposes to execute. */
const COMMAND_KEYS = new Set(['command', 'cmd', 'code', 'args', 'argv', 'script', 'shell', 'keystrokes', 'entrypoint']);
/** Fields a worker proposes to write into a file, or prose it merely uttered. */
const CONTENT_KEYS = new Set(['content', 'file_text', 'new_str', 'old_str', 'text', 'diff', 'patch', 'body', 'thought', 'message', 'summary']);

interface Segment { text: string; locus: MatchLocus; }

/**
 * Flatten the strings of a pending action, tagging each with the locus of the
 * field it came from. The traversal order and its depth and count limits are
 * those of the original scan, so the joined text is byte-identical and no
 * decision changes: only the tags are new. A locus is inherited by nested
 * values, because the content of a command's argument list is still a command.
 */
function segments(value: unknown, locus: MatchLocus = 'other', output: Segment[] = [], depth = 0): Segment[] {
  if (depth > 8 || output.length > 500) return output;
  if (typeof value === 'string') output.push({ text: value, locus });
  else if (Array.isArray(value)) for (const item of value) segments(item, locus, output, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const lowered = key.toLowerCase();
      // Only a fixed enumeration leaves this function; the key itself never does.
      const nested: MatchLocus = COMMAND_KEYS.has(lowered) ? 'command' : CONTENT_KEYS.has(lowered) ? 'content' : locus;
      segments(item, nested, output, depth + 1);
    }
  }
  return output;
}

/** Locate the segment holding a match offset in the joined text. */
function locusAt(parts: Segment[], index: number): MatchLocus | null {
  let start = 0;
  for (const part of parts) {
    const end = start + part.text.length;
    if (index >= start && index < end) return part.locus;
    start = end + 1; // the single separator character introduced by the join
  }
  return null;
}

/** Evaluate pending OpenHands actions, never observations or model prose. */
export function evaluateOpenHandsEffects(events: unknown, allowedActions: AutomationAction[]): EffectDecision {
  const record = events && typeof events === 'object' ? events as Record<string, unknown> : {};
  const items = Array.isArray(record.items) ? record.items : Array.isArray(events) ? events : [];
  const actions = items.filter((item) => {
    if (!item || typeof item !== 'object') return false;
    const event = item as Record<string, unknown>;
    const kind = String(event.kind ?? event.type ?? '').toLowerCase();
    return kind.includes('action') && !kind.includes('observation');
  });
  const diagnose = (rule: string | null, scannedChars: number, matchIndex: number | null, matchLocus: MatchLocus | null = null): EffectDiagnostics => ({
    rule, scanned_actions: actions.length, scanned_chars: scannedChars, match_index: matchIndex, match_locus: matchLocus,
  });
  if (actions.length < 1) return { allowed: false, reason: 'pending_action_missing', diagnostics: diagnose(null, 0, null) };
  const parts = segments(actions);
  const text = parts.map((part) => part.text).join('\n');
  if (text.length > 128_000) return { allowed: false, reason: 'pending_action_oversized', diagnostics: diagnose(null, text.length, null) };

  const checks: Array<[RegExp, string]> = [
    [/\bgit\s+(?:-\S+\s+)*push\b/i, 'git_push_forbidden'],
    [/\bgit\s+remote\s+(?:add|set-url|rename|remove)\b/i, 'git_remote_mutation_forbidden'],
    [/(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200)/i, 'cloud_metadata_forbidden'],
    [/(?:https?:\/\/)?(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/i, 'private_network_forbidden'],
    [/(?:^|[\s"'=:])(?:\.\.\/|\.\.\\|~\/|\/etc(?:\/|\b)|\/root(?:\/|\b)|\/home(?:\/|\b)|\/var\/run(?:\/|\b)|[A-Za-z]:\\)/im, 'workspace_escape_forbidden'],
    [/\b(?:curl|wget|ftp|sftp|scp|ssh|nc|ncat|telnet|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'network_client_forbidden'],
    [/\b(?:sudo|su)\b/i, 'privilege_escalation_forbidden'],
    [/\b(?:rm\s+-rf|mkfs|shutdown|reboot|poweroff)\b/i, 'destructive_command_forbidden'],
  ];
  for (const [pattern, reason] of checks) {
    const match = pattern.exec(text);
    if (match) return { allowed: false, reason, diagnostics: diagnose(reason, text.length, match.index, locusAt(parts, match.index)) };
  }
  if (allowedActions.some((action) => ['external_send', 'secrets_read', 'main_write', 'push', 'merge', 'release', 'deploy', 'financial_action', 'destructive_action'].includes(action))) {
    return { allowed: false, reason: 'consequential_capability_forbidden', diagnostics: diagnose(null, text.length, null) };
  }
  if (!allowedActions.some((action) => ['read_repo', 'create_branch', 'edit_worktree', 'run_tests', 'commit_local', 'prepare_draft_pr'].includes(action))) {
    return { allowed: false, reason: 'no_effect_capability', diagnostics: diagnose(null, text.length, null) };
  }
  return { allowed: true, reason: 'within_isolated_mandate', diagnostics: diagnose(null, text.length, null) };
}
