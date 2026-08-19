/**
 * Decision Loop Orchestrator
 *
 * Wires together: scenario → frontier-model proposal → MI9 Gate → audit chain.
 * This is the end-to-end governed decision loop that Devpost judges will
 * see live in the video and be able to reproduce in the deployed demo.
 */

import { v4 as uuid } from 'uuid';
import { createLogger } from '../utils/logger';
import {
  DEMO_ASSET,
  generateMarketDay,
  runBaselinePolicy,
  generateGovernedEnvelope,
  type BessAsset,
  type MarketTick,
  type PolicyRun,
  type DispatchAction,
} from './bess-scenario';
import { proposePolicy, type FrontierProposal } from './gpt-56-adapter';
import { evaluate, recordExecution, type MI9Result, type DecisionContext } from '../governance/mi9-gate';
import { analyzeExposure, type ExposureRecord } from '../governance/exposure-analysis';
import { append, type AuditRecord } from '../audit/hash-chain';

const logger = createLogger('DecisionLoop');

// ============================================================
// Types
// ============================================================

export interface DecisionRequest {
  domain: string;                        // e.g. "energy.bess.dispatch"
  asset?: BessAsset;
  ticks?: MarketTick[];
  operator?: {
    userId?: string;
    role: 'operator' | 'dispatcher' | 'auditor' | 'external';
  };
  metadata?: Record<string, unknown>;
}

export interface PerActionOutcome {
  action: DispatchAction;
  mi9Result: MI9Result;
  exposure: ExposureRecord;
  auditRecord: AuditRecord;
}

export interface DecisionResponse {
  decisionSessionId: string;
  timestamp: string;
  asset: BessAsset;
  baseline: PolicyRun;
  proposal: FrontierProposal;
  perAction: PerActionOutcome[];
  verifiedGainEur: number;
  osaasFeeEur: number;                   // 15% of verified gain, capped by policy
  summary: {
    totalActions: number;
    allowed: number;
    cosignRequired: number;
    escalated: number;
    blocked: number;
  };
  exposureSummary: {
    aggregateResidualEur: number;
    worstCaseEur: number;
    highestTier: 'low' | 'moderate' | 'elevated' | 'high' | 'critical';
    advisoryDistribution: Record<'proceed' | 'proceed-with-controls' | 'defer' | 'reject', number>;
  };
  headChainHash: string;
}

// ============================================================
// OSaaS fee model — 15% of verified gain, cap €1,000/day for the pilot
// ============================================================

const OSAAS_FEE_PCT = 0.15;
const OSAAS_FEE_CAP_EUR = 1000;

function osaasFee(verifiedGainEur: number): number {
  if (verifiedGainEur <= 0) return 0;
  return Math.min(verifiedGainEur * OSAAS_FEE_PCT, OSAAS_FEE_CAP_EUR);
}

// ============================================================
// Core loop
// ============================================================

