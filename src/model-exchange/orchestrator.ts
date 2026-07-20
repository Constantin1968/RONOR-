/**
 * RONOR Model Exchange × Governance Spine — Unified Orchestrator
 * ──────────────────────────────────────────────────────────────
 * Wires the Model Exchange (Layer 1) through MI9 Gate (Layer 4) and the
 * SHA-256 audit chain (Layer 4) into the Work Ledger (Layer 7).
 *
 * Pipeline for a governed query:
 *
 *   UnifiedRequest
 *      → Policy filter                (which engines are eligible?)
 *      → Dynamic Router               (which engine wins on 6D score?)
 *      → MI9 Gate                     (may the chosen engine act now?)
 *      → Engine execute (or escalate) (produce the answer)
 *      → R-Assurance                  (verify the output)
 *      → Audit chain append           (record decision + result)
 *      → Work Ledger append           (record what was done and what it cost)
 *
 * This is the single narrative of the Build Week 2026 submission:
 *   "RONOR picks the right model, refuses it if governance fails, executes,
 *    verifies, and signs the receipt — end to end."
 */

import { MODEL_REGISTRY, getModel, type ModelRegistryEntry } from "./registry.js";
import { applyPolicies, type UnifiedRequest, type PolicyEvaluation } from "./policy.js";
import { rankModels, type ScoredModel } from "./router.js";
import { executeEngine, type ExecutionResult } from "./engines.js";
import {
  assure,
  computeCost,
  recordWork,
  ensureWorkLedgerSchema,
  type AssuranceReport,
} from "./work-ledger.js";
import { evaluate as evaluateMI9, type MI9Result, type DecisionContext } from "../governance/mi9-gate.js";
import { append as appendAudit, type AuditRecord } from "../audit/hash-chain.js";
import { randomUUID } from "crypto";

export interface QueryOptions {
  /** If true, run policy + router only and return the scoring table (no execute, no MI9, no audit). */
  dryRun?: boolean;
  /** Override the decision context sent to MI9 Gate (defaults derived from request). */
  mi9Context?: Partial<DecisionContext>;
}

export interface UnifiedQueryResult {
  request_id: string;
  eligible_models: string[];
  policy_evaluations: PolicyEvaluation[];
  routing_table: ScoredModel[];
  chosen_model_id: string | null;
  rejected: boolean;
  rejection_reason: string | null;
  mi9?: MI9Result;
  execution?: ExecutionResult;
  assurance?: AssuranceReport;
  audit_record?: AuditRecord;
  cost_usd: number;
  latency_ms: number;
  status: "completed" | "rejected-policy" | "rejected-governance" | "escalated" | "failed";
}

/**
 * Boot the Work Ledger schema. Safe to call multiple times.
 */
export function initModelExchange(): void {
  ensureWorkLedgerSchema();
}

