/**
 * BESS Decision Scenario — 20 MWh Romania
 *
 * Realistic scenario for the RONOR Build Week submission. Uses public 2026
 * Romanian market analysis:
 *   - DAM avg 2025: ~€110/MWh
 *   - Max daily spread: ~€168/MWh
 *   - aFRR upward: ~€9/MW/h
 *   - FCR: ~€70/MW/h
 *   - Estimated BESS revenue: €120-180/kW/year
 *
 * The scenario generates baseline and candidate optimised policies, computes
 * the incremental gain, and passes each decision to the MI9 Gate. It is the
 * end-to-end evidence path required by an OSaaS pay-for-verified-gain model.
 */

import { v4 as uuid } from 'uuid';

// ============================================================
// Types
// ============================================================

export interface BessAsset {
  assetId: string;
  location: string;                    // e.g. "Craiova, Dolj, RO"
  ratedPowerMw: number;                // e.g. 5
  ratedEnergyMwh: number;              // e.g. 20
  socMwh: number;                      // current state of charge
  degradationEurPerMwhCycled: number;  // ~€6-12
  inverterMode: 'GFM' | 'GFL' | 'hybrid';
  gridCodeCompliant: boolean;
  socIntegrityScore: number;           // 0..1 (Koopman/DMDc plausibility)
  voltagePerformanceScore: number;     // 0..1 (STVPI)
  reliabilityScore: number;            // 0..1 (probability of delivery)
}

export interface MarketTick {
  timestamp: string;                   // ISO
  damPriceEurPerMwh: number;           // Day-Ahead Market
  idPriceEurPerMwh: number;            // Intraday
  imbalancePriceEurPerMwh: number;
  aFrrUpwardEurPerMwh: number;
  aFrrDownwardEurPerMwh: number;
  fcrEurPerMwPerHour: number;
  timeOfDay: number;                   // 0..23
  demandForecastMw: number;
  renewableForecastMw: number;
}

export interface DispatchAction {
  actionId: string;
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
  confidence: number;                  // 0..1
}

export interface PolicyRun {
  policyName: 'baseline' | 'ronor-governed';
  asset: BessAsset;
  ticks: MarketTick[];
  actions: DispatchAction[];
  revenueEur: number;
  degradationCostEur: number;
  netEur: number;
}

// ============================================================
// Synthetic Romanian market day
// ============================================================

/**
 * Generate a realistic 24-hour OPCOM market tick series. Uses the DNV
 * February 2026 Romania BESS analysis as the reference for magnitude:
 *   DAM avg ~€110/MWh, max spread ~€168/MWh, aFRR upward ~€9/MW/h,
 *   FCR ~€70/MW/h.
 *
 * The shape is a stylised two-peak day (morning + evening peak) with a
 * midday PV valley — matches typical Romanian summer load curve.
 */
export function generateMarketDay(baseDate: Date = new Date()): MarketTick[] {
  const ticks: MarketTick[] = [];
  const dayStr = baseDate.toISOString().slice(0, 10);

  for (let h = 0; h < 24; h++) {
    // Base + morning peak + evening peak + PV valley
    const morningPeak = 60 * Math.exp(-Math.pow((h - 8) / 2, 2));
    const eveningPeak = 90 * Math.exp(-Math.pow((h - 20) / 2.2, 2));
    const pvValley = -35 * Math.exp(-Math.pow((h - 13) / 2.5, 2));
    const dam = Math.max(30, 85 + morningPeak + eveningPeak + pvValley);

    // Intraday tracks DAM but with ±15 EUR jitter
    const jitter = (Math.sin(h * 1.7) + Math.cos(h * 2.3)) * 8;
    const id = Math.max(20, dam + jitter);

    // Imbalance can spike more
    const imbalance = Math.max(15, dam + jitter * 2.1);

    // aFRR / FCR — flatter, DNV numbers
    const aFrrUp = 8 + Math.abs(Math.sin(h * 0.8)) * 3;   // ~9 EUR/MW/h
    const aFrrDown = 6 + Math.abs(Math.cos(h * 0.9)) * 2;
    const fcr = 65 + Math.abs(Math.sin(h * 0.5)) * 10;    // ~70 EUR/MW/h

    // Load / renewable forecasts
    const demand = 6500 + 1200 * Math.exp(-Math.pow((h - 20) / 3, 2)) +
                          800 * Math.exp(-Math.pow((h - 8) / 3, 2));
    const renewable = 2200 * Math.max(0, Math.sin(((h - 6) / 12) * Math.PI));

    ticks.push({
      timestamp: `${dayStr}T${String(h).padStart(2, '0')}:00:00Z`,
      damPriceEurPerMwh: Number(dam.toFixed(2)),
      idPriceEurPerMwh: Number(id.toFixed(2)),
      imbalancePriceEurPerMwh: Number(imbalance.toFixed(2)),
      aFrrUpwardEurPerMwh: Number(aFrrUp.toFixed(2)),
      aFrrDownwardEurPerMwh: Number(aFrrDown.toFixed(2)),
      fcrEurPerMwPerHour: Number(fcr.toFixed(2)),
      timeOfDay: h,
      demandForecastMw: Math.round(demand),
      renewableForecastMw: Math.round(renewable),
    });
  }
  return ticks;
}

// ============================================================
// Baseline policy — deterministic "charge low, discharge high"
// ============================================================

