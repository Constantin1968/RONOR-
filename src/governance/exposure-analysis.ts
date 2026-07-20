/**
 * Exposure Analysis Module — RONOR Build Week
 *
 * A formal risk-register attached to every decision. Answers the question a
 * bank, insurer, TSO, or CFO asks before approving any AI-driven action:
 *
 *   "What is our concrete exposure if this decision is executed and
 *    something goes wrong?"
 *
 * Exposure is decomposed into eight dimensions:
 *
 *   1. financial          — worst-case EUR loss if the action fails
 *   2. regulatory         — EU AI Act / ANRE / OPCOM violation surface
 *   3. operational        — SoC breach, degradation over-cycle, delivery failure
 *   4. reputational       — public / stakeholder visibility of a failure
 *   5. counterparty       — market / delivery-side default risk
 *   6. cyber              — data-integrity / spoofing / injection surface
 *   7. model              — frontier-model drift / hallucination / fallback risk
 *   8. sovereignty        — data-residency / cross-border exposure
 *
 * Each dimension gets a score in [0, 1] and a EUR-equivalent exposure. The
 * aggregate ExposureRecord is canonicalised and its SHA-256 fingerprint is
 * emitted alongside the MI9 verdict, so the exposure fingerprint becomes
 * part of the audit chain payload. Any tampering with the risk assessment
 * breaks the chain the same way a tampered decision does.
 *
 * Doctrine: exposure is not a hidden internal metric. It is a first-class,
 * cryptographically anchored artefact that a lender or regulator can
 * independently reconstruct from the exported chain.
 */

import * as crypto from 'crypto';
import { createLogger } from '../utils/logger';
import { canonicalStringify } from '../audit/hash-chain';
import type { DecisionContext } from './mi9-gate';

const logger = createLogger('ExposureAnalysis');

// ============================================================
// Types
// ============================================================

export type ExposureDimension =
  | 'financial'
  | 'regulatory'
  | 'operational'
  | 'reputational'
  | 'counterparty'
  | 'cyber'
  | 'model'
  | 'sovereignty';

export type ExposureTier = 'low' | 'moderate' | 'elevated' | 'high' | 'critical';

export interface DimensionFinding {
  dimension: ExposureDimension;
  score: number;                   // 0..1
  eurEquivalent: number;           // best-effort worst-case EUR
  tier: ExposureTier;
  drivers: string[];               // human-readable reasons
  mitigations: string[];           // controls already in place
  residualEurAfterMitigation: number;
}

export interface ExposureRecord {
  decisionId: string;
  evaluatedAt: string;             // ISO
  moduleVersion: string;
  findings: DimensionFinding[];
  aggregateScore: number;          // weighted 0..1
  aggregateTier: ExposureTier;
  worstCaseEur: number;            // sum of pre-mitigation
  residualExposureEur: number;     // sum of post-mitigation
  exposureFingerprint: string;     // SHA-256 of canonical findings block
  narrative: string;               // one-paragraph plain-English summary
  advisory: 'proceed' | 'proceed-with-controls' | 'defer' | 'reject';
}

// ============================================================
// Config
// ============================================================

const MODULE_VERSION = 'exposure-analysis-2026.07.20';

// Dimension weights (must sum to 1.0). Calibrated for Romanian BESS/VPP
// operations where financial + regulatory dominate.
const WEIGHTS: Record<ExposureDimension, number> = {
  financial:     0.22,
  regulatory:    0.18,
  operational:   0.14,
  reputational:  0.08,
  counterparty:  0.10,
  cyber:         0.10,
  model:         0.10,
  sovereignty:   0.08,
};

function tierFromScore(score: number): ExposureTier {
  if (score < 0.15) return 'low';
  if (score < 0.30) return 'moderate';
  if (score < 0.50) return 'elevated';
  if (score < 0.75) return 'high';
  return 'critical';
}

