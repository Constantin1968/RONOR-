/**
 * MI9 Gate unit tests
 */

import {
  evaluate,
  loadPolicy,
  resetRateLimits,
  recordExecution,
  resolveDomainTier,
  type DecisionContext,
} from '../../src/governance/mi9-gate';

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  return {
    decisionId: 'test-' + Math.random(),
    domain: 'energy.bess.dispatch',
    action: 'test action',
    proposedBy: 'gpt-5.6',
    confidence: 0.9,
    reversible: true,
    impactMagnitude: { unit: 'EUR', value: 500 },
    sovereignty: { dataResidency: 'eu', subjectJurisdiction: 'RO' },
    evidence: { sourceCount: 3, lastRefreshMs: 30_000, consensusReached: true },
    operator: { role: 'operator' },
    metadata: { fallbackAvailable: true },
    ...overrides,
  };
}

beforeAll(() => {
  loadPolicy();
});

beforeEach(() => {
  resetRateLimits();
});

describe('MI9 Gate', () => {
  test('allow-with-cosign for high-risk BESS domain even with all-safe inputs', () => {
    const r = evaluate(ctx());
    expect(['allow-with-cosign', 'allow']).toContain(r.verdict);
  });

  test('blocks non-EU residency for RO subject', () => {
    const r = evaluate(
      ctx({ sovereignty: { dataResidency: 'us', subjectJurisdiction: 'RO' } })
    );
    expect(r.verdict).toBe('block');
    expect(r.blockReason).toMatch(/Data residency|Jurisdiction/i);
  });

  test('escalates on low confidence', () => {
    const r = evaluate(ctx({ confidence: 0.4 }));
    expect(r.verdict).toBe('escalate');
  });

  test('blocks on excessive impact', () => {
    const r = evaluate(ctx({ impactMagnitude: { unit: 'EUR', value: 250000 } }));
    expect(r.verdict).toBe('block');
  });

  test('irreversible action forces at least co-sign', () => {
    const r = evaluate(
      ctx({ reversible: false, confidence: 0.99, impactMagnitude: { unit: 'EUR', value: 10 } })
    );
    expect(['allow-with-cosign', 'escalate', 'block']).toContain(r.verdict);
  });

  test('requires fallback for BESS dispatch', () => {
    const r = evaluate(ctx({ metadata: { fallbackAvailable: false } }));
    expect(r.verdict).toBe('block');
    expect(r.blockReason).toMatch(/fallback/i);
  });

  test('escalates on stale evidence', () => {
    const r = evaluate(
      ctx({
        evidence: { sourceCount: 1, lastRefreshMs: 2_000_000, consensusReached: true },
      })
    );
    expect(['escalate', 'allow-with-cosign', 'block']).toContain(r.verdict);
  });

  test('produces exactly 9 findings', () => {
    const r = evaluate(ctx());
    expect(r.findings).toHaveLength(9);
  });
});

// ============================================================
// Regression suite for defect D-1 — infinite co-sign loop
//
// Observed 8 Aug 2026: gate 8 reported "12/12 per hour" and requested co-sign,
// the Principal approved, and the same request returned asking for approval
// again. Root cause: evaluate() charged the sliding window on every evaluation,
// and re-evaluation carried no evidence of the approval just granted.
// ============================================================

