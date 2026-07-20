/**
 * GPT-5.6 Adapter — Frontier-Model Reasoning for Governed Decisions
 *
 * This adapter calls OpenAI's GPT-5.6 (via the OpenAI SDK) with a strict
 * JSON-mode contract. The model receives:
 *   - the current market ticks
 *   - the BESS asset state (including SoC integrity + voltage performance)
 *   - the governed envelope from generateGovernedEnvelope()
 *   - the baseline policy actions
 *
 * The model returns a proposed dispatch plan with per-action confidence,
 * rationale, and evidence attribution. That plan then passes through the
 * MI9 Gate before any action is committed to the audit chain.
 *
 * NOTE: If GPT-5.6 is not available (rate limit, API error, missing key),
 * the adapter falls back to a deterministic heuristic. The audit chain
 * records which model produced the proposal.
 */

import OpenAI from 'openai';
import { createLogger } from '../utils/logger';
import type {
  BessAsset,
  MarketTick,
  DispatchAction,
  PolicyRun,
} from './bess-scenario';
import { v4 as uuid } from 'uuid';

const logger = createLogger('GPT-5.6-Adapter');

export interface FrontierProposal {
  modelUsed: string;
  actions: DispatchAction[];
  rationale: string;
  expectedRevenueEur: number;
  expectedDegradationEur: number;
  expectedNetEur: number;
  meanConfidence: number;
  latencyMs: number;
  tokensUsed?: number;
  fallbackUsed: boolean;
}

const SYSTEM_PROMPT = `You are the reasoning core of RONOR — a governed intelligence platform for Romanian energy operations.

Your job: propose a 24-hour dispatch policy for a Battery Energy Storage System (BESS) trading on OPCOM day-ahead market (DAM) and providing reserves.

Constraints you MUST respect:
1. Never exceed the SoC floor or ceiling.
2. Prefer dispatch in "chargeCandidates" and "dischargeCandidates" hours (highest expected spread).
3. Assign a probability of delivery to every reserve bid ("reliability-adjusted bidding").
4. Report per-action confidence in [0,1]. Below 0.55 = escalate to human.
5. Include degradation cost thinking: no more than 1.5 equivalent full cycles/day.
6. Return STRICT JSON matching the schema described in the user prompt.
7. Cite the evidence field of the current asset (SoC integrity, voltage performance, reliability) in your rationale.
8. If the market data seems inconsistent, mark confidence low.

You do NOT execute. You propose. Physics + policy layers decide.`;

interface ModelDispatchAction {
  timestamp: string;
  type:
    | 'charge'
    | 'discharge'
    | 'hold'
    | 'fcr-bid'
    | 'afrr-bid-up'
    | 'afrr-bid-down';
  volumeMwh?: number;
  volumeMw?: number;
  priceEurPerMwh?: number;
  reason: string;
  confidence: number;
}

interface ModelResponse {
  rationale: string;
  actions: ModelDispatchAction[];
  expectedRevenueEur: number;
  expectedDegradationEur: number;
  expectedNetEur: number;
}

function pickModel(): string {
  return process.env.RONOR_FRONTIER_MODEL || 'gpt-5.6';
}

export async function proposePolicy(
  asset: BessAsset,
  ticks: MarketTick[],
  envelope: ReturnType<typeof import('./bess-scenario').generateGovernedEnvelope>,
  baseline: PolicyRun
): Promise<FrontierProposal> {
  const started = Date.now();
  const apiKey = process.env.OPENAI_API_KEY;

  // Fallback path — deterministic spike-aware policy
  if (!apiKey) {
    logger.warn('OPENAI_API_KEY not set — using deterministic fallback proposal');
    return deterministicFallback(asset, ticks, envelope, baseline, started);
  }

  const client = new OpenAI({ apiKey });
  const modelName = pickModel();

  const userPrompt = JSON.stringify(
    {
      instruction:
        'Propose a 24-hour BESS dispatch policy. Return JSON with fields: rationale, actions[], expectedRevenueEur, expectedDegradationEur, expectedNetEur.',
      asset,
      market: ticks,
      envelope,
      baselineActions: baseline.actions,
      baselineNetEur: baseline.netEur,
    },
    null,
    2
  );

  try {
    const resp = await client.chat.completions.create({
      model: modelName,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: userPrompt },
      ],
      response_format: { type: 'json_object' },
      temperature: 0.3,
    });

    const raw = resp.choices[0]?.message?.content ?? '{}';
    let parsed: ModelResponse;
    try {
      parsed = JSON.parse(raw) as ModelResponse;
    } catch (err) {
      logger.error(`Frontier model returned invalid JSON — falling back. ${err}`);
      return deterministicFallback(asset, ticks, envelope, baseline, started);
    }

    const actions: DispatchAction[] = (parsed.actions || []).map((a) => ({
      actionId: uuid(),
      timestamp: a.timestamp,
      type: a.type,
      volumeMwh: a.volumeMwh,
      volumeMw: a.volumeMw,
      priceEurPerMwh: a.priceEurPerMwh,
      reason: a.reason,
      confidence: a.confidence,
    }));

    const meanConf =
      actions.length === 0
        ? 0
        : actions.reduce((s, a) => s + (a.confidence || 0), 0) / actions.length;

    return {
      modelUsed: modelName,
      actions,
      rationale: parsed.rationale || '(no rationale)',
      expectedRevenueEur: parsed.expectedRevenueEur ?? 0,
      expectedDegradationEur: parsed.expectedDegradationEur ?? 0,
      expectedNetEur: parsed.expectedNetEur ?? 0,
      meanConfidence: meanConf,
      latencyMs: Date.now() - started,
      tokensUsed: resp.usage?.total_tokens,
      fallbackUsed: false,
    };
  } catch (err) {
    logger.error(`Frontier model call failed: ${err}. Falling back.`);
    return deterministicFallback(asset, ticks, envelope, baseline, started);
  }
}