function advisoryFromAggregate(score: number, findings: DimensionFinding[]): ExposureRecord['advisory'] {
  const anyCritical = findings.some((f) => f.tier === 'critical');
  if (anyCritical) return 'reject';
  if (score >= 0.65) return 'defer';
  if (score >= 0.35) return 'proceed-with-controls';
  return 'proceed';
}

// ============================================================
// Individual dimension evaluators
// ============================================================

function financialExposure(ctx: DecisionContext): DimensionFinding {
  const { unit, value } = ctx.impactMagnitude;
  const eur = unit === 'EUR' ? Math.abs(value) : Math.abs(value) * 140; // €140/MWh peak proxy
  // Worst case: 2× the transaction (imbalance + penalty). Then confidence-weighted.
  const worst = eur * 2;
  const score = Math.min(1, worst / 100000);         // €100k = score 1
  const mitigated = worst * (1 - 0.6 * ctx.confidence); // confidence + MI9 = 60% mitigation
  return {
    dimension: 'financial',
    score,
    eurEquivalent: Number(worst.toFixed(2)),
    tier: tierFromScore(score),
    drivers: [
      `Transaction impact: ${value} ${unit}`,
      `Worst-case doubled by imbalance + penalty exposure`,
    ],
    mitigations: [
      `Model confidence ${ctx.confidence.toFixed(2)}`,
      `MI9 gate 4 (impact) enforces €10k escalation / €100k block`,
      `Deterministic fallback available: ${ctx.metadata?.fallbackAvailable ? 'yes' : 'no'}`,
    ],
    residualEurAfterMitigation: Number(mitigated.toFixed(2)),
  };
}

function regulatoryExposure(ctx: DecisionContext): DimensionFinding {
  // EU AI Act high-risk domains carry regulatory tail-risk.
  const isHighRisk = /(bess|vpp|ancillary|dispatch|bid)/.test(ctx.domain);
  const base = isHighRisk ? 0.55 : 0.15;
  const drivers = [
    `Domain: ${ctx.domain}`,
    isHighRisk ? 'Classified high-risk under EU AI Act mapping' : 'Minimal/limited-risk domain',
  ];
  const mitigations = [
    'Audit chain retention >= 6 months (EU AI Act §12)',
    'ANRE Order 46/2024 compliance flag attached',
    'Human co-sign path enforced for high-risk domains',
  ];
  // Regulatory fines: EU AI Act up to €35M or 7% of global turnover.
  // For a pilot-scale operator we cap the worst-case at €500k realistic exposure.
  const worst = isHighRisk ? 500000 : 25000;
  const mitigated = worst * 0.15;                    // strong mitigation from audit chain
  return {
    dimension: 'regulatory',
    score: base,
    eurEquivalent: worst,
    tier: tierFromScore(base),
    drivers,
    mitigations,
    residualEurAfterMitigation: mitigated,
  };
}

function operationalExposure(ctx: DecisionContext): DimensionFinding {
  const socIntegrity = (ctx.metadata?.socIntegrityScore as number) ?? 0.9;
  const voltage = (ctx.metadata?.voltagePerformanceScore as number) ?? 0.9;
  const reliability = (ctx.metadata?.reliabilityScore as number) ?? 0.9;
  const score = 1 - (socIntegrity * 0.4 + voltage * 0.3 + reliability * 0.3);
  const worst = 30000;                               // BESS forced-derating incident
  const mitigated = worst * score;
  return {
    dimension: 'operational',
    score,
    eurEquivalent: worst,
    tier: tierFromScore(score),
    drivers: [
      `SoC integrity (Koopman/DMDc): ${socIntegrity.toFixed(2)}`,
      `Voltage performance (STVPI): ${voltage.toFixed(2)}`,
      `Reliability (P delivery): ${reliability.toFixed(2)}`,
    ],
    mitigations: [
      'Inverter-aware dispatch envelope enforced',
      'SoC floor/ceiling policy honoured',
      'Grid-code compliance flag required in registry',
    ],
    residualEurAfterMitigation: Number(mitigated.toFixed(2)),
  };
}

