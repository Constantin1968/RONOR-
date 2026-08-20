import crypto from 'crypto';
import { appendMissionFabricEvent, getMission, getMissionFabric } from '../mission/store';
import { actionPermitted, validateMandate } from './policy';
import { isAutomationAction, type AutomationAdapters, type AutomationRun, type EvidenceArtifact, type ExecutionMandate, type PlannedAssignment } from './contracts';
import type { WorkspaceArtifactCollector } from './artifacts';

export function executionRunId(mandateId: string): string {
  return `run_${crypto.createHash('sha256').update(mandateId).digest('hex').slice(0, 20)}`;
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
}): Promise<AutomationRun> {
  const now = params.now ?? (() => new Date());
  const startedAt = now().getTime();
  const deadline = Math.min(Date.parse(params.mandate.expires_at), startedAt + params.mandate.max_runtime_minutes * 60_000);
  const runId = executionRunId(params.mandate.mandate_id);
  const base: AutomationRun = {
    run_id: runId, mission_id: params.mandate.mission_id, status: 'blocked', cost_usd: 0,
    completed_assignments: 0, total_assignments: 0, reason: null,
  };
  if (!getMission(params.mandate.mission_id)) return { ...base, reason: 'mission_not_found' };
  const validation = validateMandate(params.mandate, {
    objective: params.objective, workspaceRoot: params.workspaceRoot, branch: params.branch, now: now(),
  });
  if (!validation.valid) return { ...base, reason: validation.reason };

  const initialFabric = getMissionFabric(params.mandate.mission_id)!;
  const mandateClaimed = initialFabric.checkpoints.some((event) => event.payload.mandate_id === params.mandate.mandate_id);
  const runTasks = Object.values(initialFabric.tasks).filter((task) => task.run_id === runId);
  if (initialFabric.checkpoints.some((event) => event.payload.run_id === runId && event.payload.id === `${runId}-victoria` && event.payload.verdict === 'pass')) {
    return { ...base, status: 'complete', completed_assignments: runTasks.length, total_assignments: runTasks.length, reason: null };
  }
  const priorFailures = initialFabric.failures.filter((event) => event.payload.run_id === runId).length;
  if (mandateClaimed && priorFailures >= params.mandate.max_fix_cycles) return { ...base, reason: 'fix_cycle_limit_exceeded' };
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
  if (!mandateClaimed) append('checkpoint.created', { id: `${runId}-mandate`, run_id: runId, mandate_id: params.mandate.mandate_id, status: 'granted' }, 'langgraph');

  const expired = () => now().getTime() >= deadline;
  const cancelled = () => params.signal?.aborted === true;
  if (cancelled()) return terminal(base, 'failed', 'cancelled', 'planning', 'langgraph');
  const planCheckpoint = getMissionFabric(params.mandate.mission_id)!.checkpoints.find((event) => event.payload.id === `${runId}-plan`);
  let assignments = storedPlan(planCheckpoint?.payload.assignments);
  if (!assignments) {
    try { assignments = await params.adapters.langgraph.plan(params.objective, params.signal); }
    catch { const reason = cancelled() ? 'cancelled' : 'langgraph_failed'; append('failure.recorded', { id: `${runId}-planning-failed-${priorFailures + 1}`, run_id: runId, reason }, 'langgraph'); return terminal(base, 'failed', reason, 'planning', 'langgraph'); }
    append('checkpoint.created', { id: `${runId}-plan`, run_id: runId, assignments }, 'langgraph');
  }
  let run: AutomationRun = { ...base, status: 'planned', total_assignments: assignments.length };
  emitStatus(run, 'langgraph', 'langgraph');
  const workerClaims: string[] = [];
  const workerArtifacts: EvidenceArtifact[] = [];
  for (const assignment of assignments) {
    const completed = getMissionFabric(params.mandate.mission_id)!.tasks[assignment.id];
    if (completed?.run_id === runId && completed.status === 'complete') {
      let artifacts = storedArtifacts(completed.artifacts);
      if (params.artifactCollector) artifacts = params.artifactCollector.collect(params.workspaceRoot, runId, assignment.id);
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
    const denied = assignment.actions.find((action) => !actionPermitted(params.mandate, action));
    if (denied) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-denied`, run_id: runId, action: denied, reason: 'outside_mandate' }, 'langgraph');
      return terminal(run, 'blocked', `action_outside_mandate:${denied}`, 'policy', 'langgraph');
    }
    append('task.upserted', { id: assignment.id, run_id: runId, assignee: 'openhands', status: 'executing', actions: assignment.actions }, 'langgraph');
    run.status = 'executing';
    emitStatus(run, 'openhands', 'openhands');
    let result;
    try { result = await params.adapters.openhands.execute(assignment, params.mandate, params.signal); }
    catch { const reason = cancelled() ? 'cancelled' : 'openhands_failed'; append('failure.recorded', { id: `${runId}-${assignment.id}-failed`, run_id: runId, reason }, 'openhands'); return terminal(run, 'failed', reason, 'openhands', 'openhands'); }
    run.cost_usd += result.cost_usd;
    if (!result.ok || run.cost_usd > params.mandate.max_cost_usd) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-failed`, run_id: runId, reason: result.ok ? 'cost_limit_exceeded' : result.summary }, 'openhands');
      return terminal(run, 'failed', result.ok ? 'cost_limit_exceeded' : result.summary, 'openhands', 'openhands');
    }
    let authoritativeArtifacts = result.artifacts ?? [];
    if (params.artifactCollector) {
      try { authoritativeArtifacts = params.artifactCollector.collect(params.workspaceRoot, runId, assignment.id); }
      catch { append('failure.recorded', { id: `${runId}-${assignment.id}-evidence-failed`, run_id: runId, reason: 'artifact_collection_failed' }, 'openhands'); return terminal(run, 'failed', 'artifact_collection_failed', 'evidence', 'openhands'); }
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
  let codex;
  let verifiedArtifacts = workerArtifacts;
  try { if (params.artifactCollector) verifiedArtifacts = params.artifactCollector.verify(workerArtifacts); }
  catch { append('failure.recorded', { id: `${runId}-artifact-integrity-failed`, run_id: runId, reason: 'artifact_integrity_failed' }, 'codex'); return terminal(run, 'failed', 'artifact_integrity_failed', 'codex', 'codex'); }
  try { codex = await params.adapters.codex.verify(params.mandate.mission_id, { claims: workerClaims, artifacts: verifiedArtifacts }, params.signal); }
  catch { const reason = cancelled() ? 'cancelled' : 'codex_adapter_failed'; append('failure.recorded', { id: `${runId}-codex-failed`, run_id: runId, reason }, 'codex'); return terminal(run, 'failed', reason, 'codex', 'codex'); }
  run.cost_usd += codex.cost_usd;
  append('checkpoint.created', { id: `${runId}-codex`, run_id: runId, verdict: codex.verdict, evidence: codex.evidence }, 'codex');
  if (!codex.ok || codex.verdict !== 'pass') return terminal(run, 'failed', 'codex_verification_failed', 'codex', 'codex');
  if (run.cost_usd > params.mandate.max_cost_usd) return terminal(run, 'failed', 'cost_limit_exceeded', 'codex', 'codex');

  run.status = 'assuring';
  emitStatus(run, 'assurance', 'agent');
  if (expired()) return terminal(run, 'failed', 'runtime_limit_exceeded', 'assurance', 'agent');
  const assurance = await params.adapters.assurance.accept(params.mandate.mission_id, codex);
  run.cost_usd += assurance.cost_usd;
  append('checkpoint.created', { id: `${runId}-victoria`, run_id: runId, verdict: assurance.verdict, evidence: assurance.evidence }, 'agent');
  if (!assurance.ok || assurance.verdict !== 'pass') return terminal(run, 'failed', 'independent_assurance_failed', 'assurance', 'agent');
  if (run.cost_usd > params.mandate.max_cost_usd) return terminal(run, 'failed', 'cost_limit_exceeded', 'assurance', 'agent');
  return terminal(run, 'complete', null, 'complete', 'agent');
}