export async function runUnifiedQuery(
  request: UnifiedRequest,
  options: QueryOptions = {},
): Promise<UnifiedQueryResult> {
  const started = Date.now();
  const request_id = `req-${randomUUID().slice(0, 8)}`;

  // ---- Stage 1: Policy filter --------------------------------------------
  const policy = applyPolicies(request, MODEL_REGISTRY);

  if (policy.rejected) {
    return {
      request_id,
      eligible_models: [],
      policy_evaluations: policy.evaluations,
      routing_table: [],
      chosen_model_id: null,
      rejected: true,
      rejection_reason: policy.rejectionReason,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      status: "rejected-policy",
    };
  }

  // ---- Stage 2: Dynamic Router -------------------------------------------
  const routing = rankModels(policy.eligible, request, policy.deterministicFirst);
  const winner = routing[0];

  if (options.dryRun) {
    return {
      request_id,
      eligible_models: policy.eligible.map((m) => m.id),
      policy_evaluations: policy.evaluations,
      routing_table: routing,
      chosen_model_id: winner?.model_id ?? null,
      rejected: false,
      rejection_reason: null,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      status: "completed",
    };
  }

  if (!winner) {
    return {
      request_id,
      eligible_models: [],
      policy_evaluations: policy.evaluations,
      routing_table: [],
      chosen_model_id: null,
      rejected: true,
      rejection_reason: "Router produced no ranked candidate.",
      cost_usd: 0,
      latency_ms: Date.now() - started,
      status: "rejected-policy",
    };
  }

  const chosenModel = getModel(winner.model_id);
  if (!chosenModel) {
    return {
      request_id,
      eligible_models: policy.eligible.map((m) => m.id),
      policy_evaluations: policy.evaluations,
      routing_table: routing,
      chosen_model_id: winner.model_id,
      rejected: true,
      rejection_reason: `Chosen model ${winner.model_id} not found in registry.`,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      status: "failed",
    };
  }

  // ---- Stage 3: MI9 Gate -------------------------------------------------
  const mi9Context = buildDecisionContext(request, chosenModel, winner, request_id, options.mi9Context);
  const mi9 = evaluateMI9(mi9Context);

  if (mi9.verdict === "block") {
    // Record refused decision in audit chain
    const auditRecord = appendAudit({
      decisionId: request_id,
      decisionType: `model-exchange.${request.task_type}`,
      timestamp: new Date().toISOString(),
      context: mi9Context,
      mi9Result: mi9,
      aiProposal: {
        model: chosenModel.id,
        rationale: `Router selected ${chosenModel.display_name} (score ${winner.total}). MI9 Gate blocked action.`,
      },
      outcome: {
        action: "blocked",
      },
      metadata: {
        routing_table_head: routing.slice(0, 3).map((r) => ({ id: r.model_id, total: r.total })),
        block_reason: mi9.blockReason,
      },
    });

    recordWork({
      mission_id: request.mission_id,
      operator_id: request.operator_id,
      task_type: request.task_type,
      chosen_model_id: chosenModel.id,
      status: "rejected",
      input_tokens: 0,
      output_tokens: 0,
      cost_usd: 0,
      latency_ms: 0,
      simulated: false,
      verified_confidence: null,
      trace_hash: auditRecord.chainHash,
    });

    return {
      request_id,
      eligible_models: policy.eligible.map((m) => m.id),
      policy_evaluations: policy.evaluations,
      routing_table: routing,
      chosen_model_id: chosenModel.id,
      rejected: true,
      rejection_reason: `MI9 Gate blocked action: ${mi9.blockReason ?? "policy violation"}`,
      mi9,
      audit_record: auditRecord,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      status: "rejected-governance",
    };
  }

  // ---- Stage 4: Engine execute -------------------------------------------
  const execution = await executeEngine(chosenModel, request);

  if (!execution.ok) {
    // Try fallback to next eligible model
    for (let i = 1; i < routing.length; i++) {
      const nextCandidate = getModel(routing[i].model_id);
      if (!nextCandidate) continue;
      const retry = await executeEngine(nextCandidate, request);
      if (retry.ok) {
        return finaliseQuery(
          request,
          request_id,
          started,
          policy.evaluations,
          routing,
          nextCandidate,
          retry,
          mi9,
          mi9Context,
          "escalated",
        );
      }
    }

    // All engines failed
    return {
      request_id,
      eligible_models: policy.eligible.map((m) => m.id),
      policy_evaluations: policy.evaluations,
      routing_table: routing,
      chosen_model_id: chosenModel.id,
      rejected: true,
      rejection_reason: `All engines failed. Last error: ${execution.error ?? "unknown"}`,
      mi9,
      execution,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      status: "failed",
    };
  }

  return finaliseQuery(
    request,
    request_id,
    started,
    policy.evaluations,
    routing,
    chosenModel,
    execution,
    mi9,
    mi9Context,
    "completed",
  );
}