function reputationalExposure(ctx: DecisionContext): DimensionFinding {
  // Public visibility scales with impact and reversibility.
  const magnitude = ctx.impactMagnitude.unit === 'EUR' ? Math.abs(ctx.impactMagnitude.value) : 5000;
  const score = Math.min(1, (magnitude / 50000) * (ctx.reversible ? 0.5 : 1));
  return {
    dimension: 'reputational',
    score,
    eurEquivalent: 20000,                            // one incident's PR + investor cost
    tier: tierFromScore(score),
    drivers: [
      `Action reversible: ${ctx.reversible}`,
      `Public-market visibility scales with EUR magnitude`,
    ],
    mitigations: [
      'MI9 escalation path avoids irreversible headlines',
      'Every decision is publicly verifiable via audit chain',
    ],
    residualEurAfterMitigation: 20000 * score * 0.4,
  };
}

function counterpartyExposure(ctx: DecisionContext): DimensionFinding {
  const reliability = (ctx.metadata?.reliabilityScore as number) ?? 0.9;
  const score = Math.min(1, (1 - reliability) * 1.5);
  return {
    dimension: 'counterparty',
    score,
    eurEquivalent: 15000,
    tier: tierFromScore(score),
    drivers: [
      `Reserve delivery probability: ${reliability.toFixed(2)}`,
      `Market counterparty default risk (OPCOM/TSO)`,
    ],
    mitigations: [
      'Reliability-adjusted bidding (Nordic FCR-D pattern)',
      'Penalty exposure priced into bid confidence',
    ],
    residualEurAfterMitigation: 15000 * score * 0.5,
  };
}

function cyberExposure(ctx: DecisionContext): DimensionFinding {
  // Higher if operator role is external, or if evidence sources < 2.
  const externalRole = ctx.operator.role === 'external';
  const evidenceThin = ctx.evidence.sourceCount < 2;
  let score = 0.15;
  if (externalRole) score += 0.20;
  if (evidenceThin) score += 0.15;
  return {
    dimension: 'cyber',
    score: Math.min(1, score),
    eurEquivalent: 40000,
    tier: tierFromScore(Math.min(1, score)),
    drivers: [
      `Operator role: ${ctx.operator.role}`,
      `Evidence source count: ${ctx.evidence.sourceCount}`,
    ],
    mitigations: [
      'SHA-256 hash-chain detects any tampering',
      'Canonical JSON payload prevents re-serialisation attacks',
      'Per-record UUID + timestamp + prev-hash triple-binding',
    ],
    residualEurAfterMitigation: 40000 * Math.min(1, score) * 0.25,
  };
}

function modelExposure(ctx: DecisionContext): DimensionFinding {
  // Model drift and hallucination risk are inversely proportional to confidence.
  const score = Math.max(0, 1 - ctx.confidence) * 0.7 + 0.10;
  const usesFallback = ctx.proposedBy.includes('fallback');
  return {
    dimension: 'model',
    score,
    eurEquivalent: 12000,
    tier: tierFromScore(score),
    drivers: [
      `Model: ${ctx.proposedBy}`,
      `Confidence: ${ctx.confidence.toFixed(2)}`,
      usesFallback ? 'Deterministic fallback used' : 'Frontier model in the loop',
    ],
    mitigations: [
      'Deterministic fallback path always available',
      'Governed envelope constrains model output',
      'MI9 gate 5 (confidence) enforces autonomous / co-sign / escalate floors',
    ],
    residualEurAfterMitigation: 12000 * score * 0.35,
  };
}

