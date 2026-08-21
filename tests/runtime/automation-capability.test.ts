import { signExecutionCapability, verifyExecutionCapability } from '../../src/runtime/automation/capability';

const key = 'k'.repeat(32);
const claims = {
  audience: 'openhands-bridge' as const, mandate_id: 'm1', mission_id: 'msn1', assignment_id: 'a1',
  objective_hash: 'a'.repeat(64), allowed_actions: ['read_repo'], expires_at: '2026-08-21T00:00:00.000Z', nonce: 'n1',
};

describe('execution capability', () => {
  it('authenticates bounded claims and rejects tampering, expiry and wrong keys', () => {
    const token = signExecutionCapability(claims, key);
    expect(verifyExecutionCapability(token, key, new Date('2026-08-20T00:00:00Z'))).toEqual(claims);
    expect(verifyExecutionCapability(`${token}x`, key, new Date('2026-08-20T00:00:00Z'))).toBeNull();
    expect(verifyExecutionCapability(token, 'z'.repeat(32), new Date('2026-08-20T00:00:00Z'))).toBeNull();
    expect(verifyExecutionCapability(token, key, new Date('2026-08-22T00:00:00Z'))).toBeNull();
  });

  it('refuses weak signing keys', () => {
    expect(() => signExecutionCapability(claims, 'short')).toThrow('capability_key_too_short');
  });
});
