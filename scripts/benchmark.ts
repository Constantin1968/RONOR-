/**
 * Governed-vs-ungoverned decision benchmark
 *
 * Runs N BESS decision sessions and compares:
 *   - baseline "charge low / discharge high" policy
 *   - RONOR governed policy (frontier proposal → MI9 Gate → exposure → audit)
 *
 * Emits a BENCHMARK.md-friendly table with:
 *   - mean baseline net €
 *   - mean governed net €
 *   - mean verified gain € (governed − baseline)
 *   - blocked / escalated / co-sign action rates
 *   - aggregate residual exposure €
 *   - audit chain integrity flag
 *
 * Usage:
 *   RONOR_BENCH_ITERATIONS=25 ts-node scripts/benchmark.ts
 */

import 'dotenv/config';
import { runDecisionLoop } from '../src/decision-loop/orchestrator';
import { verifyChain } from '../src/audit/hash-chain';

const ITERATIONS = parseInt(process.env.RONOR_BENCH_ITERATIONS || '10', 10);

interface Row {
  iter: number;
  baselineNetEur: number;
  proposedNetEur: number;
  verifiedGainEur: number;
  osaasFeeEur: number;
  allowed: number;
  cosign: number;
  escalated: number;
  blocked: number;
  residualExposureEur: number;
  worstCaseExposureEur: number;
  highestTier: string;
  meanConfidence: number;
  latencyMs: number;
  model: string;
  fallback: boolean;
}

async function main(): Promise<void> {
  console.log(`\nRONOR Benchmark — ${ITERATIONS} iterations\n`);
  console.log(
    'Iter  Baseline€  Governed€  Gain€    Fee€   Allow/Cos/Esc/Blk  Residual€  Tier      Conf    Latency  Model'
  );
  console.log('----  ---------  ---------  -----    -----  ----------------   ---------  --------  ------  -------  ---------');

  const rows: Row[] = [];
  for (let i = 1; i <= ITERATIONS; i++) {
    const start = Date.now();
    const result = await runDecisionLoop({ domain: 'energy.bess.dispatch' });
    const row: Row = {
      iter: i,
      baselineNetEur: result.baseline.netEur,
      proposedNetEur: result.proposal.expectedNetEur,
      verifiedGainEur: result.verifiedGainEur,
      osaasFeeEur: result.osaasFeeEur,
      allowed: result.summary.allowed,
      cosign: result.summary.cosignRequired,
      escalated: result.summary.escalated,
      blocked: result.summary.blocked,
      residualExposureEur: result.exposureSummary.aggregateResidualEur,
      worstCaseExposureEur: result.exposureSummary.worstCaseEur,
      highestTier: result.exposureSummary.highestTier,
      meanConfidence: result.proposal.meanConfidence,
      latencyMs: Date.now() - start,
      model: result.proposal.modelUsed,
      fallback: result.proposal.fallbackUsed,
    };
    rows.push(row);
    console.log(
      `${String(i).padStart(4)}  ${row.baselineNetEur.toFixed(0).padStart(9)}  ${row.proposedNetEur.toFixed(0).padStart(9)}  ${row.verifiedGainEur.toFixed(0).padStart(5)}    ${row.osaasFeeEur.toFixed(0).padStart(5)}  ${row.allowed}/${row.cosign}/${row.escalated}/${row.blocked}${'           '.slice(0, 18 - `${row.allowed}/${row.cosign}/${row.escalated}/${row.blocked}`.length)} ${row.residualExposureEur.toFixed(0).padStart(9)}  ${row.highestTier.padEnd(8)}  ${row.meanConfidence.toFixed(3)}  ${String(row.latencyMs).padStart(6)}   ${row.model}${row.fallback ? ' (fb)' : ''}`
    );
  }

  const mean = (fn: (r: Row) => number): number => rows.reduce((s, r) => s + fn(r), 0) / rows.length;

  const meanBaseline = mean((r) => r.baselineNetEur);
  const meanProposed = mean((r) => r.proposedNetEur);
  const meanGain = mean((r) => r.verifiedGainEur);
  const meanFee = mean((r) => r.osaasFeeEur);
  const meanResidual = mean((r) => r.residualExposureEur);
  const meanWorstCase = mean((r) => r.worstCaseExposureEur);
  const meanConfidence = mean((r) => r.meanConfidence);
  const meanLatency = mean((r) => r.latencyMs);
  const totalActions = rows.reduce(
    (s, r) => s + r.allowed + r.cosign + r.escalated + r.blocked,
    0
  );
  const totalAllowed = rows.reduce((s, r) => s + r.allowed, 0);
  const totalCosign = rows.reduce((s, r) => s + r.cosign, 0);
  const totalEscalated = rows.reduce((s, r) => s + r.escalated, 0);
  const totalBlocked = rows.reduce((s, r) => s + r.blocked, 0);

  console.log('\n────────  Aggregate  ────────');
  console.log(`Mean baseline net:       €${meanBaseline.toFixed(2)}`);
  console.log(`Mean governed net:       €${meanProposed.toFixed(2)}`);
  console.log(`Mean verified gain:      €${meanGain.toFixed(2)}`);
  console.log(`Mean OSaaS fee (15%):    €${meanFee.toFixed(2)}`);
  console.log(`Mean residual exposure:  €${meanResidual.toFixed(2)}`);
  console.log(`Mean worst-case exp.:    €${meanWorstCase.toFixed(2)}`);
  console.log(`Mean confidence:         ${meanConfidence.toFixed(3)}`);
  console.log(`Mean session latency:    ${meanLatency.toFixed(0)} ms`);
  console.log(
    `Verdict distribution:    allow ${((totalAllowed / totalActions) * 100).toFixed(1)}%  ` +
      `cosign ${((totalCosign / totalActions) * 100).toFixed(1)}%  ` +
      `escalate ${((totalEscalated / totalActions) * 100).toFixed(1)}%  ` +
      `block ${((totalBlocked / totalActions) * 100).toFixed(1)}%`
  );

  const gainVsBaselinePct = meanBaseline !== 0 ? (meanGain / Math.abs(meanBaseline)) * 100 : 0;
  console.log(`Verified gain vs baseline: ${gainVsBaselinePct.toFixed(2)}%`);

  // Chain integrity
  const v = verifyChain();
  console.log(`\nChain integrity:         ${v.ok ? '✓ INTACT' : '✗ BROKEN at seq ' + v.brokenAtSeq}`);
  console.log(`Chain records:           ${v.totalRecords}`);
  console.log(`Chain head hash:         ${v.headHash}`);
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