describe('D-1 regression — rate-limit accounting', () => {
  const operational = (o: Partial<DecisionContext> = {}) =>
    ctx({
      taskClass: 'operational',
      domain: 'energy.reporting.generate',
      impactMagnitude: { unit: 'EUR', value: 10 },
      reversible: true,
      confidence: 0.99,
      ...o,
    });

  test('evaluate() has no side effect on the sliding window', () => {
    // Twenty evaluations of the same intent must not consume the budget.
    // Before the fix, this alone exhausted the 12/hour allowance.
    for (let i = 0; i < 20; i++) evaluate(operational());
    const r = evaluate(operational());
    const gate8 = r.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow');
    expect(gate8.reason).not.toMatch(/rate limit reached/i);
  });

  test('recordExecution() is what consumes the budget', () => {
    for (let i = 0; i < 12; i++) recordExecution('allow');
    const r = evaluate(operational());
    const gate8 = r.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow-with-cosign');
    expect(gate8.reason).toMatch(/rate limit reached/i);
  });

  test('recording conversational work does not consume the operational budget', () => {
    for (let i = 0; i < 50; i++) recordExecution('allow', 'conversational');
    for (let i = 0; i < 11; i++) recordExecution('allow', 'operational');
    const r = evaluate(operational());
    const gate8 = r.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow');
  });

  test('a co-signed decision is not re-charged — the loop is broken', () => {
    for (let i = 0; i < 12; i++) recordExecution('allow');

    const decisionId = 'decision-under-approval';
    const first = evaluate(operational({ decisionId }));
    expect(first.humanCoSignRequired).toBe(true);

    const afterApproval = evaluate(
      operational({
        decisionId,
        priorApproval: { decisionId, approvedBy: 'principal', approvedAtMs: Date.now() },
      })
    );
    const gate8 = afterApproval.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow');
    expect(gate8.detail?.idempotent).toBe(true);
  });

  test('an approval issued for another decision is rejected', () => {
    for (let i = 0; i < 12; i++) recordExecution('allow');
    const r = evaluate(
      operational({
        decisionId: 'decision-A',
        priorApproval: {
          decisionId: 'decision-B',
          approvedBy: 'principal',
          approvedAtMs: Date.now(),
        },
      })
    );
    const gate8 = r.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow-with-cosign');
  });

  test('a stale approval is rejected', () => {
    for (let i = 0; i < 12; i++) recordExecution('allow');
    const decisionId = 'decision-stale';
    const r = evaluate(
      operational({
        decisionId,
        priorApproval: {
          decisionId,
          approvedBy: 'principal',
          approvedAtMs: Date.now() - 20 * 60 * 1000,
        },
      })
    );
    const gate8 = r.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow-with-cosign');
  });

  test('an approval dated in the future is rejected', () => {
    for (let i = 0; i < 12; i++) recordExecution('allow');
    const decisionId = 'decision-future';
    const r = evaluate(
      operational({
        decisionId,
        priorApproval: {
          decisionId,
          approvedBy: 'principal',
          approvedAtMs: Date.now() + 60 * 60 * 1000,
        },
      })
    );
    const gate8 = r.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow-with-cosign');
  });
});

describe('Task-class policy profiles', () => {
  test('conversation is exempt from the operational hourly budget', () => {
    for (let i = 0; i < 50; i++) recordExecution('allow');
    const r = evaluate(
      ctx({
        taskClass: 'conversational',
        domain: 'general.query',
        impactMagnitude: { unit: 'EUR', value: 0 },
      })
    );
    const gate8 = r.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow');
    expect(gate8.detail?.exempt).toBe(true);
  });

  test('omitting taskClass keeps the strictest profile — fail closed', () => {
    for (let i = 0; i < 12; i++) recordExecution('allow');
    const r = evaluate(ctx({ domain: 'energy.reporting.generate' }));
    const gate8 = r.findings.find((f) => f.gateNumber === 8)!;
    expect(gate8.verdict).toBe('allow-with-cosign');
  });
});

describe('Gate 6 — evidence enforcement restored', () => {
  test('a claim with no sources cannot pass', () => {
    const r = evaluate(
      ctx({
        taskClass: 'conversational',
        domain: 'general.query',
        evidence: { sourceCount: 0, lastRefreshMs: 1_000, consensusReached: true },
      })
    );
    const gate6 = r.findings.find((f) => f.gateNumber === 6)!;
    expect(gate6.verdict).not.toBe('allow');
    expect(gate6.reason).toMatch(/sources/i);
  });

  test('data older than the 15-minute horizon is flagged', () => {
    const r = evaluate(
      ctx({
        evidence: { sourceCount: 3, lastRefreshMs: 16 * 60 * 1000, consensusReached: true },
      })
    );
    const gate6 = r.findings.find((f) => f.gateNumber === 6)!;
    expect(gate6.verdict).not.toBe('allow');
  });
});

/**
 * Deny-by-default on unclassified domains, and the development plane.
 *
 * Before this suite, an unlisted domain fell back to tier 'limited', which is
 * not in cosign_required_at_tier — so an unclassified action was allowed
 * autonomously. Authority was granted by omission. These tests hold the gate
 * to the opposite rule: authority comes from an explicit written classification.
 */
describe('Gate 2 — deny-by-default on unclassified domains', () => {
  test('an unclassified domain is blocked, not allowed', () => {
    const r = evaluate(ctx({ domain: 'unknown.plane.action' }));
    expect(r.verdict).toBe('block');
  });

  test('the block names omission, not an EU AI Act classification', () => {
    const r = evaluate(ctx({ domain: 'still.not.classified' }));
    const finding = r.findings.find((f) => f.gateName === 'risk-tier');
    expect(finding?.reason).toMatch(/no classified ancestor/i);
    expect(finding?.detail).toMatchObject({ classified: false, matched: null });
  });

  test('a classified domain is still judged on its own tier', () => {
    const r = evaluate(ctx({ domain: 'energy.observability.query', confidence: 0.99 }));
    const finding = r.findings.find((f) => f.gateName === 'risk-tier');
    expect(finding?.verdict).toBe('allow');
    expect(finding?.detail).toMatchObject({ classified: true, tier: 'minimal' });
  });
});

