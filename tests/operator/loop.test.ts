/**
 * Bucla operatorului: poarta blochează pe buget, resursă ocupată, mandat
 * invalid și actuare neaprobată — înainte de orice execuție.
 */
import { objectiveHash } from '../../src/runtime/automation/policy';
import { signMandateAuthority } from '../../src/runtime/automation/mandate-issuer';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';
import { ResourceLeaseManager } from '../../src/runtime/operator/resource-lease';
import { runOperatorTick, type OperatorTickParams } from '../../src/runtime/operator/loop';
import { operatorTypesFromMandate } from '../../src/runtime/operator/actions';

const AUTHORITY_KEY = 'test-operator-authority-key-0123456789abcdef';
const OBJECTIVE = 'Corectează sumEvenSquares în /work/proba-001 fără efecte externe';
const BASE = {
  mission_id: 'misiune-proba-minimala-001',
  issued_by: 'merlin' as const,
  issued_by_key_id: 'key_0123456789ab',
  workspace_root: '/work/proba-001',
  branch_prefix: 'proba/',
  allowed_actions: ['read_repo', 'edit_worktree', 'run_tests', 'commit_local'] as ExecutionMandate['allowed_actions'],
  denied_actions: ['push', 'merge', 'release', 'deploy', 'external_send', 'secrets_read', 'destructive_action',
    'financial_action', 'main_write'] as ExecutionMandate['allowed_actions'],
  max_cost_usd: 5,
  max_runtime_minutes: 45,
  max_fix_cycles: 1,
  issued_at: '2026-09-16T10:00:00Z',
  expires_at: '2026-09-16T10:45:00Z',
};

function mandate(overrides: Partial<ExecutionMandate> = {}): ExecutionMandate {
  return signMandateAuthority(
    {
      mandate_id: `mandate_${Date.now()}${Math.floor(Math.random() * 1e6)}`,
      objective_hash: objectiveHash(OBJECTIVE),
      ...BASE,
      ...overrides,
    },
    AUTHORITY_KEY,
  );
}

const CTX = { objective: OBJECTIVE, workspaceRoot: '/work/proba-001', branch: 'proba/001' };

describe('operator loop gating', () => {
  it('permite citirea delegată cu buget și resursă libere', () => {
    const decision = runOperatorTick({
      mandate: mandate(),
      ...CTX,
      resource: '/work/proba-001',
      owner: 'operator-1',
      action: { type: 'repo.read', args: { path: 'src/sum.ts' } },
      approved: false,
      costSoFarUsd: 0,
      leaseManager: new ResourceLeaseManager(),
      now: new Date('2026-09-16T10:01:00Z'),
    });
    expect(decision).toEqual({ decision: 'ready_to_execute', reason: 'operator_tick_permitted' });
  });

  it('blochează actuarea, nedelegabilă prin mandat, chiar aprobată, și eliberează resursa', () => {
    for (const approved of [false, true]) {
      const leases = new ResourceLeaseManager();
      const blocked = runOperatorTick({
        mandate: mandate(),
        ...CTX,
        resource: '/work/proba-001',
        owner: 'operator-1',
        action: { type: 'ops.actuate', args: { device: 'bess-01', command: 'set_power' } },
        approved,
        costSoFarUsd: 0,
        leaseManager: leases,
        now: new Date('2026-09-16T10:01:00Z'),
      });
      expect(blocked).toEqual({ decision: 'blocked', reason: 'action_not_allowed:ops.actuate' });
      expect(leases.holder('/work/proba-001', new Date('2026-09-16T10:01:01Z'))).toBeNull();
    }
  });

  it('blochează pe buget epuizat, resursă ocupată și mandat expirat', () => {
    expect(
      runOperatorTick({
        mandate: mandate(), ...CTX, resource: '/work/proba-001', owner: 'o',
        action: { type: 'repo.read', args: { path: 'a' } },
        approved: false, costSoFarUsd: 5, leaseManager: new ResourceLeaseManager(),
        now: new Date('2026-09-16T10:01:00Z'),
      }).reason,
    ).toBe('cost_budget_exhausted_before_execution');

    const leases = new ResourceLeaseManager();
    leases.claim({ resource: '/work/proba-001', owner: 'altcineva', leaseMs: 600_000, now: new Date('2026-09-16T10:01:00Z') });
    expect(
      runOperatorTick({
        mandate: mandate(), ...CTX, resource: '/work/proba-001', owner: 'o',
        action: { type: 'repo.read', args: { path: 'a' } },
        approved: false, costSoFarUsd: 0, leaseManager: leases,
        now: new Date('2026-09-16T10:01:00Z'),
      }).reason,
    ).toMatch(/^resource_busy:/);

    expect(
      runOperatorTick({
        mandate: mandate(), ...CTX, resource: '/work/proba-001', owner: 'o',
        action: { type: 'repo.read', args: { path: 'a' } },
        approved: false, costSoFarUsd: 0, leaseManager: new ResourceLeaseManager(),
        now: new Date('2026-09-16T11:00:00Z'),
      }).reason,
    ).toMatch(/mandate_invalid:mandate_expired_or_not_yet_valid|mandate_expired/);
  });
});