export async function runDecisionLoop(req: DecisionRequest): Promise<DecisionResponse> {
  const decisionSessionId = uuid();
  const started = Date.now();
  const asset = req.asset || DEMO_ASSET;
  const ticks = req.ticks || generateMarketDay();
  const domain = req.domain || 'energy.bess.dispatch';

  logger.info(`Decision session ${decisionSessionId} started for ${asset.assetId} in domain ${domain}`);

  // 1. Baseline (deterministic "charge low / discharge high" — what most sites do today)
  const baseline = runBaselinePolicy(asset, ticks);

  // 2. Governed envelope (deterministic feasibility constraints)
  const envelope = generateGovernedEnvelope(asset, ticks);

  // 3. Frontier-model proposal (GPT-5.6 with fallback)
  const proposal = await proposePolicy(asset, ticks, envelope, baseline);

  // 4. Per-action MI9 Gate + audit chain append
  const perAction: PerActionOutcome[] = [];
  let allowed = 0;
  let cosign = 0;
  let escalated = 0;
  let blocked = 0;
  let realisedRevenue = 0;
  let realisedDegradation = 0;
  let socTracking = asset.socMwh;

  for (const action of proposal.actions) {
    const decisionId = uuid();
    const impact = impactOfAction(action);
    const ctx: DecisionContext = {
      decisionId,
      domain,
      action: describeAction(action),
      proposedBy: proposal.modelUsed,
      confidence: action.confidence,
      reversible: action.type !== 'discharge' || (action.volumeMwh ?? 0) <= 2,
      impactMagnitude: impact,
      sovereignty: {
        dataResidency: 'eu',
        subjectJurisdiction: 'RO',
      },
      evidence: {
        sourceCount: 3,               // DAM + ID + FCR
        lastRefreshMs: 30_000,
        consensusReached: true,
      },
      operator: req.operator || { role: 'operator' },
      metadata: {
        fallbackAvailable: true,
        socIntegrityScore: asset.socIntegrityScore,
        voltagePerformanceScore: asset.voltagePerformanceScore,
        reliabilityScore: asset.reliabilityScore,
        inverterMode: asset.inverterMode,
      },
    };

    const mi9 = evaluate(ctx);
    const exposure = analyzeExposure(ctx);
    const outcome: 'executed' | 'held-for-cosign' | 'escalated' | 'blocked' =
      mi9.verdict === 'allow'
        ? 'executed'
        : mi9.verdict === 'allow-with-cosign'
        ? 'held-for-cosign'
        : mi9.verdict === 'escalate'
        ? 'escalated'
        : 'blocked';

    // Track counters
    if (mi9.verdict === 'allow') allowed++;
    else if (mi9.verdict === 'allow-with-cosign') cosign++;
    else if (mi9.verdict === 'escalate') escalated++;
    else blocked++;

    // Only allowed actions contribute to realised revenue
    if (mi9.verdict === 'allow') {
      const { deltaRevenue, deltaDegradation, newSoc } = applyAction(
        action,
        asset,
        socTracking
      );
      realisedRevenue += deltaRevenue;
      realisedDegradation += deltaDegradation;
      socTracking = newSoc;
      recordExecution(mi9.verdict, ctx.taskClass);
    }

    // Audit-chain record — exposure fingerprint is anchored inside the payload
    // so any tampering with the risk assessment breaks the chain identically
    // to tampering with the decision itself.
    const auditRecord = append({
      decisionId,
      decisionType: domain,
      timestamp: new Date().toISOString(),
      context: ctx,
      mi9Result: mi9,
      aiProposal: {
        model: proposal.modelUsed,
        rationale: `${action.reason} — session=${decisionSessionId}`,
        tokensUsed: proposal.tokensUsed,
        latencyMs: proposal.latencyMs,
      },
      outcome: {
        action: outcome,
        baselineValue: baseline.netEur,
        proposedValue: proposal.expectedNetEur,
        incrementalGain: proposal.expectedNetEur - baseline.netEur,
        unit: 'EUR',
      },
      metadata: {
        assetId: asset.assetId,
        decisionSessionId,
        actionType: action.type,
        volumeMwh: action.volumeMwh,
        volumeMw: action.volumeMw,
        exposure: {
          moduleVersion: exposure.moduleVersion,
          aggregateScore: exposure.aggregateScore,
          aggregateTier: exposure.aggregateTier,
          worstCaseEur: exposure.worstCaseEur,
          residualExposureEur: exposure.residualExposureEur,
          advisory: exposure.advisory,
          fingerprint: exposure.exposureFingerprint,
          narrative: exposure.narrative,
          findings: exposure.findings,
        },
      },
    });

    perAction.push({ action, mi9Result: mi9, exposure, auditRecord });
  }

  const realisedNet = realisedRevenue - realisedDegradation;
  const verifiedGain = Number((realisedNet - baseline.netEur).toFixed(2));

  // Aggregate exposure summary
  const tierRank: Record<'low' | 'moderate' | 'elevated' | 'high' | 'critical', number> = {
    low: 0,
    moderate: 1,
    elevated: 2,
    high: 3,
    critical: 4,
  };
  const advisoryDist: Record<'proceed' | 'proceed-with-controls' | 'defer' | 'reject', number> = {
    proceed: 0,
    'proceed-with-controls': 0,
    defer: 0,
    reject: 0,
  };
  let aggregateResidualEur = 0;
  let worstCaseEur = 0;
  let highestTier: 'low' | 'moderate' | 'elevated' | 'high' | 'critical' = 'low';
  for (const p of perAction) {
    aggregateResidualEur += p.exposure.residualExposureEur;
    worstCaseEur += p.exposure.worstCaseEur;
    if (tierRank[p.exposure.aggregateTier] > tierRank[highestTier]) {
      highestTier = p.exposure.aggregateTier;
    }
    advisoryDist[p.exposure.advisory]++;
  }

  const headChainHash =
    perAction.length > 0
      ? perAction[perAction.length - 1].auditRecord.chainHash
      : '0'.repeat(64);

  const response: DecisionResponse = {
    decisionSessionId,
    timestamp: new Date().toISOString(),
    asset,
    baseline,
    proposal,
    perAction,
    verifiedGainEur: verifiedGain,
    osaasFeeEur: Number(osaasFee(verifiedGain).toFixed(2)),
    summary: {
      totalActions: proposal.actions.length,
      allowed,
      cosignRequired: cosign,
      escalated,
      blocked,
    },
    exposureSummary: {
      aggregateResidualEur: Number(aggregateResidualEur.toFixed(2)),
      worstCaseEur: Number(worstCaseEur.toFixed(2)),
      highestTier,
      advisoryDistribution: advisoryDist,
    },
    headChainHash,
  };

  logger.info(
    `Decision session ${decisionSessionId} complete in ${Date.now() - started}ms — verifiedGain=€${verifiedGain}, fee=€${response.osaasFeeEur}, chainHead=${headChainHash.slice(0, 16)}…`
  );

  return response;
}

