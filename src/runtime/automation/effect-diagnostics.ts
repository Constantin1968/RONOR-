/** Fixed policy rule identifiers, never patterns or text taken from an action. */
export const EFFECT_RULES = Object.freeze([
  'git_push_forbidden', 'git_remote_mutation_forbidden', 'cloud_metadata_forbidden',
  'private_network_forbidden', 'workspace_escape_forbidden', 'network_client_forbidden',
  'privilege_escalation_forbidden', 'destructive_command_forbidden',
] as const);
export type EffectRule = typeof EFFECT_RULES[number];

/**
 * Structural field-name heuristic only, not proof of execution safety.
 * Mixed-category matches are `other`; synthetic join separators have no locus.
 * Content can execute later, so no policy allowance depends on this tag.
 */
export type MatchLocus = 'command' | 'content' | 'other';

/** Diagnostic only: no scanned text, input keys, paths, commands or exceptions. */
export interface EffectDiagnostics {
  rule: EffectRule | null;
  scanned_actions: number;
  scanned_chars: number;
  match_index: number | null;
  match_locus: MatchLocus | null;
}

const FIELDS = ['rule', 'scanned_actions', 'scanned_chars', 'match_index', 'match_locus'] as const;
const count = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/**
 * Closed-schema validation at every output/persistence boundary, including
 * custom adapters. Reject extras, accessors, prototypes and inconsistent bounds;
 * return a new plain object, never an input object or a serialization hook.
 */
export function readEffectDiagnostics(value: unknown): EffectDiagnostics | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== FIELDS.length || keys.some(key =>
      typeof key !== 'string' || !(FIELDS as readonly string[]).includes(key))) return null;
    const fields = Object.getOwnPropertyDescriptors(value);
    if (FIELDS.some(key => !fields[key] || !('value' in fields[key]))) return null;
    const rule: unknown = fields.rule.value;
    const actions: unknown = fields.scanned_actions.value;
    const chars: unknown = fields.scanned_chars.value;
    const index: unknown = fields.match_index.value;
    const locus: unknown = fields.match_locus.value;
    if (!count(actions) || !count(chars) || (actions === 0 && chars !== 0)) return null;
    if (rule === null) {
      if (index !== null || locus !== null) return null;
    } else {
      if (typeof rule !== 'string' || !(EFFECT_RULES as readonly string[]).includes(rule) ||
          actions === 0 || chars > 128_000 || !count(index) || index >= chars ||
          (locus !== 'command' && locus !== 'content' && locus !== 'other')) return null;
    }
    return {
      rule: rule as EffectRule | null, scanned_actions: actions, scanned_chars: chars,
      match_index: index as number | null, match_locus: locus as MatchLocus | null,
    };
  } catch { return null; }
}

/** A diagnostic is never accepted evidence, and is carried only on failure. */
export function readResultEffectDiagnostics(result: unknown): EffectDiagnostics | null {
  try {
    if (!result || typeof result !== 'object' ||
        Object.getOwnPropertyDescriptor(result, 'ok')?.value !== false) return null;
    return readEffectDiagnostics(Object.getOwnPropertyDescriptor(result, 'effect_diagnostics')?.value);
  } catch { return null; }
}