describe('operator loop: tipurile permise vin numai din mandat', () => {
  const tick = (m: ExecutionMandate, action: unknown, extra: Record<string, unknown> = {}) =>
    runOperatorTick({
      mandate: m,
      ...CTX,
      resource: '/work/proba-001',
      owner: 'operator-1',
      action,
      approved: true,
      costSoFarUsd: 0,
      leaseManager: new ResourceLeaseManager(),
      now: new Date('2026-09-16T10:01:00Z'),
      ...extra,
    } as OperatorTickParams);

  it('derivă tipurile din allowed_actions și scade denied_actions', () => {
    expect(operatorTypesFromMandate(mandate())).toEqual(['repo.read', 'repo.edit', 'tests.run', 'vcs.commit_local']);
    expect(
      operatorTypesFromMandate({ allowed_actions: ['read_repo', 'commit_local'], denied_actions: ['commit_local'] }),
    ).toEqual(['repo.read']);
    expect(operatorTypesFromMandate({ allowed_actions: [], denied_actions: [] })).toEqual([]);
  });

  it('refuză un apelant care cere mai mult decât mandatul (mandat doar read_repo)', () => {
    const readOnly = mandate({ allowed_actions: ['read_repo'] });
    expect(tick(readOnly, { type: 'repo.read', args: { path: 'src/sum.ts' } }).decision).toBe('ready_to_execute');
    for (const action of [
      { type: 'repo.edit', args: { path: 'src/sum.ts' } },
      { type: 'vcs.commit_local', args: { message: 'fix' } },
      { type: 'tests.run', args: { suiteId: 'proba-001-t1' } },
      { type: 'notify.send', args: { channel: 'ops', text: 'gata' } },
      { type: 'ops.actuate', args: { device: 'bess-01', command: 'set_power' } },
      { type: 'ops.observe', args: { target: 'bess-01' } },
    ]) {
      expect(tick(readOnly, action)).toEqual({ decision: 'blocked', reason: `action_not_allowed:${action.type}` });
    }
  });

  it('ignoră un allowedOperatorTypes strecurat de apelant', () => {
    const readOnly = mandate({ allowed_actions: ['read_repo'] });
    expect(
      tick(readOnly, { type: 'ops.actuate', args: { device: 'bess-01', command: 'set_power' } }, {
        allowedOperatorTypes: ['ops.actuate', 'repo.edit', 'vcs.commit_local'],
      }),
    ).toEqual({ decision: 'blocked', reason: 'action_not_allowed:ops.actuate' });
    expect(
      tick(readOnly, { type: 'repo.edit', args: { path: 'a' } }, { allowedOperatorTypes: ['repo.edit'] }),
    ).toEqual({ decision: 'blocked', reason: 'action_not_allowed:repo.edit' });
  });

  it('aplică denied_actions chiar când tipul apare și în allowed_actions', () => {
    const contradictory = mandate({
      allowed_actions: ['read_repo', 'commit_local'],
      denied_actions: [...BASE.denied_actions, 'commit_local'],
    });
    const decision = tick(contradictory, { type: 'vcs.commit_local', args: { message: 'fix' } });
    // Fie mandatul e refuzat la validare, fie tipul e refuzat de poartă: niciodată permis.
    expect(decision.decision).toBe('blocked');
    expect(decision.reason).toMatch(/^mandate_invalid:|^action_not_allowed:vcs\.commit_local$/);
  });

  it('refuză ocolirea prin interpretor sub un mandat valid doar read_repo', () => {
    const readOnly = mandate({ allowed_actions: ['read_repo'] });
    for (const cmd of ['python3.11 -c "x"', 'node -e "x"', 'bash -c "x"', 'sh -c "x"', 'perl -e "x"', 'ruby -e "x"', 'php -r "x"']) {
      expect(tick(readOnly, { type: 'repo.read', args: { path: 'x', cmd } })).toEqual({
        decision: 'blocked',
        reason: 'unknown_arg:cmd',
      });
    }
  });
});
