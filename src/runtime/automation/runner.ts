import crypto from 'crypto';
import { appendMissionFabricEvent, getMission, getMissionFabric, verifyMissionFabric } from '../mission/store';
import { actionPermitted, validateMandate } from './policy';
import { isAutomationAction, type AutomationAdapters, type AutomationRun, type EvidenceArtifact, type ExecutionMandate, type PlannedAssignment } from './contracts';
import type { WorkspaceArtifactCollector } from './artifacts';
import type { TestExecutor } from './test-executor';
import type { PostExecutionVerifier } from './post-execution-verifier';

export function executionRunId(mandateId: string): string {
  return `run_${crypto.createHash('sha256').update(mandateId).digest('hex').slice(0, 20)}`;
}

export function completedExecutionRun(mandate: ExecutionMandate): AutomationRun | null {
  const fabric = getMissionFabric(mandate.mission_id);
  if (!fabric) return null;
  const runId = executionRunId(mandate.mandate_id);
  const assured = fabric.checkpoints.some((event) =>
    event.payload.run_id === runId && event.payload.id === `${runId}-victoria` && event.payload.verdict === 'pass');
  if (!assured) return null;
  const tasks = Object.values(fabric.tasks).filter((task) => task.run_id === runId);
  const projected = fabric.runs[runId];
  const cost = typeof projected?.cost_usd === 'number' ? projected.cost_usd : 0;
  return {
    run_id: runId, mission_id: mandate.mission_id, status: 'complete', cost_usd: cost,
    completed_assignments: tasks.length, total_assignments: tasks.length, reason: null,
  };
}

function storedPlan(value: unknown): PlannedAssignment[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 25) return null;
  const result: PlannedAssignment[] = [];
  const ids = new Set<string>();
  for (const raw of value) {
    if (!raw || typeof raw !== 'object') return null;
    const item = raw as Record<string, unknown>;
    if (typeof item.id !== 'string' || ids.has(item.id) || typeof item.instruction !== 'string' ||
        !Array.isArray(item.actions) || !item.actions.every(isAutomationAction)) return null;
    ids.add(item.id);
    result.push({ id: item.id, instruction: item.instruction, actions: item.actions });
  }
  return result;
}

function storedArtifacts(value: unknown): EvidenceArtifact[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is EvidenceArtifact => Boolean(item && typeof item === 'object' &&
    typeof (item as EvidenceArtifact).sha256 === 'string' && typeof (item as EvidenceArtifact).reference === 'string'));
}