// ============================================================
// Deterministic fallback — spike-aware + reliability-adjusted reserve
// ============================================================

function deterministicFallback(
  asset: BessAsset,
  ticks: MarketTick[],
  envelope: ReturnType<typeof import('./bess-scenario').generateGovernedEnvelope>,
  baseline: PolicyRun,
  started: number
): FrontierProposal {
  const actions: DispatchAction[] = [];
  let soc = asset.socMwh;
  let revenue = 0;
  let mwhCycled = 0;

  // Sort candidates by spread advantage
  const chargeSet = new Set(envelope.chargeCandidates.map((t) => t.timeOfDay));
  const dischargeSet = new Set(envelope.dischargeCandidates.map((t) => t.timeOfDay));
  const reserveSet = new Set(envelope.reserveCandidates.map((t) => t.timeOfDay));

  const maxMwhCycledPerDay = envelope.maxCyclesPerDay * asset.ratedEnergyMwh;

  for (const tick of ticks) {
    // Reliability-adjusted reserve first (governance: earn while idle)
    if (
      reserveSet.has(tick.timeOfDay) &&
      soc > envelope.socFloorMwh + asset.ratedPowerMw &&
      soc < envelope.socCeilingMwh - asset.ratedPowerMw
    ) {
      const bidMw = asset.ratedPowerMw * asset.reliabilityScore;
      revenue += bidMw * tick.fcrEurPerMwPerHour;
      actions.push({
        actionId: uuid(),
        timestamp: tick.timestamp,
        type: 'fcr-bid',
        volumeMw: Number(bidMw.toFixed(2)),
        priceEurPerMwh: tick.fcrEurPerMwPerHour,
        reason: `FCR bid, reliability-adjusted (P(delivery)=${asset.reliabilityScore.toFixed(2)})`,
        confidence: 0.86,
      });
      continue;
    }

    if (
      chargeSet.has(tick.timeOfDay) &&
      soc < envelope.socCeilingMwh &&
      mwhCycled < maxMwhCycledPerDay
    ) {
      const volume = Math.min(
        asset.ratedPowerMw,
        envelope.socCeilingMwh - soc,
        maxMwhCycledPerDay - mwhCycled
      );
      if (volume > 0.1) {
        soc += volume;
        mwhCycled += volume;
        revenue -= volume * tick.damPriceEurPerMwh;
        actions.push({
          actionId: uuid(),
          timestamp: tick.timestamp,
          type: 'charge',
          volumeMwh: Number(volume.toFixed(2)),
          priceEurPerMwh: tick.damPriceEurPerMwh,
          reason: `Charge in valley (€${tick.damPriceEurPerMwh}/MWh)`,
          confidence: 0.92,
        });
        continue;
      }
    }

    if (
      dischargeSet.has(tick.timeOfDay) &&
      soc > envelope.socFloorMwh &&
      mwhCycled < maxMwhCycledPerDay
    ) {
      const volume = Math.min(
        asset.ratedPowerMw,
        soc - envelope.socFloorMwh,
        maxMwhCycledPerDay - mwhCycled
      );
      if (volume > 0.1) {
        soc -= volume;
        mwhCycled += volume;
        revenue += volume * tick.damPriceEurPerMwh;
        actions.push({
          actionId: uuid(),
          timestamp: tick.timestamp,
          type: 'discharge',
          volumeMwh: Number(volume.toFixed(2)),
          priceEurPerMwh: tick.damPriceEurPerMwh,
          reason: `Discharge in spike (€${tick.damPriceEurPerMwh}/MWh)`,
          confidence: 0.9,
        });
        continue;
      }
    }

    actions.push({
      actionId: uuid(),
      timestamp: tick.timestamp,
      type: 'hold',
      reason: 'Outside optimised window; SoC preserved for spike/reserve capacity',
      confidence: 0.95,
    });
  }

  const degradation = mwhCycled * asset.degradationEurPerMwhCycled;
  const meanConf =
    actions.length === 0
      ? 0
      : actions.reduce((s, a) => s + (a.confidence || 0), 0) / actions.length;

  return {
    modelUsed: 'ronor-deterministic-fallback-v1',
    actions,
    rationale:
      'Fallback proposal: reliability-adjusted FCR reservation on high-FCR hours + charge in envelope valleys + discharge in envelope spikes + SoC floor/ceiling enforcement + 1.5 equivalent-full-cycle daily budget.',
    expectedRevenueEur: Number(revenue.toFixed(2)),
    expectedDegradationEur: Number(degradation.toFixed(2)),
    expectedNetEur: Number((revenue - degradation).toFixed(2)),
    meanConfidence: meanConf,
    latencyMs: Date.now() - started,
    fallbackUsed: true,
  };
}
