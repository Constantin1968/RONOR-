/**
 * RONOR Runtime — L0 · Governance Bridge
 * ──────────────────────────────────────
 * Translates a runtime request into the `DecisionContext` that MI9 Gate already
 * evaluates, and writes the outcome into the SHA-256 audit chain that already
 * exists. The bridge is the reason Runtime Active inherits governance rather than
 * reimplementing it: the nine gates, the policy file and the chain are unchanged,
 * and every new surface passes through them.
 *
 * The translation makes three judgements explicit rather than leaving them
 * implicit in code:
 *
 *   1. WHICH REQUESTS ARE CONSEQUENTIAL. Answering a question is not the same
 *      kind of act as dispatching a battery. A read-only query is mapped to a low
 *      impact magnitude and marked reversible; an agent mission that will call
 *      tools is not. Treating every query as a dispatch decision would make the
 *      gate fire constantly and train operators to click through it, which is
 *      worse than not having a gate.
 *
 *   2. EVIDENCE AGE IS REAL OR ABSENT. `lastRefreshMs` is taken from actual
 *      retrieval metadata when the knowledge plane served context, and set to a
 *      deliberately large value when the answer rests only on model weights. A
 *      convenient small default here would let Gate 5 pass on evidence that does
 *      not exist.
 *
 *   3. CONFIDENCE IS NOT INVENTED. Where the runtime has a verified confidence
 *      from the Evidence Curator it is used. Where it does not, the value is
 *      derived from the routed engine's catalogue quality and marked as such in
 *      metadata, so a reviewer can see that the number is a property of the
 *      engine rather than an assessment of the answer.
 *
 * Prepared by AMB.
 */

import { append, type AuditRecord } from '../../audit/hash-chain';
import { evaluate, type DecisionContext, type MI9Result } from '../../governance/mi9-gate';
import type { ConfidentialityLevel } from '../router/policy';

/** The gate's residency vocabulary, reused rather than restated. */
type DataResidency = DecisionContext['sovereignty']['dataResidency'];

export type RuntimeSurface = 'query' | 'agent' | 'worker' | 'tool' | 'ingest';

export interface GovernanceInput {
  requestId: string;
  surface: RuntimeSurface;
  /** Free-text description of what the runtime is about to do. */
  action: string;
  taskType: string;
  confidentiality: ConfidentialityLevel;
  /** Engine that will answer, once routing has chosen one. */
  proposedBy: string;
  /** 0..1. Supply a measured value when one exists. */
  confidence: number;
  /** True when the confidence figure is a measurement, not an engine property. */
  confidenceMeasured: boolean;
  /** Number of retrieved sources backing the answer. */
  sourceCount: number;
  /** Age of the freshest evidence in ms, or null when no evidence was retrieved. */
  evidenceAgeMs: number | null;
  operatorId?: string | null;
  operatorRole?: 'operator' | 'dispatcher' | 'auditor' | 'external';
  /** True when the request will cause a side effect beyond returning text. */
  hasSideEffects: boolean;
  /** Monetary or physical magnitude, when the request carries one. */
  impact?: { unit: 'EUR' | 'MWh' | 'MW' | 'other'; value: number };
  missionId?: string | null;
  metadata?: Record<string, unknown>;
}

/**
 * Age assigned when an answer rests on model weights alone.
 *
 * Set to 30 days deliberately. Parametric knowledge has no refresh timestamp,
 * and pretending otherwise is how an unsourced assertion acquires the appearance
 * of currency. A large value makes Gate 5 treat the answer as stale, which for
 * an unsourced claim is the correct posture.
 */
export const PARAMETRIC_EVIDENCE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Declared data residency for a request.
 *
 * Always `eu`, and never the wildcard `any`.
 *
 * The first version of this function returned `'any'` for public and internal
 * material, which caused Gate 1 to block every ordinary query. The gate was
 * right and this function was wrong: `any` is not a residency, it is the REFUSAL
 * to state one, and a sovereignty gate should decline a request that will not say
 * where the data will live. The correct fix was to make an accurate declaration
 * rather than to widen the policy's allow-list.
 *
 * `eu` is accurate for this deployment: the default gateway egress and the vector
 * store are both EU-resident. A deployment on non-EU infrastructure MUST derive
 * this from real deployment topology. Note what it must not be derived from: the
 * sensitivity of the request. Where data lives is a property of the
 * infrastructure, and letting a caller's confidentiality label imply a residency
 * would allow a mislabelled request to assert a location it has no power to
 * change.
 */
export function residencyFor(_confidentiality: ConfidentialityLevel): DataResidency {
  return 'eu';
}

