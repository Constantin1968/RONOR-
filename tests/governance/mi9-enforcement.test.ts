/**
 * MI9 enforcement guard unit tests (governance debt 3)
 *
 * The constitutional gate must not be disarmable by configuration in
 * production, while development keeps the current escape hatch.
 */

import {
  assertMi9EnforcementAllowed,
  Mi9EnforcementError,
  MI9_ENFORCE_OFF_REFUSED_CODE,
} from '../../src/governance/mi9-enforcement';

describe('assertMi9EnforcementAllowed', () => {
  test('production + MI9_ENFORCE=off throws with the refusal code', () => {
    let thrown: unknown;
    try {
      assertMi9EnforcementAllowed({ NODE_ENV: 'production', MI9_ENFORCE: 'off' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Mi9EnforcementError);
    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Mi9EnforcementError).code).toBe(MI9_ENFORCE_OFF_REFUSED_CODE);
    expect((thrown as Error).name).toBe('Mi9EnforcementError');
  });

  test('production + MI9_ENFORCE unset passes', () => {
    expect(() => assertMi9EnforcementAllowed({ NODE_ENV: 'production' })).not.toThrow();
  });

  test('development + MI9_ENFORCE=off passes', () => {
    expect(() =>
      assertMi9EnforcementAllowed({ NODE_ENV: 'development', MI9_ENFORCE: 'off' }),
    ).not.toThrow();
  });

  test('production + MI9_ENFORCE=on passes', () => {
    expect(() =>
      assertMi9EnforcementAllowed({ NODE_ENV: 'production', MI9_ENFORCE: 'on' }),
    ).not.toThrow();
  });

  test('unset NODE_ENV + MI9_ENFORCE=off passes', () => {
    expect(() => assertMi9EnforcementAllowed({ MI9_ENFORCE: 'off' })).not.toThrow();
  });

  test('defaults to process.env and honours the live environment', () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalMi9Enforce = process.env.MI9_ENFORCE;
    try {
      process.env.NODE_ENV = 'production';
      process.env.MI9_ENFORCE = 'off';
      expect(() => assertMi9EnforcementAllowed()).toThrow(Mi9EnforcementError);

      process.env.MI9_ENFORCE = 'on';
      expect(() => assertMi9EnforcementAllowed()).not.toThrow();
    } finally {
      if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = originalNodeEnv;
      if (originalMi9Enforce === undefined) delete process.env.MI9_ENFORCE;
      else process.env.MI9_ENFORCE = originalMi9Enforce;
    }
  });
});
