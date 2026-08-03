/**
 * RONOR Runtime — L0 · Input Sanitisation and Injection Screening
 * ─────────────────────────────────────────────────────────────
 * What this module does and, more importantly, what it does NOT claim to do.
 *
 * IT DOES:
 *   · Enforce hard structural limits — length, encoding, control characters —
 *     which are the only guarantees that are actually guarantees.
 *   · Strip characters that corrupt logs and audit records: NUL bytes, ANSI
 *     escape sequences, bidirectional-override codepoints. The last of these is
 *     the Trojan Source class of attack, where a reviewer reads one instruction
 *     and the model receives another.
 *   · SCORE the input against known injection patterns and return a verdict of
 *     clean, suspicious or hostile, with the matched rules named.
 *
 * IT DOES NOT:
 *   · Claim to prevent prompt injection. Pattern matching on natural language is
 *     a speed bump, not a boundary. The real controls are elsewhere in the
 *     architecture: retrieved evidence is delimited with an unpredictable nonce
 *     by the knowledge plane, tools are allow-listed, and MI9 Gate governs
 *     consequential actions regardless of what any model was persuaded to say.
 *     A module that overstated its protection would encourage exactly the
 *     misplaced trust that makes injection effective.
 *
 * The default posture is therefore to FLAG AND PROCEED for suspicious input,
 * recording the finding in the provenance record, and to REFUSE only the
 * unambiguous cases. Blocking on suspicion would make the runtime unusable for
 * its actual subject matter — an analyst legitimately needs to ask "what does
 * this phishing email instruct the recipient to do".
 *
 * Prepared by AMB.
 */

export type InjectionVerdict = 'clean' | 'suspicious' | 'hostile';

export interface SanitisationResult {
  ok: boolean;
  /** Cleaned text, safe to log and to embed in a prompt. */
  text: string;
  verdict: InjectionVerdict;
  /** Names of the rules that matched, for the provenance record. */
  findings: string[];
  /** Populated when `ok` is false. */
  refusalReason: string | null;
  /** Characters removed by structural cleaning. */
  removedChars: number;
  originalLength: number;
}

export const MAX_QUERY_CHARS = 100_000;
export const MAX_FIELD_CHARS = 4_000;

/**
 * Patterns that are hostile in effect rather than merely suspicious in tone.
 *
 * Kept short on purpose. A long list of clever regexes produces false positives
 * on legitimate analytical work and creates the illusion of coverage; these
 * three classes are the ones where a match is almost never innocent.
 */
const HOSTILE_RULES: Array<{ rule: string; pattern: RegExp }> = [
  {
    // Attempts to exfiltrate the operating instructions themselves.
    rule: 'H1_SYSTEM_PROMPT_EXFILTRATION',
    pattern:
      /\b(?:reveal|print|repeat|output|show|disclose)\b[^.]{0,40}\b(?:your|the)\b[^.]{0,20}\b(?:system prompt|initial instructions|system message)\b/i,
  },
  {
    // Attempts to have the model impersonate the governance layer.
    rule: 'H2_GOVERNANCE_IMPERSONATION',
    pattern:
      /\b(?:mi9|mi-9)\b[^.]{0,30}\b(?:approved|bypass|disabled|override)\b|\bgovernance\b[^.]{0,20}\b(?:disabled|bypassed|off)\b/i,
  },
  {
    // Encoded payload delivery, which has no legitimate use in a query field.
    rule: 'H3_ENCODED_PAYLOAD',
    pattern: /\b(?:base64|rot13|hex)\s*(?:decode|decoded)\b[^.]{0,30}\b(?:and|then)\b[^.]{0,20}\b(?:execute|run|follow)\b/i,
  },
];

/** Patterns worth recording but not worth refusing. */
const SUSPICIOUS_RULES: Array<{ rule: string; pattern: RegExp }> = [
  { rule: 'S1_INSTRUCTION_OVERRIDE', pattern: /\bignore\b[^.]{0,30}\b(?:previous|prior|above|all)\b[^.]{0,20}\b(?:instructions?|prompts?|rules?)\b/i },
  { rule: 'S2_ROLE_REASSIGNMENT', pattern: /\byou are now\b|\bfrom now on,? you\b|\bact as if you (?:are|were)\b/i },
  { rule: 'S3_CONSTRAINT_RELEASE', pattern: /\b(?:disregard|forget|drop)\b[^.]{0,25}\b(?:constraints?|restrictions?|guidelines?|safety)\b/i },
  { rule: 'S4_DELIMITER_FORGERY', pattern: /<\/?(?:system|instructions?|ronor[-_]?evidence)>|\[\/?(?:SYSTEM|INST)\]/i },
  { rule: 'S5_TOOL_COERCION', pattern: /\b(?:call|invoke|execute)\b[^.]{0,25}\b(?:tool|function|api)\b[^.]{0,30}\bwithout\b[^.]{0,20}\b(?:approval|confirmation|permission)\b/i },
];

