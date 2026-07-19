/**
 * R-Economics & Evolution Plane
 * Plane 7 of 7 — EMS scoring, cost tracking, and continuous optimisation.
 *
 * EMS Formula: Quality − Cost − Latency − Risk + Sovereignty + Evidence
 *
 * Responsibilities:
 * - Compute final EMS score for each request
 * - Track cumulative cost and token usage
 * - Identify optimisation opportunities
 * - Feed performance data back to Model Fabric
 * - Self-optimising routing recommendations
 */

import { createLogger } from '../../utils/logger';
import { computeEMS } from '../../types';
import type { PlaneHealth, EMSScore, TokenUsage } from '../../types';
import type { AssuranceResult } from '../r-assurance';

const logger = createLogger('Plane:R-Economics');

// Weights from environment (default: quality-first)
const W_QUALITY = parseFloat(process.env.ECONOMICS_EMS_QUALITY_WEIGHT || '0.35');
const W_COST = parseFloat(process.env.ECONOMICS_EMS_COST_WEIGHT || '0.25');
const W_LATENCY = parseFloat(process.env.ECONOMICS_EMS_LATENCY_WEIGHT || '0.20');
const W_RISK = parseFloat(process.env.ECONOMICS_EMS_RISK_WEIGHT || '0.10');
const W_SOVEREIGNTY = parseFloat(process.env.ECONOMICS_EMS_SOVEREIGNTY_WEIGHT || '0.05');
const W_EVIDENCE = parseFloat(process.env.ECONOMICS_EMS_EVIDENCE_WEIGHT || '0.05');

interface CostAccumulator {
  totalRequests: number;
  totalTokens: number;
  totalCostUsd: number;
  avgEms: number;
}

const globalAccumulator: CostAccumulator = {
  totalRequests: 0,
  totalTokens: 0,
  totalCostUsd: 0,
  avgEms: 0,
};

export interface EconomicsResult extends AssuranceResult {
  ems: EMSScore;
}

export class REconomicsPlane {
  private requestsTotal = 0;
  private errorsTotal = 0;

  async init(): Promise<void> {
    logger.info(`R-Economics plane initialised ✓`);
    logger.info(`EMS weights — Q:${W_QUALITY} C:${W_COST} L:${W_LATENCY} R:${W_RISK} S:${W_SOVEREIGNTY} E:${W_EVIDENCE}`);
  }

  async process(input: AssuranceResult): Promise<EconomicsResult> {
    this.requestsTotal++;

    const latencyNorm = Math.min(1, (input.tokensUsed.totalTokens * 0.5) / 10000);
    const costNorm = Math.min(1, input.tokensUsed.estimatedCostUsd / 0.05);

    const ems = computeEMS({
      quality: input.qualityScore,
      cost: costNorm,
      latency: latencyNorm,
      risk: input.sovereigntyVerified ? 0.1 : 0.4,
      sovereignty: input.sovereigntyVerified ? 0.9 : 0.3,
      evidence: Math.min(1, input.evidenceChain.length * 0.3),
    });

    // Update global accumulator
    globalAccumulator.totalRequests++;
    globalAccumulator.totalTokens += input.tokensUsed.totalTokens;
    globalAccumulator.totalCostUsd += input.tokensUsed.estimatedCostUsd;
    globalAccumulator.avgEms =
      (globalAccumulator.avgEms * (globalAccumulator.totalRequests - 1) + ems.total) /
      globalAccumulator.totalRequests;

    logger.info(
      `EMS: ${ems.total.toFixed(3)} | Q:${ems.quality.toFixed(2)} C:${ems.cost.toFixed(2)} ` +
      `L:${ems.latency.toFixed(2)} R:${ems.risk.toFixed(2)} S:${ems.sovereignty.toFixed(2)} E:${ems.evidence.toFixed(2)}`
    );

    return { ...input, ems };
  }

  getGlobalStats(): CostAccumulator {
    return { ...globalAccumulator };
  }

  async health(): Promise<PlaneHealth> {
    return {
      planeId: 'r-economics',
      status: 'healthy',
      latencyMs: 1,
      requestsTotal: this.requestsTotal,
      errorsTotal: this.errorsTotal,
      lastChecked: new Date(),
    };
  }
}
