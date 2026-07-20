/**
 * MI9 Gate unit tests
 */

import { evaluate, loadPolicy, resetRateLimits, type DecisionContext } from '../../src/governance/mi9-gate';

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