function sovereigntyExposure(ctx: DecisionContext): DimensionFinding {
  const roMisrouted =
    ctx.sovereignty.subjectJurisdiction === 'RO' && ctx.sovereignty.dataResidency !== 'eu';
  const score = roMisrouted ? 0.85 : 0.10;
  return {
    dimension: 'sovereignty',
    score,
    eurEquivalent: roMisrouted ? 200000 : 5000,
    tier: tierFromScore(score),
    drivers: [
      `Subject jurisdiction: ${ctx.sovereignty.subjectJurisdiction}`,
      `Data residency: ${ctx.sovereignty.dataResidency}`,
    ],
    mitigations: [
      'MI9 gate 1 (sovereignty) blocks non-EU residency for RO subjects',
      'Audit chain is EU-hosted by construction',
    ],
    residualEurAfterMitigation: roMisrouted ? 200000 * 0.2 : 500,
  };
}

// ============================================================
// Aggregation + fingerprinting
// ============================================================

function aggregate(findings: DimensionFinding[]): {
  aggregateScore: number;
  worstCaseEur: number;
  residualExposureEur: number;
} {
  let aggregateScore = 0;
  let worst = 0;
  let residual = 0;
  for (const f of findings) {
    aggregateScore += f.score * WEIGHTS[f.dimension];
    worst += f.eurEquivalent;
    residual += f.residualEurAfterMitigation;
  }
  return {
    aggregateScore: Number(aggregateScore.toFixed(4)),
    worstCaseEur: Number(worst.toFixed(2)),
    residualExposureEur: Number(residual.toFixed(2)),
  };
}

function fingerprint(findings: DimensionFinding[]): string {
  const canon = canonicalStringify(findings);
  return crypto.createHash('sha256').update(canon, 'utf8').digest('hex');
}

function narrativeFor(record: Omit<ExposureRecord, 'narrative' | 'advisory'>): string {
  const highest = [...record.findings].sort((a, b) => b.score - a.score).slice(0, 3);
  const parts = highest.map(
    (f) =>
      `${f.dimension} (${f.tier}, €${Math.round(f.eurEquivalent)} worst-case, €${Math.round(
        f.residualEurAfterMitigation
      )} residual)`
  );
  return (
    `Aggregate exposure: ${tierFromScore(record.aggregateScore)} ` +
    `(score ${record.aggregateScore.toFixed(3)}, worst-case €${Math.round(record.worstCaseEur)}, ` +
    `residual after RONOR controls €${Math.round(record.residualExposureEur)}). ` +
    `Top drivers: ${parts.join('; ')}.`
  );
}

// ============================================================
// Public API
// ============================================================

export function analyzeExposure(ctx: DecisionContext): ExposureRecord {
  const findings: DimensionFinding[] = [
    financialExposure(ctx),
    regulatoryExposure(ctx),
    operationalExposure(ctx),
    reputationalExposure(ctx),
    counterpartyExposure(ctx),
    cyberExposure(ctx),
    modelExposure(ctx),
    sovereigntyExposure(ctx),
  ];

  const agg = aggregate(findings);
  const aggregateTier = tierFromScore(agg.aggregateScore);
  const advisory = advisoryFromAggregate(agg.aggregateScore, findings);

  const base: Omit<ExposureRecord, 'narrative' | 'advisory'> = {
    decisionId: ctx.decisionId,
    evaluatedAt: new Date().toISOString(),
    moduleVersion: MODULE_VERSION,
    findings,
    aggregateScore: agg.aggregateScore,
    aggregateTier,
    worstCaseEur: agg.worstCaseEur,
    residualExposureEur: agg.residualExposureEur,
    exposureFingerprint: fingerprint(findings),
  };

  const record: ExposureRecord = {
    ...base,
    narrative: narrativeFor(base),
    advisory,
  };

  logger.info(
    `Exposure decision=${ctx.decisionId} tier=${aggregateTier} score=${agg.aggregateScore.toFixed(3)} worst=€${Math.round(agg.worstCaseEur)} residual=€${Math.round(agg.residualExposureEur)} advisory=${advisory} fp=${record.exposureFingerprint.slice(0, 16)}…`
  );

  return record;
}

export function getModuleVersion(): string {
  return MODULE_VERSION;
}

export const WEIGHTS_SNAPSHOT = WEIGHTS;
