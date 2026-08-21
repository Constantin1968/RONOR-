import { issueArchitectMandate, verifyMandateAuthority } from '../../src/runtime/automation/mandate-issuer';
import { ALWAYS_DENIED_ACTIONS, DEFAULT_ALLOWED_ACTIONS, validateMandate } from '../../src/runtime/automation/policy';

const base = {
  missionId: 'msn_approved', objective: 'Implement the bounded change.',
  workspaceRoot: '/worktrees/mission', branch: 'agent/mission',
  architectKeyId: 'key_0123456789ab', now: new Date('2026-08-20T12:00:00.000Z'),
};
const ceilings = { maxCostUsd: 5, maxRuntimeMinutes: 60, maxFixCycles: 3 };
const signingKey = 'test-mandate-authority-key-0123456789abcdef';

describe('server-side architect mandate issuer', () => {
  it('derives every authority field and binds it to the authenticated principal', () => {
    const mandate = issueArchitectMandate({ ...base, maxCostUsd: 2, maxRuntimeMinutes: 15, maxFixCycles: 1 }, ceilings, signingKey);
    expect(mandate).toMatchObject({
      mission_id: base.missionId, issued_by: 'merlin', issued_by_key_id: base.architectKeyId,
      workspace_root: base.workspaceRoot, branch_prefix: base.branch,
      allowed_actions: DEFAULT_ALLOWED_ACTIONS, denied_actions: ALWAYS_DENIED_ACTIONS,
      max_cost_usd: 2, max_runtime_minutes: 15, max_fix_cycles: 1,
      issued_at: '2026-08-20T12:00:00.000Z', expires_at: '2026-08-20T12:15:00.000Z',
    });
    expect(mandate.mandate_id).toMatch(/^mandate_[a-f0-9]{32}$/);
    expect(mandate).toMatchObject({ authority_version: 'ronor-mandate/v1', authority_signature: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/) });
    expect(verifyMandateAuthority(mandate, signingKey)).toBe(true);
    expect(validateMandate(mandate, { objective: base.objective, workspaceRoot: base.workspaceRoot, branch: base.branch, now: new Date('2026-08-20T12:01:00Z') })).toEqual({ valid: true, reason: null });
  });

  it('derives a stable handle only when the caller supplies an idempotency key', () => {
    const first = issueArchitectMandate({ ...base, idempotencyKey: 'request-42' }, ceilings, signingKey);
    const retry = issueArchitectMandate({ ...base, idempotencyKey: 'request-42', now: new Date('2026-08-20T12:00:05Z') }, ceilings, signingKey);
    const next = issueArchitectMandate({ ...base, idempotencyKey: 'request-43' }, ceilings, signingKey);
    expect(retry.mandate_id).toBe(first.mandate_id);
    expect(next.mandate_id).not.toBe(first.mandate_id);
  });

  it('refuses invalid identity, protected branches and limit expansion', () => {
    expect(() => issueArchitectMandate({ ...base, architectKeyId: 'merlin' }, ceilings, signingKey)).toThrow('architect_identity_invalid');
    expect(() => issueArchitectMandate({ ...base, branch: 'main' }, ceilings, signingKey)).toThrow('protected_branch_refused');
    expect(() => issueArchitectMandate({ ...base, maxCostUsd: 5.01 }, ceilings, signingKey)).toThrow('mandate_limit_outside_policy');
    expect(() => issueArchitectMandate({ ...base, maxRuntimeMinutes: 61 }, ceilings, signingKey)).toThrow('mandate_limit_outside_policy');
    expect(() => issueArchitectMandate(base, ceilings, 'short')).toThrow('mandate_signing_key_invalid');
  });

  it('uses exact branch binding unless policy explicitly ends in a namespace separator', () => {
    const exact = issueArchitectMandate(base, ceilings, signingKey);
    expect(validateMandate(exact, { objective: base.objective, workspaceRoot: base.workspaceRoot, branch: 'agent/mission-evil', now: new Date('2026-08-20T12:01:00Z') }).reason).toBe('branch_outside_mandate');
    expect(validateMandate({ ...exact, branch_prefix: 'agent/' }, { objective: base.objective, workspaceRoot: base.workspaceRoot, branch: 'agent/other', now: new Date('2026-08-20T12:01:00Z') }).valid).toBe(true);
  });

  it('rejects tampering, the wrong authority key and a missing signature', () => {
    const signed = issueArchitectMandate(base, ceilings, signingKey);
    expect(verifyMandateAuthority({ ...signed, max_cost_usd: signed.max_cost_usd + 1 }, signingKey)).toBe(false);
    expect(verifyMandateAuthority(signed, 'different-mandate-key-0123456789abcdef')).toBe(false);
    expect(verifyMandateAuthority({ ...signed, authority_signature: undefined }, signingKey)).toBe(false);
  });
});