/**
 * Simple rule-based baseline: charge in the 3 lowest-price hours of the
 * day, discharge in the 3 highest-price hours. Ignores degradation, grid
 * code, and reliability. This is what most current market participants
 * actually do.
 */
export function runBaselinePolicy(asset: BessAsset, ticks: MarketTick[]): PolicyRun {
  const sortedByPrice = [...ticks].sort((a, b) => a.damPriceEurPerMwh - b.damPriceEurPerMwh);
  const chargeHours = new Set(sortedByPrice.slice(0, 3).map((t) => t.timeOfDay));
  const dischargeHours = new Set(sortedByPrice.slice(-3).map((t) => t.timeOfDay));

  const actions: DispatchAction[] = [];
  let soc = asset.socMwh;
  let revenue = 0;
  let mwhCycled = 0;

  for (const tick of ticks) {
    if (chargeHours.has(tick.timeOfDay) && soc < asset.ratedEnergyMwh) {
      const volume = Math.min(asset.ratedPowerMw, asset.ratedEnergyMwh - soc);
      soc += volume;
      mwhCycled += volume;
      revenue -= volume * tick.damPriceEurPerMwh;
      actions.push({
        actionId: uuid(),
        timestamp: tick.timestamp,
        type: 'charge',
        volumeMwh: volume,
        priceEurPerMwh: tick.damPriceEurPerMwh,
        reason: `Lowest-price hour of day (€${tick.damPriceEurPerMwh}/MWh)`,
        confidence: 1.0,
      });
    } else if (dischargeHours.has(tick.timeOfDay) && soc > 0) {
      const volume = Math.min(asset.ratedPowerMw, soc);
      soc -= volume;
      mwhCycled += volume;
      revenue += volume * tick.damPriceEurPerMwh;
      actions.push({
        actionId: uuid(),
        timestamp: tick.timestamp,
        type: 'discharge',
        volumeMwh: volume,
        priceEurPerMwh: tick.damPriceEurPerMwh,
        reason: `Highest-price hour of day (€${tick.damPriceEurPerMwh}/MWh)`,
        confidence: 1.0,
      });
    } else {
      actions.push({
        actionId: uuid(),
        timestamp: tick.timestamp,
        type: 'hold',
        reason: 'Neither top-3 nor bottom-3 price hour',
        confidence: 1.0,
      });
    }
  }

  const degradation = mwhCycled * asset.degradationEurPerMwhCycled;
  return {
    policyName: 'baseline',
    asset: { ...asset, socMwh: soc },
    ticks,
    actions,
    revenueEur: Number(revenue.toFixed(2)),
    degradationCostEur: Number(degradation.toFixed(2)),
    netEur: Number((revenue - degradation).toFixed(2)),
  };
}

// ============================================================
// RONOR governed policy — evidence-attached, MI9-gated
// ============================================================

/**
 * Governed policy skeleton. The AI proposal (GPT-5.6) will fill in the
 * volume / price / confidence details based on:
 *   - price forecast spike detection
 *   - reliability-adjusted reserve bidding
 *   - SoC/degradation-aware cycling
 *   - grid-code voltage compliance
 *
 * This function generates the *deterministic feasibility envelope* around
 * which the AI proposes an optimised dispatch. The residual RL / LLM layer
 * operates inside this envelope, following the "AI proposes, physics
 * disposes" doctrine.
 */
export function generateGovernedEnvelope(
  asset: BessAsset,
  ticks: MarketTick[]
): {
  chargeCandidates: MarketTick[];
  dischargeCandidates: MarketTick[];
  reserveCandidates: MarketTick[];
  maxCyclesPerDay: number;
  socFloorMwh: number;
  socCeilingMwh: number;
} {
  const sortedByPrice = [...ticks].sort(
    (a, b) => a.damPriceEurPerMwh - b.damPriceEurPerMwh
  );
  // Include price spikes (top-30% of the day)
  const priceSpikeThreshold =
    sortedByPrice[Math.floor(ticks.length * 0.7)].damPriceEurPerMwh;
  const priceValleyThreshold =
    sortedByPrice[Math.floor(ticks.length * 0.3)].damPriceEurPerMwh;

  return {
    chargeCandidates: ticks.filter(
      (t) => t.damPriceEurPerMwh <= priceValleyThreshold
    ),
    dischargeCandidates: ticks.filter(
      (t) => t.damPriceEurPerMwh >= priceSpikeThreshold
    ),
    reserveCandidates: ticks.filter((t) => t.fcrEurPerMwPerHour >= 68),
    maxCyclesPerDay: 1.5,      // ANRE Order 46/2024 policy example
    socFloorMwh: asset.ratedEnergyMwh * 0.10,  // 10% reserve
    socCeilingMwh: asset.ratedEnergyMwh * 0.95, // 5% headroom
  };
}

// ============================================================
// Default asset for the demo scenario
// ============================================================

export const DEMO_ASSET: BessAsset = {
  assetId: 'ronor-bess-craiova-01',
  location: 'Craiova, Dolj, RO',
  ratedPowerMw: 5,
  ratedEnergyMwh: 20,
  socMwh: 10,
  degradationEurPerMwhCycled: 8,       // conservative
  inverterMode: 'hybrid',
  gridCodeCompliant: true,
  socIntegrityScore: 0.94,             // Koopman/DMDc plausibility
  voltagePerformanceScore: 0.91,       // STVPI
  reliabilityScore: 0.88,              // probability of reserve delivery
};
