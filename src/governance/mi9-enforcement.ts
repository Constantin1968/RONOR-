/**
 * MI9 Enforcement Guard
 *
 * The MI9 gate records a verdict for every consequential decision. Recording a
 * verdict without enforcing it is not a neutral act: it produces an audit trail
 * that reads as governed while the gate is disarmed. `MI9_ENFORCE=off` is a
 * debugging affordance, so it may only ever be reachable outside production.
 *
 * This module is deliberately dependency-free and fail-closed: it throws, and it
 * throws before anything starts serving traffic.
 */

export interface Mi9EnforcementEnv {
  NODE_ENV?: string;
  MI9_ENFORCE?: string;
}

export const MI9_ENFORCE_OFF_REFUSED = 'mi9_enforce_off_refused_in_production';

/**
 * Refuses to boot when the MI9 gate would be disarmed in production.
 *
 * @throws Error with `code === MI9_ENFORCE_OFF_REFUSED` when
 *   `NODE_ENV === 'production'` and `MI9_ENFORCE === 'off'`.
 */
export function assertMi9EnforcementAllowed(env: Mi9EnforcementEnv = process.env): void {
  if (env.NODE_ENV !== 'production' || env.MI9_ENFORCE !== 'off') return;

  const error = new Error(
    'MI9_ENFORCE=off is refused in production: the constitutional gate cannot be disarmed by configuration. ' +
      'Remove MI9_ENFORCE=off from the production environment, or run this configuration outside production.',
  ) as Error & { code: string };
  error.code = MI9_ENFORCE_OFF_REFUSED;
  throw error;
}
