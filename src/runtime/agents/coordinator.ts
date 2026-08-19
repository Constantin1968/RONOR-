/**
 * RONOR Runtime — L3 · Mission Coordinator
 * ────────────────────────────────────────
 * Governs, decomposes, dispatches, synthesises and accounts for a multi-agent
 * mission. This is where the runtime becomes an intelligence system rather than
 * a proxy with a router.
 *
 * Order of operations, and why:
 *
 *   1. GOVERN FIRST. MI9 evaluates the mission BEFORE any worker runs, because a
 *      mission is a multiplied commitment: a blocked mission costs nothing, while
 *      a mission blocked after four workers have run has already spent the money
 *      the gate existed to protect.
 *   2. DECOMPOSE, THEN VALIDATE. The plan is repaired into something executable
 *      and every repair is recorded.
 *   3. DISPATCH RESPECTING DEPENDENCIES, WITH A BUDGET CEILING CHECKED BETWEEN
 *      TASKS. A mission that overruns its budget is HALTED and returns partial
 *      results marked as partial. Silently completing an over-budget mission
 *      would make `max_cost_usd` advisory, and an advisory budget is not a
 *      control.
 *   4. SYNTHESISE FROM WORKER OUTPUT ONLY. The synthesiser is forbidden to
 *      introduce facts. Its confidence is the CURATOR'S figure where one exists,
 *      never its own — the reviewer's judgement is the whole point of having a
 *      reviewer.
 *   5. LEDGER AND AUDIT EVERY TASK AND THE MISSION. Each worker's inference is a
 *      ledger row of its own, so cost is attributable per agent rather than
 *      pooled into an opaque mission total.
 *
 * Prepared by AMB.
 */

import {
  deriveConfidenceFromQuality,
  evaluateGovernance,
  outcomeActionFor,
  recordGovernedExecution,
  writeAuditRecord,
} from '../api/governance-bridge';
import type { Provenance } from '../api/middleware';
import { createPendingExecution } from '../api/approval-settlement';
import { executeExchange } from '../router/exchange';
import type { ConfidentialityLevel, JurisdictionPin } from '../router/policy';
import { recordAttempts, recordWork } from '../ledgers/work-ledger';
import { recordValue } from '../ledgers/cost-ledger';
import { appendToMission, createMission, getMission, setMissionStatus } from '../mission/store';
import { decomposeObjective, type PlannedTask } from './decompose';
import { agentsFor, getPassport } from './registry';
import { planToolCalls, runWorker, type WorkerFinding, type WorkerResult } from './workers';

export interface MissionDispatchRequest {
  objective: string;
  title?: string;
  mission_id?: string | null;
  confidentiality_level: ConfidentialityLevel;
  jurisdiction_pin?: JurisdictionPin;
  max_cost_usd?: number;
  max_tasks?: number;
  operator_id?: string | null;
  use_knowledge?: boolean;
  require_evidence?: boolean;
}

export interface MissionTaskReport {
  task_id: string;
  agent_id: string;
  instruction: string;
  depends_on: string[];
  ok: boolean;
  model_id: string | null;
  cost_usd: number;
  latency_ms: number;
  confidence: number;
  findings: number;
  gaps: string[];
  structure_degraded: boolean;
  tools_used: Array<{ tool: string; ok: boolean; error: string | null }>;
  error: string | null;
}

export interface MissionDispatchResult {
  ok: boolean;
  request_id: string;
  mission_id: string;
  status: 'complete' | 'partial' | 'blocked' | 'failed';
  objective: string;
  synthesis: string;
  findings: WorkerFinding[];
  gaps: string[];
  /** The Curator's figure when one exists; otherwise the weakest worker's. */
  confidence: number;
  confidence_source: 'evidence-curator' | 'weakest-worker' | 'none';
  citations: Array<{ title: string; url?: string; snippet?: string }>;
  plan: {
    tasks: PlannedTask[];
    fallback_used: boolean;
    planner_model: string | null;
    repairs: string[];
    reason: string | null;
  };
  tasks: MissionTaskReport[];
  governance: {
    verdict: string;
    human_cosign_required: boolean;
    block_reason: string | null;
    audit_record_id: string | null;
    audit_chain_hash: string | null;
    approval_id: string | null;
  };
  economics: {
    total_cost_usd: number;
    budget_usd: number | null;
    budget_exhausted: boolean;
    total_latency_ms: number;
    tasks_executed: number;
    tasks_planned: number;
  };
  reason: string | null;
}

