import type { AutomationAction } from './contracts';
import { relativeEscapeIsSearchPattern } from './workspace-escape';
import type { EffectDiagnostics, EffectRule, MatchLocus } from './effect-diagnostics';
export type { EffectDiagnostics, MatchLocus } from './effect-diagnostics';

/**
 * Where a forbidden pattern was found inside the pending action, using a
 * structural field-name heuristic, not proof of execution safety.
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

/**
 * The segment holding a matched index, and the index rebased inside it.
 *
 * The escape analysis needs the worker's own field, not the joined scan text:
 * a command must be read as the worker wrote it, without a neighbouring field
 * appearing to continue it.
 */
function segmentAt(parts: Segment[], index: number): { text: string; offset: number; locus: MatchLocus } | null {
  let start = 0;
  for (const part of parts) {
    const end = start + part.text.length;
    if (index >= start && index < end) return { text: part.text, offset: index - start, locus: part.locus };
    start = end + 1; // the single separator character introduced by the join
  }
  return null;
}

/** Classify the full matched span, ignoring only synthetic join separators. */
function locusAt(parts: Segment[], index: number, length: number): MatchLocus | null {
  let start = 0;
  let locus: MatchLocus | null = null;
  const matchEnd = index + length;
  for (const part of parts) {
    const end = start + part.text.length;
    if (start < matchEnd && end > index && part.text.length > 0) {
      if (locus !== null && locus !== part.locus) return 'other';
      locus = part.locus;
    }
    if (end >= matchEnd) break;
    start = end + 1; // the single separator character introduced by the join
  }
  return locus;
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
  const diagnose = (rule: EffectRule | null, scannedChars: number, matchIndex: number | null, matchLocus: MatchLocus | null = null): EffectDiagnostics => ({
    rule, scanned_actions: actions.length, scanned_chars: scannedChars, match_index: matchIndex, match_locus: matchLocus,
  });
  if (actions.length < 1) return { allowed: false, reason: 'pending_action_missing', diagnostics: diagnose(null, 0, null) };
  const parts = segments(actions);
  const text = parts.map((part) => part.text).join('\n');
  if (text.length > 128_000) return { allowed: false, reason: 'pending_action_oversized', diagnostics: diagnose(null, text.length, null) };

  const checks: Array<[RegExp, EffectRule]> = [
    [/\bgit\s+(?:-\S+\s+)*push\b/i, 'git_push_forbidden'],
    [/\bgit\s+remote\s+(?:add|set-url|rename|remove)\b/i, 'git_remote_mutation_forbidden'],
    [/(?:169\.254\.169\.254|metadata\.google\.internal|100\.100\.100\.200)/i, 'cloud_metadata_forbidden'],
    [/(?:https?:\/\/)?(?:10(?:\.\d{1,3}){3}|127(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})\b/i, 'private_network_forbidden'],
    // Absolute escapes and a relative traversal are the same rule, split into two
    // patterns because only the relative one can be a search pattern rather than a
    // path. An absolute escape is refused wherever it appears, including inside a
    // search pattern, so no exemption reaches it.
    [/(?:^|[\s"'=:])(?:~\/|\/etc(?:\/|\b)|\/root(?:\/|\b)|\/home(?:\/|\b)|\/var\/run(?:\/|\b)|[A-Za-z]:\\)/im, 'workspace_escape_forbidden'],
    [/(?:^|[\s"'=:])(?:\.\.\/|\.\.\\)/gim, 'workspace_escape_forbidden'],
    [/\b(?:curl|wget|ftp|sftp|scp|ssh|nc|ncat|telnet|Invoke-WebRequest|Invoke-RestMethod)\b/i, 'network_client_forbidden'],
    [/\b(?:sudo|su)\b/i, 'privilege_escalation_forbidden'],
    [/\b(?:rm\s+-rf|mkfs|shutdown|reboot|poweroff)\b/i, 'destructive_command_forbidden'],
  ];
  for (const [pattern, reason] of checks) {
    if (!pattern.global) {
      const match = pattern.exec(text);
      if (match) return { allowed: false, reason, diagnostics: diagnose(reason, text.length, match.index, locusAt(parts, match.index, match[0].length)) };
      continue;
    }
    // A global pattern is scanned to exhaustion: an exempt occurrence must never
    // hide a later refusable one, so every occurrence is judged on its own.
    pattern.lastIndex = 0;
    for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
      const locus = locusAt(parts, match.index, match[0].length);
      // The pattern captures one leading delimiter, which may be whitespace and
      // therefore outside every token. The traversal itself is what must be located.
      const traversal = match.index + match[0].indexOf('..');
      const segment = segmentAt(parts, traversal);
      const exempt = locus === 'command' && segment !== null
        && relativeEscapeIsSearchPattern(segment.text, segment.offset);
      if (!exempt) {
        return { allowed: false, reason, diagnostics: diagnose(reason, text.length, match.index, locus) };
      }
      if (pattern.lastIndex <= match.index) pattern.lastIndex = match.index + 1;
    }
  }
  if (allowedActions.some((action) => ['external_send', 'secrets_read', 'main_write', 'push', 'merge', 'release', 'deploy', 'financial_action', 'destructive_action'].includes(action))) {
    return { allowed: false, reason: 'consequential_capability_forbidden', diagnostics: diagnose(null, text.length, null) };
  }
  if (!allowedActions.some((action) => ['read_repo', 'create_branch', 'edit_worktree', 'run_tests', 'commit_local', 'prepare_draft_pr'].includes(action))) {
    return { allowed: false, reason: 'no_effect_capability', diagnostics: diagnose(null, text.length, null) };
  }
  return { allowed: true, reason: 'within_isolated_mandate', diagnostics: diagnose(null, text.length, null) };
}
