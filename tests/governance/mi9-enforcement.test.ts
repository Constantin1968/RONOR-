import {
  assertMi9EnforcementAllowed,
  MI9_ENFORCE_OFF_REFUSED_IN_PRODUCTION,
  Mi9EnforcementRefusedError,
} from '../../src/governance/mi9-enforcement';

describe('assertMi9EnforcementAllowed', () => {
  it('refuses MI9_ENFORCE=off under NODE_ENV=production', () => {
    let thrown: unknown;
    try {
      assertMi9EnforcementAllowed({ NODE_ENV: 'production', MI9_ENFORCE: 'off' });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Mi9EnforcementRefusedError);
    expect((thrown as Mi9EnforcementRefusedError).code).toBe(
      MI9_ENFORCE_OFF_REFUSED_IN_PRODUCTION,
    );
    expect((thrown as Mi9EnforcementRefusedError).message).toMatch(
      /MI9_ENFORCE=off/,
    );
  });

  it('passes in production when MI9_ENFORCE is unset', () => {
    expect(() => assertMi9EnforcementAllowed({ NODE_ENV: 'production' })).not.toThrow();
  });

  it('passes outside production even with MI9_ENFORCE=off', () => {
    expect(() =>
      assertMi9EnforcementAllowed({ NODE_ENV: 'development', MI9_ENFORCE: 'off' }),
    ).not.toThrow();
  });
});