function finaliseQuery(
  request: UnifiedRequest,
  request_id: string,
  started: number,
  policy_evaluations: PolicyEvaluation[],
  routing: ScoredModel[],
  chosenModel: ModelRegistryEntry,
  execution: ExecutionResult,
  mi9: MI9Result,
  mi9Context: DecisionContext,
  status: "completed" | "escalated",
): UnifiedQueryResult {
  const assurance = assure(chosenModel, execution);
  const cost_usd = computeCost(chosenModel, execution.input_tokens ?? 0, execution.output_tokens ?? 0);

  const auditRecord = appendAudit({
    decisionId: request_id,
    decisionType: `model-exchange.${request.task_type}`,
    timestamp: new Date().toISOString(),
    context: mi9Context,
    mi9Result: mi9,
    aiProposal: {
      model: chosenModel.id,
      rationale: `Router selected ${chosenModel.display_name} (score ${routing[0]?.total}). Executed via ${chosenModel.engine} adapter.`,
      tokensUsed: (execution.input_tokens ?? 0) + (execution.output_tokens ?? 0),
      latencyMs: execution.latency_ms,
    },
    outcome: {
      action: mi9.humanCoSignRequired ? "held-for-cosign" : "executed",
    },
    metadata: {
      routing_head: routing.slice(0, 3).map((r) => ({ id: r.model_id, total: r.total })),
      cost_usd,
      verified_confidence: assurance.verified_confidence,
      simulated: execution.simulated,
    },
  });

  recordWork({
    mission_id: request.mission_id,
    operator_id: request.operator_id,
    task_type: request.task_type,
    chosen_model_id: chosenModel.id,
    status: status === "escalated" ? "escalated" : "completed",
    input_tokens: execution.input_tokens ?? 0,
    output_tokens: execution.output_tokens ?? 0,
    cost_usd,
    latency_ms: execution.latency_ms ?? 0,
    simulated: execution.simulated,
    verified_confidence: assurance.verified_confidence,
    trace_hash: auditRecord.chainHash,
  });

  return {
    request_id,
    eligible_models: routing.map((r) => r.model_id),
    policy_evaluations,
    routing_table: routing,
    chosen_model_id: chosenModel.id,
    rejected: false,
    rejection_reason: null,
    mi9,
    execution,
    assurance,
    audit_record: auditRecord,
    cost_usd,
    latency_ms: Date.now() - started,
    status,
  };
}

// ---------------------------------------------------------------------------
// Decision context builder — bridges Model Exchange request → MI9 Gate context
// ---------------------------------------------------------------------------
function buildDecisionContext(
  request: UnifiedRequest,
  chosenModel: ModelRegistryEntry,
  scored: ScoredModel,
  request_id: string,
  overrides?: Partial<DecisionContext>,
): DecisionContext {
  // Map model jurisdictions to policy-recognised data residency zones.
  // Sovereign / self-hosted models are Ronor-controlled → default EU (Romania/UK).
  // US-only public providers keep 'us' unless the request itself is sovereign.
  const isSovereign = request.confidentiality_level === "sovereign";
  const jur = chosenModel.jurisdictions;
  const dataResidency: DecisionContext["sovereignty"]["dataResidency"] = isSovereign
    ? "eu"
    : jur.includes("EU") || jur.includes("UK") || jur.includes("RO") || jur.includes("FR")
      ? "eu"
      : jur.includes("sovereign") || jur.includes("self-hosted")
        ? "eu" // Ronor-controlled → EU by default
        : jur.includes("US")
          ? "us"
          : "eu";

  const base: DecisionContext = {
    decisionId: request_id,
    domain: `model-exchange.${request.task_type}`,
    action: `Route ${request.task_type} query to ${chosenModel.display_name}`,
    proposedBy: chosenModel.id,
    confidence: Math.max(0, Math.min(1, scored.total / 200 + 0.5)),
    reversible: true,
    impactMagnitude: {
      unit: "EUR",
      value: scored.estimated_cost_usd,
    },
    sovereignty: {
      dataResidency,
      subjectJurisdiction: "RO",
    },
    evidence: {
      sourceCount: 1,
      lastRefreshMs: 0,
      consensusReached: false,
    },
    operator: {
      userId: request.operator_id,
      role: "operator",
    },
    metadata: {
      chosen_model: chosenModel.id,
      sovereignty_level: chosenModel.sovereignty_level,
      simulated: chosenModel.status === "simulated",
    },
  };

  return { ...base, ...overrides };
}
