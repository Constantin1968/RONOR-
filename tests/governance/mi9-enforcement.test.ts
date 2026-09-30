/**
 * MI9 enforcement guard tests (governance debt 3).
 *
 * The constitutional gate must not be disarmable by configuration in
 * production: MI9_ENFORCE=off is a debugging affordance that has no business
 * being reachable on a production instance.
 */

import {
  assertMi9EnforcementAllowed,
  MI9_ENFORCE_OFF_REFUSED,
} from '../../src/governance/mi9-enforcement';

describe('assertMi9EnforcementAllowed', () => {
  test('throws mi9_enforce_off_refused_in_production for production + MI9_ENFORCE=off', () => {
    const env = { NODE_ENV: 'production', MI9_ENFORCE: 'off' };

    let thrown: unknown;
    try {
      assertMi9EnforcementAllowed(env);
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error & { code?: string }).code).toBe(MI9_ENFORCE_OFF_REFUSED);
    expect(MI9_ENFORCE_OFF_REFUSED).toBe('mi9_enforce_off_refused_in_production');
    expect((thrown as Error).message).toMatch(/MI9_ENFORCE=off/);
  });

  test('passes for production with MI9_ENFORCE unset', () => {
    expect(() => assertMi9EnforcementAllowed({ NODE_ENV: 'production' })).not.toThrow();
    expect(() =>
      assertMi9EnforcementAllowed({ NODE_ENV: 'production', MI9_ENFORCE: 'on' }),
    ).not.toThrow();
  });

  test('passes for development + MI9_ENFORCE=off', () => {
    expect(() =>
      assertMi9EnforcementAllowed({ NODE_ENV: 'development', MI9_ENFORCE: 'off' }),
    ).not.toThrow();
    expect(() => assertMi9EnforcementAllowed({ MI9_ENFORCE: 'off' })).not.toThrow();
  });
});
