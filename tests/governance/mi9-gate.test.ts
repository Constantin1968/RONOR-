/**
 * MI9 Gate unit tests
 */

import {
  evaluate,
  loadPolicy,
  resetRateLimits,
  recordExecution,
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