// ============================================================
// Helpers
// ============================================================

function impactOfAction(action: DispatchAction): {
  unit: 'EUR' | 'MWh' | 'MW' | 'other';
  value: number;
} {
  if (action.type === 'fcr-bid' || action.type === 'afrr-bid-up' || action.type === 'afrr-bid-down') {
    return { unit: 'MW', value: action.volumeMw || 0 };
  }
  if (action.type === 'hold') return { unit: 'MWh', value: 0 };
  const mwh = action.volumeMwh || 0;
  const eur = mwh * (action.priceEurPerMwh || 0);
  return { unit: 'EUR', value: Number(eur.toFixed(2)) };
}

function describeAction(action: DispatchAction): string {
  if (action.type === 'hold') return 'Hold — no dispatch this interval';
  if (action.type === 'fcr-bid')
    return `FCR bid ${action.volumeMw} MW @ €${action.priceEurPerMwh}/MW/h`;
  if (action.type === 'afrr-bid-up')
    return `aFRR up bid ${action.volumeMw} MW @ €${action.priceEurPerMwh}/MW/h`;
  if (action.type === 'afrr-bid-down')
    return `aFRR down bid ${action.volumeMw} MW @ €${action.priceEurPerMwh}/MW/h`;
  return `${action.type} ${action.volumeMwh} MWh @ €${action.priceEurPerMwh}/MWh`;
}

function applyAction(
  action: DispatchAction,
  asset: BessAsset,
  soc: number
): { deltaRevenue: number; deltaDegradation: number; newSoc: number } {
  if (action.type === 'hold') {
    return { deltaRevenue: 0, deltaDegradation: 0, newSoc: soc };
  }
  if (action.type === 'fcr-bid' || action.type === 'afrr-bid-up' || action.type === 'afrr-bid-down') {
    const bidMw = action.volumeMw || 0;
    return {
      deltaRevenue: bidMw * (action.priceEurPerMwh || 0),
      deltaDegradation: 0,          // pure capacity payment
      newSoc: soc,
    };
  }
  const mwh = action.volumeMwh || 0;
  const price = action.priceEurPerMwh || 0;
  if (action.type === 'charge') {
    return {
      deltaRevenue: -mwh * price,
      deltaDegradation: mwh * asset.degradationEurPerMwhCycled * 0.5,
      newSoc: soc + mwh,
    };
  }
  if (action.type === 'discharge') {
    return {
      deltaRevenue: mwh * price,
      deltaDegradation: mwh * asset.degradationEurPerMwhCycled * 0.5,
      newSoc: soc - mwh,
    };
  }
  return { deltaRevenue: 0, deltaDegradation: 0, newSoc: soc };
}