export async function dispatchMission(
  request: MissionDispatchRequest,
  provenance: Provenance,
  env: NodeJS.ProcessEnv = process.env,
  priorApproval?: { decisionId: string; approvedBy: string; approvedAtMs: number },
): Promise<MissionDispatchResult> {
  const started = Date.now();
  const requestId = provenance.request_id;

  // ---- Mission record ------------------------------------------------------
  let missionId = request.mission_id ?? null;
  if (missionId && !getMission(missionId)) missionId = null;
  if (!missionId) {
    const mission = createMission({
      title: request.title ?? request.objective.slice(0, 120),
      objective: request.objective,
      operatorId: request.operator_id ?? null,
    });
    missionId = mission.mission_id;
  }
  setMissionStatus(missionId, 'executing');

  const available = agentsFor(request.confidentiality_level);

  // ---- Govern the mission BEFORE spending ---------------------------------
  const governance = evaluateGovernance({
    requestId,
    surface: 'agent',
    action: `dispatch a ${available.length}-agent mission: ${request.objective.slice(0, 200)}`,
    taskType: 'decomposition',
    confidentiality: request.confidentiality_level,
    proposedBy: 'ronor/mission-coordinator',
    // A mission has produced nothing yet, so no measured confidence exists. The
    // figure is deliberately modest: authorising a multi-worker spend should not
    // rest on optimism about a result that does not exist.
    confidence: 0.6,
    confidenceMeasured: false,
    sourceCount: 0,
    evidenceAgeMs: null,
    operatorId: request.operator_id ?? provenance.api_key_label ?? null,
    // A mission invokes tools, so it is NOT reversible for gate purposes.
    hasSideEffects: true,
    impact: request.max_cost_usd
      ? { unit: 'EUR', value: request.max_cost_usd }
      : { unit: 'other', value: 100 },
    missionId,
    priorApproval,
    metadata: {
      agents_available: available.map((a) => a.agent_id),
      max_tasks: request.max_tasks ?? 4,
      use_knowledge: request.use_knowledge !== false,
    },
  });

  if (governance.requiresCoSign && !priorApproval) {
    const pending = createPendingExecution({
      execution: { kind: 'mission', request: { ...request, mission_id: missionId } },
      provenance,
      env,
      apiKeyId: provenance.api_key_id ?? 'unbound',
    });
    setMissionStatus(missionId, 'open');
    const record = writeAuditRecord({
      verdict: governance,
      surface: 'agent',
      outcome: {
        action: 'held-for-cosign',
        model: 'ronor/mission-coordinator',
        rationale: 'mission deferred before decomposition and execution pending human co-sign',
        latencyMs: Date.now() - started,
        metadata: { request_id: requestId, mission_id: missionId },
      },
    });
    return blockedResult(
      requestId,
      missionId,
      request,
      governance,
      record.recordId,
      record.chainHash,
      Date.now() - started,
      pending.approvalId,
    );
  }

  if (!governance.allowed) {
    setMissionStatus(missionId, 'failed');
    const record = writeAuditRecord({
      verdict: governance,
      surface: 'agent',
      outcome: {
        action: 'blocked',
        model: 'ronor/mission-coordinator',
        rationale: `mission blocked by MI9 Gate: ${governance.blockReason ?? 'unspecified'}`,
        latencyMs: Date.now() - started,
        metadata: { request_id: requestId, mission_id: missionId },
      },
    });
    recordWork({
      request_id: requestId,
      mission_id: missionId,
      operator_id: request.operator_id ?? provenance.api_key_label ?? null,
      api_key_id: provenance.api_key_id,
      task_type: 'decomposition',
      confidentiality: request.confidentiality_level,
      surface: 'agent',
      agent_id: null,
      status: 'rejected-governance',
      input_tokens: 0,
      output_tokens: 0,
      usage_estimated: false,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      attempts: 0,
      fallback_used: false,
      citations_count: 0,
      mi9_verdict: governance.mi9.verdict,
      prompt: request.objective,
    });
    return blockedResult(requestId, missionId, request, governance, record.recordId, record.chainHash, Date.now() - started);
  }

  // ---- Decompose ----------------------------------------------------------
  const decomposition = await decomposeObjective({
    objective: request.objective,
    confidentiality: request.confidentiality_level,
    maxTasks: request.max_tasks,
    requireEvidence: request.require_evidence,
    env,
  });

  let totalCost = decomposition.cost_usd;

  if (!decomposition.ok || decomposition.tasks.length === 0) {
    setMissionStatus(missionId, 'failed');
    return failedResult(
      requestId,
      missionId,
      request,
      governance,
      decomposition.reason ?? 'decomposition produced no executable tasks',
      totalCost,
      Date.now() - started,
      decomposition,
    );
  }

  // ---- Dispatch -----------------------------------------------------------
  const budget = request.max_cost_usd ?? null;
  const completed = new Map<string, WorkerResult>();
  const reports: MissionTaskReport[] = [];
  let budgetExhausted = false;

  for (const task of decomposition.tasks) {
    // Budget is checked BETWEEN tasks, before committing to the next one, so the
    // ceiling is a control rather than a post-hoc observation.
    if (budget !== null && totalCost >= budget) {
      budgetExhausted = true;
      break;
    }

    const passport = getPassport(task.agent_id);
    if (!passport) {
      reports.push({
        task_id: task.task_id,
        agent_id: task.agent_id,
        instruction: task.instruction,
        depends_on: task.depends_on,
        ok: false,
        model_id: null,
        cost_usd: 0,
        latency_ms: 0,
        confidence: 0,
        findings: 0,
        gaps: [],
        structure_degraded: false,
        tools_used: [],
        error: `no passport for agent '${task.agent_id}'`,
      });
      continue;
    }

    const upstream = task.depends_on
      .map((id) => completed.get(id))
      .filter((r): r is WorkerResult => r !== undefined && r.ok)
      .map((r) => ({
        task_id: r.task_id,
        agent_id: r.agent_id,
        narrative: r.output.narrative,
        findings: r.output.findings,
      }));

    const result = await runWorker({
      agentId: passport.agent_id,
      taskId: task.task_id,
      instruction: task.instruction,
      upstream,
      confidentiality: request.confidentiality_level,
      toolPlan: planToolCalls({
        passport,
        instruction: task.instruction,
        useKnowledge: request.use_knowledge !== false,
      }),
      maxCostUsd: budget !== null ? Math.max(0.0001, budget - totalCost) : undefined,
      env,
    });

    totalCost += result.cost_usd;
    completed.set(task.task_id, result);

    // Each worker's inference is its own ledger row, so cost and reliability are
    // attributable PER AGENT rather than pooled into a mission total that hides
    // which worker is expensive or unreliable.
    try {
      recordWork({
        request_id: `${requestId}:${task.task_id}`,
        mission_id: missionId,
        operator_id: request.operator_id ?? provenance.api_key_label ?? null,
        api_key_id: provenance.api_key_id,
        task_type: passport.router_task_type,
        confidentiality: request.confidentiality_level,
        surface: 'worker',
        agent_id: passport.agent_id,
        status: result.ok
          ? result.exchange?.fallback_used
            ? 'completed-after-fallback'
            : 'completed'
          : 'all-providers-failed',
        chosen_model_id: result.model_id,
        chosen_provider: result.exchange?.chosen_provider ?? null,
        transport: result.exchange?.transport ?? null,
        input_tokens: result.exchange?.input_tokens ?? 0,
        output_tokens: result.exchange?.output_tokens ?? 0,
        usage_estimated: result.exchange?.usage_estimated ?? false,
        cost_usd: result.cost_usd,
        latency_ms: result.latency_ms,
        attempts: result.exchange?.attempts.length ?? 0,
        fallback_used: result.exchange?.fallback_used ?? false,
        verified_confidence: result.output.confidence,
        citations_count: result.citations.length,
        mi9_verdict: governance.mi9.verdict,
        prompt: task.instruction,
      });
      if (result.exchange?.attempts.length) {
        recordAttempts(
          result.exchange.attempts.map((a) => ({
            request_id: `${requestId}:${task.task_id}`,
            attempt_no: a.attempt,
            model_id: a.model_id,
            provider: a.provider,
            transport: a.transport,
            ok: a.ok,
            latency_ms: a.latency_ms,
            input_tokens: a.input_tokens,
            output_tokens: a.output_tokens,
            cost_usd: a.cost_usd,
            failure_kind: a.failure_kind,
            failure_message: a.failure_message,
            fallback_reason: a.fallback_reason,
          })),
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[RONOR:L7] worker ledger write failed for ${task.task_id}:`, err);
    }

    reports.push({
      task_id: task.task_id,
      agent_id: passport.agent_id,
      instruction: task.instruction,
      depends_on: task.depends_on,
      ok: result.ok,
      model_id: result.model_id,
      cost_usd: result.cost_usd,
      latency_ms: result.latency_ms,
      confidence: result.output.confidence,
      findings: result.output.findings.length,
      gaps: result.output.gaps,
      structure_degraded: result.output.structure_degraded,
      tools_used: result.tools_used.map((t) => ({ tool: t.tool, ok: t.ok, error: t.error })),
      error: result.error,
    });
  }

  const successful = [...completed.values()].filter((r) => r.ok);

  if (successful.length === 0) {
    setMissionStatus(missionId, 'failed');
    return failedResult(
      requestId,
      missionId,
      request,
      governance,
      'every worker failed; no synthesis is possible',
      totalCost,
      Date.now() - started,
      decomposition,
      reports,
    );
  }

  // ---- Synthesise ---------------------------------------------------------
  const synthesis = await synthesise({
    objective: request.objective,
    results: successful,
    confidentiality: request.confidentiality_level,
    maxCostUsd: budget !== null ? Math.max(0.0001, budget - totalCost) : undefined,
    env,
  });
  totalCost += synthesis.cost_usd;

  const curator = successful.find((r) => r.agent_id === 'evidence-curator');
  const confidence = curator
    ? curator.output.confidence
    : Math.min(...successful.map((r) => r.output.confidence));
  const confidenceSource: MissionDispatchResult['confidence_source'] = curator
    ? 'evidence-curator'
    : successful.length
      ? 'weakest-worker'
      : 'none';

  const allFindings = successful.flatMap((r) => r.output.findings);
  const allGaps = [...new Set(successful.flatMap((r) => r.output.gaps))];
  const allCitations = dedupeCitations(successful.flatMap((r) => r.citations));

  const status: MissionDispatchResult['status'] = budgetExhausted
    ? 'partial'
    : reports.some((r) => !r.ok)
      ? 'partial'
      : 'complete';

  setMissionStatus(missionId, status === 'complete' ? 'complete' : 'open');
  recordGovernedExecution(governance);

  // ---- Record -------------------------------------------------------------
  let auditRecordId: string | null = null;
  let auditChainHash: string | null = null;
  try {
    const record = writeAuditRecord({
      verdict: governance,
      surface: 'agent',
      outcome: {
        action: outcomeActionFor(governance.mi9.verdict, true),
        model: synthesis.model_id ?? 'ronor/mission-coordinator',
        rationale:
          `mission ${status}: ${reports.filter((r) => r.ok).length}/${decomposition.tasks.length} tasks succeeded; ` +
          `${allFindings.length} finding(s), ${allGaps.length} gap(s), confidence ${confidence} (${confidenceSource})`,
        latencyMs: Date.now() - started,
        proposedValue: confidence,
        unit: 'confidence',
        metadata: {
          request_id: requestId,
          mission_id: missionId,
          cost_usd: +totalCost.toFixed(8),
          budget_exhausted: budgetExhausted,
          plan_fallback: decomposition.fallback,
          plan_repairs: decomposition.repairs,
          tasks: reports.map((r) => ({ id: r.task_id, agent: r.agent_id, ok: r.ok, model: r.model_id })),
        },
      },
    });
    auditRecordId = record.recordId;
    auditChainHash = record.chainHash;

    recordWork({
      request_id: requestId,
      mission_id: missionId,
      operator_id: request.operator_id ?? provenance.api_key_label ?? null,
      api_key_id: provenance.api_key_id,
      task_type: 'synthesis',
      confidentiality: request.confidentiality_level,
      surface: 'agent',
      agent_id: null,
      status: status === 'complete' ? 'completed' : 'completed-after-fallback',
      chosen_model_id: synthesis.model_id,
      chosen_provider: null,
      transport: null,
      input_tokens: 0,
      output_tokens: 0,
      usage_estimated: true,
      // The mission row carries ONLY the synthesis cost. Worker costs already
      // have their own rows, and adding them here would double-count spend in
      // every aggregate the cost dashboard computes.
      cost_usd: synthesis.cost_usd,
      latency_ms: Date.now() - started,
      attempts: 1,
      fallback_used: decomposition.fallback,
      verified_confidence: confidence,
      citations_count: allCitations.length,
      mi9_verdict: governance.mi9.verdict,
      trace_hash: auditChainHash,
      prompt: request.objective,
    });

    recordValue({
      request_id: requestId,
      mission_id: missionId,
      cost_usd: +totalCost.toFixed(8),
      premium_cost_usd: +totalCost.toFixed(8),
      quality_delta: 0,
      verified_confidence: confidence,
    });

    appendToMission({
      missionId,
      requestId,
      costUsd: +totalCost.toFixed(8),
      decision: {
        decision: `mission ${status} with confidence ${confidence}`,
        rationale: synthesis.narrative.slice(0, 1000),
        request_id: requestId,
      },
      findings: allFindings.map((f) => ({
        at: new Date().toISOString(),
        source: 'mission-synthesis',
        statement: f.statement,
        confidence: f.support,
        citations: f.sources.map((s) => ({ title: s })),
      })),
      notes: allGaps.length ? { gaps: allGaps.join('\n') } : undefined,
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error(`[RONOR:L7] mission ledger write failed for ${requestId}:`, err);
  }

  return {
    ok: true,
    request_id: requestId,
    mission_id: missionId,
    status,
    objective: request.objective,
    synthesis: synthesis.narrative,
    findings: allFindings,
    gaps: allGaps,
    confidence,
    confidence_source: confidenceSource,
    citations: allCitations,
    plan: {
      tasks: decomposition.tasks,
      fallback_used: decomposition.fallback,
      planner_model: decomposition.planner_model,
      repairs: decomposition.repairs,
      reason: decomposition.reason,
    },
    tasks: reports,
    governance: {
      verdict: governance.mi9.verdict,
      human_cosign_required: governance.requiresCoSign,
      block_reason: null,
      audit_record_id: auditRecordId,
      audit_chain_hash: auditChainHash,
      approval_id: null,
    },
    economics: {
      total_cost_usd: +totalCost.toFixed(8),
      budget_usd: budget,
      budget_exhausted: budgetExhausted,
      total_latency_ms: Date.now() - started,
      tasks_executed: reports.length,
      tasks_planned: decomposition.tasks.length,
    },
    reason: budgetExhausted
      ? `mission halted: cost budget of $${budget} was reached after ${reports.length} of ${decomposition.tasks.length} tasks`
      : null,
  };
}

// ---------------------------------------------------------------------------
// Synthesis
// ---------------------------------------------------------------------------

/**
 * Combine worker output into one answer.
 *
 * The synthesiser is explicitly FORBIDDEN to introduce facts. Its only inputs are
 * the workers' narratives and findings. This is the property that keeps the
 * mission's provenance intact: if the synthesiser could add a fact, the citation
 * chain would have a link with no source, and everything downstream would inherit
 * a claim no worker ever supported.
 */
async function synthesise(params: {
  objective: string;
  results: WorkerResult[];
  confidentiality: ConfidentialityLevel;
  maxCostUsd?: number;
  env?: NodeJS.ProcessEnv;
}): Promise<{ narrative: string; model_id: string | null; cost_usd: number }> {
  const sections = params.results
    .map((r) => {
      const findings = r.output.findings
        .map(
          (f) =>
            `  · ${f.statement} [sources: ${f.sources.length ? f.sources.join('; ') : 'UNSUPPORTED'}] (support ${f.support})`,
        )
        .join('\n');
      const gaps = r.output.gaps.length ? `  gaps: ${r.output.gaps.join('; ')}` : '';
      return `### ${r.task_id} · ${r.agent_id} (confidence ${r.output.confidence})\n${r.output.narrative}\n${findings}\n${gaps}`;
    })
    .join('\n\n');

  const exchange = await executeExchange({
    constraints: {
      task_type: 'synthesis',
      confidentiality_level: params.confidentiality,
      max_cost_usd: params.maxCostUsd,
    },
    system:
      'You are the RONOR mission synthesiser. Combine the supplied worker outputs into one ' +
      'coherent answer to the objective. ABSOLUTE RULE: introduce NO fact that is not present in ' +
      'the worker output. Where workers disagree, say so and explain the disagreement rather than ' +
      'choosing silently. Where a claim is marked UNSUPPORTED, either omit it or state explicitly ' +
      'that it is unsupported. Where gaps were reported, state them plainly at the end. Write ' +
      'continuous professional prose, not bullet points.',
    prompt: `OBJECTIVE:\n${params.objective}\n\nWORKER OUTPUT:\n${sections}\n\nWrite the synthesis.`,
    reasoningEffort: 'medium',
    maxOutputTokens: 6000,
    env: params.env,
  });

  if (!exchange.ok || !exchange.content) {
    // Deterministic fallback: concatenate the workers' own narratives. A mission
    // that produced real work must not return an empty answer because the
    // synthesiser was unavailable.
    return {
      narrative:
        `Synthesis engine unavailable (${exchange.rejection_reason ?? exchange.status}). ` +
        `The following is the unsynthesised worker output, presented verbatim.\n\n${sections}`,
      model_id: exchange.chosen_model_id,
      cost_usd: exchange.total_cost_usd,
    };
  }

  return {
    narrative: exchange.content,
    model_id: exchange.chosen_model_id,
    cost_usd: exchange.total_cost_usd,
  };
}

function dedupeCitations(
  citations: Array<{ title: string; url?: string; snippet?: string }>,
): Array<{ title: string; url?: string; snippet?: string }> {
  const seen = new Set<string>();
  const out: Array<{ title: string; url?: string; snippet?: string }> = [];
  for (const c of citations) {
    const key = c.url ?? c.title;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Terminal shapes
// ---------------------------------------------------------------------------

function blockedResult(
  requestId: string,
  missionId: string,
  request: MissionDispatchRequest,
  governance: ReturnType<typeof evaluateGovernance>,
  auditRecordId: string,
  auditChainHash: string,
  latencyMs: number,
  approvalId: string | null = null,
): MissionDispatchResult {
  return {
    ok: false,
    request_id: requestId,
    mission_id: missionId,
    status: 'blocked',
    objective: request.objective,
    synthesis: '',
    findings: [],
    gaps: [],
    confidence: 0,
    confidence_source: 'none',
    citations: [],
    plan: { tasks: [], fallback_used: false, planner_model: null, repairs: [], reason: null },
    tasks: [],
    governance: {
      verdict: governance.mi9.verdict,
      human_cosign_required: governance.requiresCoSign,
      block_reason: governance.blockReason,
      audit_record_id: auditRecordId,
      audit_chain_hash: auditChainHash,
      approval_id: approvalId,
    },
    economics: {
      total_cost_usd: 0,
      budget_usd: request.max_cost_usd ?? null,
      budget_exhausted: false,
      total_latency_ms: latencyMs,
      tasks_executed: 0,
      tasks_planned: 0,
    },
    reason: governance.blockReason,
  };
}

function failedResult(
  requestId: string,
  missionId: string,
  request: MissionDispatchRequest,
  governance: ReturnType<typeof evaluateGovernance>,
  reason: string,
  totalCost: number,
  latencyMs: number,
  decomposition: Awaited<ReturnType<typeof decomposeObjective>>,
  reports: MissionTaskReport[] = [],
): MissionDispatchResult {
  return {
    ok: false,
    request_id: requestId,
    mission_id: missionId,
    status: 'failed',
    objective: request.objective,
    synthesis: '',
    findings: [],
    gaps: [],
    confidence: 0,
    confidence_source: 'none',
    citations: [],
    plan: {
      tasks: decomposition.tasks,
      fallback_used: decomposition.fallback,
      planner_model: decomposition.planner_model,
      repairs: decomposition.repairs,
      reason: decomposition.reason,
    },
    tasks: reports,
    governance: {
      verdict: governance.mi9.verdict,
      human_cosign_required: governance.requiresCoSign,
      block_reason: null,
      audit_record_id: null,
      audit_chain_hash: null,
      approval_id: null,
    },
    economics: {
      total_cost_usd: +totalCost.toFixed(8),
      budget_usd: request.max_cost_usd ?? null,
      budget_exhausted: false,
      total_latency_ms: latencyMs,
      tasks_executed: reports.length,
      tasks_planned: decomposition.tasks.length,
    },
    reason,
  };
}