export function buildDecisionContext(input: GovernanceInput): DecisionContext {
  const residency = residencyFor(input.confidentiality);

  return {
    decisionId: input.requestId,
    domain: `runtime.${input.surface}.${input.taskType}`,
    action: input.action.slice(0, 500),
    proposedBy: input.proposedBy,
    confidence: clamp01(input.confidence),
    // A request that only returns text is reversible: nothing in the world
    // changed. A request that invokes tools is not, and must not be waved
    // through by the same gate configuration.
    reversible: !input.hasSideEffects,
    impactMagnitude: input.impact ?? {
      unit: 'other',
      // Read-only work carries a nominal magnitude so Gate 3 has a number to
      // reason about without being told that answering a question is free of
      // consequence.
      value: input.hasSideEffects ? 1000 : 1,
    },
    sovereignty: {
      dataResidency: residency,
      subjectJurisdiction: 'EU',
    },
    evidence: {
      sourceCount: input.sourceCount,
      lastRefreshMs: input.evidenceAgeMs ?? PARAMETRIC_EVIDENCE_AGE_MS,
      // Consensus requires corroboration, which requires more than one source.
      consensusReached: input.sourceCount >= 2,
    },
    operator: {
      userId: input.operatorId ?? undefined,
      role: input.operatorRole ?? 'operator',
    },
    metadata: {
      surface: input.surface,
      confidentiality: input.confidentiality,
      mission_id: input.missionId ?? null,
      confidence_measured: input.confidenceMeasured,
      confidence_basis: input.confidenceMeasured
        ? 'verified-by-evidence-curator'
        : 'derived-from-engine-catalogue-quality',
      evidence_basis: input.evidenceAgeMs === null ? 'parametric-only' : 'retrieved',
      ...input.metadata,
    },
  };
}

export interface GovernanceVerdict {
  mi9: MI9Result;
  context: DecisionContext;
  /** True when the request may proceed to execution. */
  allowed: boolean;
  /** True when execution may proceed but a human must co-sign the result. */
  requiresCoSign: boolean;
  blockReason: string | null;
}

export function evaluateGovernance(input: GovernanceInput): GovernanceVerdict {
  const context = buildDecisionContext(input);
  const mi9 = evaluate(context);
  return {
    mi9,
    context,
    // `escalate` does not stop the runtime from producing an answer; it stops the
    // answer from being treated as authoritative. Only `block` prevents work.
    allowed: mi9.verdict !== 'block',
    requiresCoSign: mi9.humanCoSignRequired,
    blockReason: mi9.blockReason ?? null,
  };
}

export interface AuditOutcome {
  action: 'executed' | 'held-for-cosign' | 'escalated' | 'blocked';
  model: string;
  rationale: string;
  tokensUsed?: number;
  latencyMs?: number;
  baselineValue?: number;
  proposedValue?: number;
  incrementalGain?: number;
  unit?: string;
  metadata?: Record<string, unknown>;
}

/** Map an MI9 verdict to the audit chain's outcome vocabulary. */
export function outcomeActionFor(
  verdict: MI9Result['verdict'],
  executed: boolean,
): AuditOutcome['action'] {
  if (verdict === 'block') return 'blocked';
  if (!executed) return 'escalated';
  if (verdict === 'allow-with-cosign') return 'held-for-cosign';
  if (verdict === 'escalate') return 'escalated';
  return 'executed';
}

/**
 * Write the request to the audit chain.
 *
 * Called on every terminal path. A chain that records only successful requests
 * cannot answer the question an auditor actually asks, which is "what did this
 * system refuse, and why".
 */
export function writeAuditRecord(params: {
  verdict: GovernanceVerdict;
  outcome: AuditOutcome;
  surface: RuntimeSurface;
}): AuditRecord {
  return append({
    decisionId: params.verdict.context.decisionId,
    decisionType: params.verdict.context.domain,
    timestamp: new Date().toISOString(),
    context: params.verdict.context,
    mi9Result: params.verdict.mi9,
    aiProposal: {
      model: params.outcome.model,
      rationale: params.outcome.rationale.slice(0, 2000),
      tokensUsed: params.outcome.tokensUsed,
      latencyMs: params.outcome.latencyMs,
    },
    outcome: {
      action: params.outcome.action,
      baselineValue: params.outcome.baselineValue,
      proposedValue: params.outcome.proposedValue,
      incrementalGain: params.outcome.incrementalGain,
      unit: params.outcome.unit,
    },
    metadata: {
      runtime_surface: params.surface,
      runtime_version: 'runtime-active',
      ...params.outcome.metadata,
    },
  });
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Derive a confidence figure from a routed engine's catalogue quality.
 *
 * Used only when nothing better exists. Deliberately capped below 0.9: an
 * unverified answer from an excellent model is still unverified, and allowing it
 * to present as near-certain would let Gate 4 pass on the reputation of the
 * engine rather than the quality of the evidence.
 */
export function deriveConfidenceFromQuality(qualityScore: number): number {
  return Math.min(0.9, Math.max(0.3, qualityScore / 100));
}
