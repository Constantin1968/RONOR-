/**
 * MI9 enforcement arming — RONOR governance spine
 *
 * `MI9_ENFORCE=off` downgrades the constitutional gate to record-only: the
 * verdict is computed, deposited in the audit chain, and then ignored. That is a
 * legitimate development aid and an unacceptable production setting, because a
 * governance control that can be disarmed by configuration is not a control.
 *
 * This module is the single place that decides whether the switch may be used at
 * all. `assertMi9EnforcementAllowed(process.env)` is called once during boot,
 * before the HTTP server listens, so a production deployment carrying the switch
 * refuses to start rather than starts ungoverned. Outside production nothing
 * changes: the switch keeps working exactly as before.
 */

/** Machine-readable reason attached to every refusal thrown by this module. */
export const MI9_ENFORCE_OFF_REFUSED_IN_PRODUCTION =
  'mi9_enforce_off_refused_in_production';

/** The narrow slice of the environment this decision depends on. */
export interface Mi9EnforcementEnv {
  NODE_ENV?: string;
  MI9_ENFORCE?: string;
}

export class Mi9EnforcementRefusedError extends Error {
  readonly code: string = MI9_ENFORCE_OFF_REFUSED_IN_PRODUCTION;

  constructor(message: string) {
    super(message);
    this.name = 'Mi9EnforcementRefusedError';
  }
}

/**
 * Throws when a production environment asks to run MI9 in record-only mode.
 * Returns normally in every other case, so callers can invoke it unconditionally.
 */
export function assertMi9EnforcementAllowed(env: Mi9EnforcementEnv): void {
  const isProduction = (env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
  const enforcementOff = (env.MI9_ENFORCE ?? '').trim().toLowerCase() === 'off';

  if (isProduction && enforcementOff) {
    throw new Mi9EnforcementRefusedError(
      'MI9_ENFORCE=off is refused under NODE_ENV=production: the constitutional ' +
        'gate cannot be disarmed by configuration. Remove the setting to enforce ' +
        'MI9 verdicts, or run outside production to record them without enforcement.',
    );
  }
}