describe('Development plane is governed by the same policy', () => {
  test('reading the repository is autonomously actionable', () => {
    const r = evaluate(ctx({ domain: 'development.repo.read', confidence: 0.99 }));
    const finding = r.findings.find((f) => f.gateName === 'risk-tier');
    expect(finding?.verdict).toBe('allow');
    // The tier must come from an explicit classification, not from the
    // former fall-back that allowed anything unlisted.
    expect(finding?.detail).toMatchObject({ classified: true, tier: 'minimal' });
  });

  test('editing the worktree and running tests do not require co-sign on their tier', () => {
    for (const domain of ['development.worktree.edit', 'development.tests.run', 'development.commit.local']) {
      const finding = evaluate(ctx({ domain, confidence: 0.99 })).findings
        .find((f) => f.gateName === 'risk-tier');
      expect(finding?.verdict).toBe('allow');
      expect(finding?.detail).toMatchObject({ classified: true, tier: 'limited' });
    }
  });

  test('pushing to a working branch requires human co-sign', () => {
    const finding = evaluate(ctx({ domain: 'development.push.working_branch' })).findings
      .find((f) => f.gateName === 'risk-tier');
    expect(finding?.verdict).toBe('allow-with-cosign');
  });

  test('merge, release and deploy are blocked outright — they are the owner\u2019s decisions', () => {
    for (const domain of [
      'development.merge.main',
      'development.release.publish',
      'development.deploy.production',
    ]) {
      const r = evaluate(ctx({ domain, confidence: 0.99, reversible: true }));
      expect(r.verdict).toBe('block');
    }
  });

  test('reading secrets and external egress are blocked outright', () => {
    for (const domain of ['development.secrets.read', 'development.egress.external']) {
      expect(evaluate(ctx({ domain, confidence: 0.99 })).verdict).toBe('block');
    }
  });

  test('amending the canon and configuring a host require co-sign, not autonomy', () => {
    for (const domain of ['development.canon.amend', 'development.host.configure']) {
      const finding = evaluate(ctx({ domain, confidence: 0.99 })).findings
        .find((f) => f.gateName === 'risk-tier');
      expect(finding?.verdict).toBe('allow-with-cosign');
    }
  });
});

describe('Policy version is no longer the hackathon artefact', () => {
  test('the loaded policy declares a 2026.09 version or later', () => {
    const version = loadPolicy().version;
    expect(version).not.toBe('build-week-2026.07.20');
    expect(version).toMatch(/^20\d\d\.\d\d(\.\d\d)?$/);
  });
});

describe('Gate 2 — tier inheritance by most-specific classified prefix', () => {
  const tiers = {
    'runtime.query': 'limited',
    'runtime.worker': 'high',
    'development.repo.read': 'minimal',
  } as const;

  test('an exact classification wins', () => {
    expect(resolveDomainTier('runtime.query', { ...tiers })).toEqual({
      tier: 'limited', matched: 'runtime.query',
    });
  });

  test('a runtime-built leaf inherits its surface classification', () => {
    expect(resolveDomainTier('runtime.query.arithmetic', { ...tiers })).toEqual({
      tier: 'limited', matched: 'runtime.query',
    });
  });

  test('the most specific ancestor wins over a shorter one', () => {
    const withFamily = { ...tiers, runtime: 'minimal' } as Record<string, 'minimal' | 'limited' | 'high' | 'unacceptable'>;
    expect(resolveDomainTier('runtime.worker.rebuild', withFamily)).toEqual({
      tier: 'high', matched: 'runtime.worker',
    });
  });

  test('a domain with no classified ancestor resolves to nothing', () => {
    expect(resolveDomainTier('quantum.teleport.now', { ...tiers })).toEqual({
      tier: null, matched: null,
    });
  });

  test('a leaf cannot inherit a laxer tier than an unclassified sibling family', () => {
    // 'other.surface' shares no prefix with any rule, so inheritance must not
    // leak across families just because the first segment differs.
    expect(resolveDomainTier('runtimex.query.thing', { ...tiers }).tier).toBeNull();
  });

  test('a real runtime query is allowed through an inherited classification', () => {
    const finding = evaluate(ctx({ domain: 'runtime.query.arithmetic', confidence: 0.99 })).findings
      .find((f) => f.gateName === 'risk-tier');
    expect(finding?.verdict).toBe('allow');
    expect(finding?.detail).toMatchObject({ classified: true, matched: 'runtime.query' });
  });

  test('a worker surface inherits the co-sign tier', () => {
    const finding = evaluate(ctx({ domain: 'runtime.worker.rebuild', confidence: 0.99 })).findings
      .find((f) => f.gateName === 'risk-tier');
    expect(finding?.verdict).toBe('allow-with-cosign');
    expect(finding?.detail).toMatchObject({ matched: 'runtime.worker' });
  });
});
