/**
 * MI9 enforcement guard (governance debt 3)
 *
 * The orchestrator records MI9 verdicts without acting on them when
 * `MI9_ENFORCE=off` (see src/orchestrator.ts, MI9 GATE). That switch exists so
 * the gate can be observed before it is trusted — a legitimate state in
 * development, an unacceptable one in production, because it lets a single
 * environment variable disarm the constitutional gate.
 *
 * This module makes that impossible: in production, `MI9_ENFORCE=off` is
 * refused at startup, before anything listens.
 */

/** Machine-readable refusal code emitted on `err.code`. */
export const MI9_ENFORCE_OFF_REFUSED_CODE = 'mi9_enforce_off_refused_in_production';

/** Minimal environment shape needed to decide whether `off` is acceptable. */
export interface Mi9EnforcementEnv {
  NODE_ENV?: string;
  MI9_ENFORCE?: string;
}

/** Thrown when production would start with the MI9 gate disarmed. */
export class Mi9EnforcementError extends Error {
  readonly code = MI9_ENFORCE_OFF_REFUSED_CODE;

  constructor(message: string) {
    super(message);
    this.name = 'Mi9EnforcementError';
    // Restores the prototype chain when compiled down to ES5-style helpers.
    Object.setPrototypeOf(this, Mi9EnforcementError.prototype);
  }
}

/**
 * Call once at startup. Throws only for `NODE_ENV=production` +
 * `MI9_ENFORCE=off`; every other combination — including production with the
 * variable unset — passes, leaving non-production behaviour unchanged.
 */
export function assertMi9EnforcementAllowed(env: Mi9EnforcementEnv = process.env): void {
  if (env.NODE_ENV === 'production' && env.MI9_ENFORCE === 'off') {
    throw new Mi9EnforcementError(
      'MI9_ENFORCE=off is refused in production: the MI9 governance gate cannot be ' +
        'disarmed by configuration. Remove MI9_ENFORCE or set it to "on".',
    );
  }
}