export async function runExecutiveMission(params: {
  objective: string;
  workspaceRoot: string;
  branch: string;
  mandate: ExecutionMandate;
  adapters: AutomationAdapters;
  now?: () => Date;
  signal?: AbortSignal;
  artifactCollector?: WorkspaceArtifactCollector;
  testExecutor?: TestExecutor;
  postExecutionVerifier?: PostExecutionVerifier;
}): Promise<AutomationRun> {
  const now = params.now ?? (() => new Date());
  const startedAt = now().getTime();
  const deadline = Math.min(Date.parse(params.mandate.expires_at), startedAt + params.mandate.max_runtime_minutes * 60_000);
  const deadlineSignal = AbortSignal.timeout(Math.max(1, deadline - startedAt));
  const executionSignal = params.signal ? AbortSignal.any([params.signal, deadlineSignal]) : deadlineSignal;
  const runId = executionRunId(params.mandate.mandate_id);
  const base: AutomationRun = {
    run_id: runId, mission_id: params.mandate.mission_id, status: 'blocked', cost_usd: 0,
    completed_assignments: 0, total_assignments: 0, reason: null,
  };
  if (!getMission(params.mandate.mission_id)) return { ...base, reason: 'mission_not_found' };
  if (verifyMissionFabric(params.mandate.mission_id)?.valid !== true) {
    return { ...base, reason: 'mission_fabric_integrity_failed' };
  }
  const validation = validateMandate(params.mandate, {
    objective: params.objective, workspaceRoot: params.workspaceRoot, branch: params.branch, now: now(),
  });
  if (!validation.valid) return { ...base, reason: validation.reason };

  const initialFabric = getMissionFabric(params.mandate.mission_id)!;
  const persistedCost = initialFabric.runs[runId]?.cost_usd;
  if (typeof persistedCost === 'number' && Number.isFinite(persistedCost) && persistedCost >= 0) {
    base.cost_usd = persistedCost;
  }
  const mandateClaimed = initialFabric.checkpoints.some((event) => event.payload.mandate_id === params.mandate.mandate_id);
  const completed = completedExecutionRun(params.mandate);
  if (completed) return completed;
  const priorFailures = initialFabric.failures.filter((event) => event.payload.run_id === runId).length;
  const append = (type: 'checkpoint.created' | 'task.upserted' | 'task.status_changed' | 'failure.recorded' | 'run.status_changed' | 'evidence.added', payload: Record<string, unknown>, actor: 'langgraph' | 'openhands' | 'codex' | 'agent') => {
    const version = getMissionFabric(params.mandate.mission_id)!.version;
    appendMissionFabricEvent({
      missionId: params.mandate.mission_id, expectedVersion: version, type, payload,
      actor: { kind: actor, id: actor === 'agent' ? 'victoria' : actor },
    });
  };
  const emitStatus = (run: AutomationRun, stage: string, actor: 'langgraph' | 'openhands' | 'codex' | 'agent') => append('run.status_changed', {
    id: runId, run_id: runId, mission_id: params.mandate.mission_id, stage, status: run.status,
    completed_assignments: run.completed_assignments, total_assignments: run.total_assignments,
    cost_usd: Number(run.cost_usd.toFixed(6)), reason_code: run.reason, updated_at: now().toISOString(),
  }, actor);
  const terminal = (run: AutomationRun, status: AutomationRun['status'], reason: string | null, stage: string, actor: 'langgraph' | 'openhands' | 'codex' | 'agent') => {
    const result = { ...run, status, reason };
    emitStatus(result, stage, actor);
    return result;
  };
  if (!mandateClaimed) append('checkpoint.created', {
    id: `${runId}-mandate`, run_id: runId, mandate_id: params.mandate.mandate_id,
    issued_by_key_id: params.mandate.issued_by_key_id, status: 'granted',
  }, 'langgraph');

  const expired = () => now().getTime() >= deadline || deadlineSignal.aborted;
  const cancelled = () => params.signal?.aborted === true;
  if (cancelled()) return terminal(base, 'failed', 'cancelled', 'planning', 'langgraph');
  const planFabric = getMissionFabric(params.mandate.mission_id)!;
  const planCheckpoint = planFabric.checkpoints.find((event) => event.payload.id === `${runId}-plan`);
  const planItems = planCheckpoint
    ? planFabric.checkpoints
      .filter((event) => event.payload.plan_id === `${runId}-plan` && typeof event.payload.index === 'number')
      .sort((left, right) => Number(left.payload.index) - Number(right.payload.index))
      .map((event) => event.payload.assignment)
    : [];
  let assignments = storedPlan(planItems);
  if (!assignments) {
    try { assignments = await params.adapters.langgraph.plan(params.objective, executionSignal); }
    catch { const reason = cancelled() ? 'cancelled' : expired() ? 'runtime_limit_exceeded' : 'langgraph_failed'; append('failure.recorded', { id: `${runId}-planning-failed-${priorFailures + 1}`, run_id: runId, reason }, 'langgraph'); return terminal(base, 'failed', reason, 'planning', 'langgraph'); }
    assignments.forEach((assignment, index) => append('checkpoint.created', {
      id: `${runId}-plan-${index}`, run_id: runId, plan_id: `${runId}-plan`, index, assignment,
    }, 'langgraph'));
    append('checkpoint.created', { id: `${runId}-plan`, run_id: runId, assignment_count: assignments.length, status: 'complete' }, 'langgraph');
  }
  let run: AutomationRun = { ...base, status: 'planned', total_assignments: assignments.length };
  emitStatus(run, 'langgraph', 'langgraph');
  const workerClaims: string[] = [];
  const workerArtifacts: EvidenceArtifact[] = [];
  for (const assignment of assignments) {
    const completed = getMissionFabric(params.mandate.mission_id)!.tasks[assignment.id];
    if (completed?.run_id === runId && completed.status === 'complete') {
      let artifacts = storedArtifacts(completed.artifacts);
      if (params.artifactCollector) artifacts = params.artifactCollector.verify(artifacts);
      const evidence = Array.isArray(completed.evidence) ? completed.evidence.filter((item): item is string => typeof item === 'string') : [];
      workerClaims.push(...evidence);
      workerArtifacts.push(...artifacts);
      run.completed_assignments += 1;
      continue;
    }
    if (cancelled()) return terminal(run, 'failed', 'cancelled', 'openhands', 'openhands');
    if (expired()) {
      append('failure.recorded', { id: `${runId}-deadline`, run_id: runId, reason: 'runtime_limit_exceeded' }, 'langgraph');
      return terminal(run, 'failed', 'runtime_limit_exceeded', 'openhands', 'openhands');
    }
    if (run.cost_usd >= params.mandate.max_cost_usd) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-budget-empty`, run_id: runId, reason: 'cost_budget_exhausted_before_execution' }, 'langgraph');
      return terminal(run, 'failed', 'cost_budget_exhausted_before_execution', 'budget', 'langgraph');
    }
    const denied = assignment.actions.find((action) => !actionPermitted(params.mandate, action));
    if (denied) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-denied`, run_id: runId, action: denied, reason: 'outside_mandate' }, 'langgraph');
      return terminal(run, 'blocked', `action_outside_mandate:${denied}`, 'policy', 'langgraph');
    }
    append('task.upserted', { id: assignment.id, run_id: runId, assignee: 'openhands', status: 'executing', actions: assignment.actions }, 'langgraph');
    run.status = 'executing';
    emitStatus(run, 'openhands', 'openhands');
    let result;
    try { result = await params.adapters.openhands.execute(assignment, params.mandate, executionSignal); }
    catch { const reason = cancelled() ? 'cancelled' : expired() ? 'runtime_limit_exceeded' : 'openhands_failed'; append('failure.recorded', { id: `${runId}-${assignment.id}-failed`, run_id: runId, reason }, 'openhands'); return terminal(run, 'failed', reason, 'openhands', 'openhands'); }
    run.cost_usd += result.cost_usd;
    if (!result.ok || run.cost_usd > params.mandate.max_cost_usd) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-failed`, run_id: runId, reason: result.ok ? 'cost_limit_exceeded' : result.summary }, 'openhands');
      return terminal(run, 'failed', result.ok ? 'cost_limit_exceeded' : result.summary, 'openhands', 'openhands');
    }
    let authoritativeArtifacts = result.artifacts ?? [];
    if (params.postExecutionVerifier) {
      try {
        const verified = await params.postExecutionVerifier.verify(runId, assignment.id, assignment.actions.includes('run_tests'), executionSignal);
        authoritativeArtifacts = verified.artifacts; workerClaims.push(...verified.claims);
        if (!verified.passed) { append('failure.recorded', { id: `${runId}-${assignment.id}-tests-nonzero`, run_id: runId, reason: 'tests_failed' }, 'openhands'); return terminal(run, 'failed', 'tests_failed', 'tests', 'openhands'); }
      } catch { const reason = cancelled() ? 'cancelled' : expired() ? 'runtime_limit_exceeded' : 'isolated_verification_failed'; append('failure.recorded', { id: `${runId}-${assignment.id}-isolated-verification-failed`, run_id: runId, reason }, 'openhands'); return terminal(run, 'failed', reason, 'evidence', 'openhands'); }
    } else if (params.artifactCollector) {
      try { authoritativeArtifacts = params.artifactCollector.collect(params.workspaceRoot, runId, assignment.id); }
      catch { append('failure.recorded', { id: `${runId}-${assignment.id}-evidence-failed`, run_id: runId, reason: 'artifact_collection_failed' }, 'openhands'); return terminal(run, 'failed', 'artifact_collection_failed', 'evidence', 'openhands'); }
    }
    if (!params.postExecutionVerifier && assignment.actions.includes('run_tests')) {
      if (!params.testExecutor) { append('failure.recorded', { id: `${runId}-${assignment.id}-tests-unavailable`, run_id: runId, reason: 'test_executor_not_configured' }, 'openhands'); return terminal(run, 'failed', 'test_executor_not_configured', 'tests', 'openhands'); }
      let tests;
      try { tests = params.testExecutor.run(params.workspaceRoot, runId, assignment.id, executionSignal); }
      catch { const reason = cancelled() ? 'cancelled' : expired() ? 'runtime_limit_exceeded' : 'test_execution_failed'; append('failure.recorded', { id: `${runId}-${assignment.id}-tests-failed`, run_id: runId, reason }, 'openhands'); return terminal(run, 'failed', reason, 'tests', 'openhands'); }
      workerClaims.push(...tests.claims); authoritativeArtifacts.push(tests.artifact);
      if (!tests.passed) { append('failure.recorded', { id: `${runId}-${assignment.id}-tests-nonzero`, run_id: runId, reason: 'tests_failed' }, 'openhands'); return terminal(run, 'failed', 'tests_failed', 'tests', 'openhands'); }
    }
    run.completed_assignments += 1;
    workerClaims.push(...result.evidence);
    workerArtifacts.push(...authoritativeArtifacts);
    append('task.status_changed', { id: assignment.id, run_id: runId, status: 'complete', evidence: result.evidence, artifacts: authoritativeArtifacts }, 'openhands');
    for (const artifact of authoritativeArtifacts) append('evidence.added', {
      id: `${runId}-${assignment.id}-${artifact.kind}`, run_id: runId, producer: 'openhands', kind: artifact.kind,
      reference: artifact.reference, digest: artifact.sha256, bytes: artifact.bytes,
    }, 'openhands');
    emitStatus(run, 'openhands', 'openhands');
  }

  run.status = 'verifying';
  emitStatus(run, 'codex', 'codex');
  if (cancelled()) return terminal(run, 'failed', 'cancelled', 'codex', 'codex');
  if (expired()) return terminal(run, 'failed', 'runtime_limit_exceeded', 'codex', 'codex');
  if (run.cost_usd >= params.mandate.max_cost_usd) return terminal(run, 'failed', 'cost_budget_exhausted_before_verification', 'budget', 'codex');
  let codex;
  let verifiedArtifacts = workerArtifacts;
  try { if (params.artifactCollector) verifiedArtifacts = params.artifactCollector.verify(workerArtifacts); }
  catch { append('failure.recorded', { id: `${runId}-artifact-integrity-failed`, run_id: runId, reason: 'artifact_integrity_failed' }, 'codex'); return terminal(run, 'failed', 'artifact_integrity_failed', 'codex', 'codex'); }
  const verificationEvidence = { claims: workerClaims, artifacts: verifiedArtifacts };
  try { codex = await params.adapters.codex.verify(params.mandate.mission_id, verificationEvidence, executionSignal); }
  catch { const reason = cancelled() ? 'cancelled' : expired() ? 'runtime_limit_exceeded' : 'codex_adapter_failed'; append('failure.recorded', { id: `${runId}-codex-failed`, run_id: runId, reason }, 'codex'); return terminal(run, 'failed', reason, 'codex', 'codex'); }
  run.cost_usd += codex.cost_usd;
  append('checkpoint.created', { id: `${runId}-codex`, run_id: runId, verdict: codex.verdict, evidence: codex.evidence }, 'codex');
  if (!codex.ok || codex.verdict !== 'pass') return terminal(run, 'failed', 'codex_verification_failed', 'codex', 'codex');
  if (run.cost_usd > params.mandate.max_cost_usd) return terminal(run, 'failed', 'cost_limit_exceeded', 'codex', 'codex');

  run.status = 'assuring';
  emitStatus(run, 'assurance', 'agent');
  if (expired()) return terminal(run, 'failed', 'runtime_limit_exceeded', 'assurance', 'agent');
  const assurance = await params.adapters.assurance.accept(params.mandate.mission_id, codex, verificationEvidence, executionSignal);
  run.cost_usd += assurance.cost_usd;
  append('checkpoint.created', { id: `${runId}-victoria`, run_id: runId, verdict: assurance.verdict, evidence: assurance.evidence }, 'agent');
  if (!assurance.ok || assurance.verdict !== 'pass') return terminal(run, 'failed', 'independent_assurance_failed', 'assurance', 'agent');
  if (run.cost_usd > params.mandate.max_cost_usd) return terminal(run, 'failed', 'cost_limit_exceeded', 'assurance', 'agent');
  return terminal(run, 'complete', null, 'complete', 'agent');
}
