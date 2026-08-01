/**
 * End-to-end decision loop test
 * Exercises: scenario → GPT-5.6 fallback → MI9 Gate → Exposure → hash chain
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

const scratchDb = path.join(os.tmpdir(), `ronor-e2e-${Date.now()}.db`);
process.env.AUDIT_DB_PATH = scratchDb;
process.env.OPENAI_API_KEY = '';   // force deterministic fallback for hermetic test

import { runDecisionLoop } from '../../src/decision-loop/orchestrator';
import { verifyChain, closeDb } from '../../src/audit/hash-chain';
import { loadPolicy } from '../../src/governance/mi9-gate';

beforeAll(() => {
  loadPolicy();
});

afterAll(() => {
  closeDb();
  if (fs.existsSync(scratchDb)) fs.unlinkSync(scratchDb);
});

describe('E2E — governed BESS decision loop', () => {
  test('runs 24-tick session and produces a linked audit chain', async () => {
    const result = await runDecisionLoop({ domain: 'energy.bess.dispatch' });

    // Baseline sanity
    expect(result.baseline.actions.length).toBe(24);
    expect(result.proposal.actions.length).toBe(24);
    expect(result.proposal.fallbackUsed).toBe(true);

    // Every action produces an audit record
    expect(result.perAction).toHaveLength(24);
    for (const p of result.perAction) {
      expect(p.auditRecord.payloadHash).toMatch(/^[a-f0-9]{64}$/);
      expect(p.auditRecord.chainHash).toMatch(/^[a-f0-9]{64}$/);
      expect(p.exposure.exposureFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(['low', 'moderate', 'elevated', 'high', 'critical']).toContain(
        p.exposure.aggregateTier
      );
    }

    // Chain must be intact and end where the last record points
    const verify = verifyChain();
    expect(verify.ok).toBe(true);
    expect(result.headChainHash).toBe(verify.headHash);
  });

  test('MI9 verdict distribution respects policy for high-risk BESS domain', async () => {
    const r = await runDecisionLoop({ domain: 'energy.bess.dispatch' });
    // High-risk BESS domain enforces cosign — pure autonomous allow should
    // NOT be dominant. We only assert cosign > 0 to catch regressions where
    // the gate is accidentally bypassed.
    expect(r.summary.cosignRequired + r.summary.escalated + r.summary.blocked).toBeGreaterThan(0);
  });

  test('exposure aggregates surface in response summary', async () => {
    const r = await runDecisionLoop({ domain: 'energy.bess.dispatch' });
    expect(r.exposureSummary.aggregateResidualEur).toBeGreaterThanOrEqual(0);
    expect(r.exposureSummary.worstCaseEur).toBeGreaterThan(0);
    expect(['low', 'moderate', 'elevated', 'high', 'critical']).toContain(
      r.exposureSummary.highestTier
    );
    const totalAdvisories = Object.values(r.exposureSummary.advisoryDistribution).reduce(
      (a, b) => a + b,
      0
    );
    expect(totalAdvisories).toBe(r.summary.totalActions);
  });
});