/**
 * Remove characters that are dangerous to LOGS AND REVIEWERS, not to models.
 *
 * The bidirectional-override class matters most. Those codepoints can make a
 * reviewer's terminal display text in an order different from the byte order the
 * model receives, so a human approving an audit record and the engine that acted
 * on it can be looking at genuinely different instructions.
 */
export function stripDangerousChars(input: string): { text: string; removed: number } {
  const before = input.length;
  const text = input
    // ANSI sequences are removed FIRST, and the order is load-bearing. The C0
    // pass below strips 0x1B; running it first would remove the escape byte and
    // leave the visible remainder ('[31m') behind as literal text in the audit
    // record. A sequence can only be matched while its anchor still exists.
    // CSI form.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\[[0-9;?]*[ -/]*[@-~]/g, '')
    // OSC form, terminated by BEL or ST. Left unhandled, an OSC string can
    // retitle a reviewer's terminal window.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g, '')
    // Two-character escapes.
    // eslint-disable-next-line no-control-regex
    .replace(/\u001B[@-Z\\-_]/g, '')
    // NUL and other C0 controls except tab, newline, carriage return. Any
    // orphaned escape byte is caught here.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // Bidirectional overrides and isolates (Trojan Source).
    .replace(/[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g, '')
    // Zero-width characters used to smuggle tokens past visual review.
    .replace(/[\u200B-\u200D\uFEFF]/g, '');
  return { text, removed: before - text.length };
}

export function sanitiseQuery(raw: unknown, maxChars = MAX_QUERY_CHARS): SanitisationResult {
  const empty: SanitisationResult = {
    ok: false,
    text: '',
    verdict: 'clean',
    findings: [],
    refusalReason: null,
    removedChars: 0,
    originalLength: 0,
  };

  if (typeof raw !== 'string') {
    return { ...empty, refusalReason: 'query must be a string' };
  }
  const originalLength = raw.length;
  if (!raw.trim()) {
    return { ...empty, originalLength, refusalReason: 'query must not be empty' };
  }
  if (originalLength > maxChars) {
    return {
      ...empty,
      originalLength,
      refusalReason: `query exceeds the ${maxChars}-character limit (received ${originalLength})`,
    };
  }

  const { text, removed } = stripDangerousChars(raw);
  const findings: string[] = [];

  for (const { rule, pattern } of HOSTILE_RULES) {
    if (pattern.test(text)) findings.push(rule);
  }
  const hostile = findings.length > 0;

  for (const { rule, pattern } of SUSPICIOUS_RULES) {
    if (pattern.test(text)) findings.push(rule);
  }

  // Structural cleaning that removed a great deal is itself a signal: a query
  // that was 30% invisible characters was constructed, not typed.
  if (removed > 0 && removed / Math.max(1, originalLength) > 0.05) {
    findings.push('S6_HIGH_INVISIBLE_CHARACTER_RATIO');
  }

  const verdict: InjectionVerdict = hostile
    ? 'hostile'
    : findings.length > 0
      ? 'suspicious'
      : 'clean';

  return {
    // Suspicious input PROCEEDS and is recorded. Refusing on suspicion would
    // make the runtime unable to analyse the very material it exists to analyse.
    ok: verdict !== 'hostile',
    text: text.trim(),
    verdict,
    findings,
    refusalReason: hostile
      ? `input refused: matched hostile pattern(s) ${findings.filter((f) => f.startsWith('H')).join(', ')}`
      : null,
    removedChars: removed,
    originalLength,
  };
}

/** Sanitise a short scalar field such as an operator or mission identifier. */
export function sanitiseIdentifier(raw: unknown, maxChars = 128): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripDangerousChars(raw).text.trim();
  if (!cleaned || cleaned.length > maxChars) return null;
  // Identifiers appear in log lines, file paths and SQL parameters. Restricting
  // them to a conservative character class removes an entire family of problems
  // rather than defending against each one.
  if (!/^[A-Za-z0-9._:\-/]+$/.test(cleaned)) return null;
  return cleaned;
}

export function sanitiseFreeText(raw: unknown, maxChars = MAX_FIELD_CHARS): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = stripDangerousChars(raw).text.trim();
  if (!cleaned || cleaned.length > maxChars) return null;
  return cleaned;
}
