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
  const append = (type: 'checkpoint.created' | 'task.upserted' | 'task.status_changed' | 'failure.recorded', payload: Record<string, unknown>, actor: 'langgraph' | 'openhands' | 'codex' | 'agent') => {
    const version = getMissionFabric(params.mandate.mission_id)!.version;
    appendMissionFabricEvent({
      missionId: params.mandate.mission_id, expectedVersion: version, type, payload,
      actor: { kind: actor, id: actor === 'agent' ? 'victoria' : actor },
    });
  };
  if (!mandateClaimed) append('checkpoint.created', { id: `${runId}-mandate`, run_id: runId, mandate_id: params.mandate.mandate_id, status: 'granted' }, 'langgraph');

  const expired = () => now().getTime() >= deadline;
  const cancelled = () => params.signal?.aborted === true;
  if (cancelled()) return { ...base, status: 'failed', reason: 'cancelled' };
  const planCheckpoint = getMissionFabric(params.mandate.mission_id)!.checkpoints.find((event) => event.payload.id === `${runId}-plan`);
  let assignments = storedPlan(planCheckpoint?.payload.assignments);
  if (!assignments) {
    try { assignments = await params.adapters.langgraph.plan(params.objective, params.signal); }
    catch { const reason = cancelled() ? 'cancelled' : 'langgraph_failed'; append('failure.recorded', { id: `${runId}-planning-failed-${priorFailures + 1}`, run_id: runId, reason }, 'langgraph'); return { ...base, status: 'failed', reason }; }
    append('checkpoint.created', { id: `${runId}-plan`, run_id: runId, assignments }, 'langgraph');
  }
  let run: AutomationRun = { ...base, status: 'planned', total_assignments: assignments.length };
  const workerEvidence: string[] = [];
  for (const assignment of assignments) {
    const completed = getMissionFabric(params.mandate.mission_id)!.tasks[assignment.id];
    if (completed?.run_id === runId && completed.status === 'complete') {
      let artifacts = storedArtifacts(completed.artifacts);
      if (params.artifactCollector) artifacts = params.artifactCollector.collect(params.workspaceRoot, runId, assignment.id);
      const evidence = Array.isArray(completed.evidence) ? completed.evidence.filter((item): item is string => typeof item === 'string') : [];
      workerEvidence.push(...evidence, ...artifacts.map((artifact) => `artifact:${artifact.kind}:${artifact.sha256}:${artifact.reference}:${artifact.bytes}`));
      run.completed_assignments += 1;
      continue;
    }
    if (cancelled()) return { ...run, status: 'failed', reason: 'cancelled' };
    if (expired()) {
      append('failure.recorded', { id: `${runId}-deadline`, run_id: runId, reason: 'runtime_limit_exceeded' }, 'langgraph');
      return { ...run, status: 'failed', reason: 'runtime_limit_exceeded' };
    }
    const denied = assignment.actions.find((action) => !actionPermitted(params.mandate, action));
    if (denied) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-denied`, run_id: runId, action: denied, reason: 'outside_mandate' }, 'langgraph');
      return { ...run, status: 'blocked', reason: `action_outside_mandate:${denied}` };
    }
    append('task.upserted', { id: assignment.id, run_id: runId, assignee: 'openhands', status: 'executing', actions: assignment.actions }, 'langgraph');
    run.status = 'executing';
    let result;
    try { result = await params.adapters.openhands.execute(assignment, params.mandate, params.signal); }
    catch { const reason = cancelled() ? 'cancelled' : 'openhands_failed'; append('failure.recorded', { id: `${runId}-${assignment.id}-failed`, run_id: runId, reason }, 'openhands'); return { ...run, status: 'failed', reason }; }
    run.cost_usd += result.cost_usd;
    if (!result.ok || run.cost_usd > params.mandate.max_cost_usd) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-failed`, run_id: runId, reason: result.ok ? 'cost_limit_exceeded' : result.summary }, 'openhands');
      return { ...run, status: 'failed', reason: result.ok ? 'cost_limit_exceeded' : result.summary };
    }
    let authoritativeArtifacts = result.artifacts ?? [];
    if (params.artifactCollector) {
      try { authoritativeArtifacts = params.artifactCollector.collect(params.workspaceRoot, runId, assignment.id); }
      catch { append('failure.recorded', { id: `${runId}-${assignment.id}-evidence-failed`, run_id: runId, reason: 'artifact_collection_failed' }, 'openhands'); return { ...run, status: 'failed', reason: 'artifact_collection_failed' }; }
    }
    run.completed_assignments += 1;
    workerEvidence.push(...result.evidence, ...authoritativeArtifacts.map((artifact) =>
      `artifact:${artifact.kind}:${artifact.sha256}:${artifact.reference}:${artifact.bytes}`));
    append('task.status_changed', { id: assignment.id, run_id: runId, status: 'complete', evidence: result.evidence, artifacts: authoritativeArtifacts }, 'openhands');
  }

  run.status = 'verifying';
  if (cancelled()) return { ...run, status: 'failed', reason: 'cancelled' };
  if (expired()) return { ...run, status: 'failed', reason: 'runtime_limit_exceeded' };
  let codex;
  try { codex = await params.adapters.codex.verify(params.mandate.mission_id, workerEvidence, params.signal); }
  catch { const reason = cancelled() ? 'cancelled' : 'codex_adapter_failed'; append('failure.recorded', { id: `${runId}-codex-failed`, run_id: runId, reason }, 'codex'); return { ...run, status: 'failed', reason }; }
  run.cost_usd += codex.cost_usd;
  append('checkpoint.created', { id: `${runId}-codex`, run_id: runId, verdict: codex.verdict, evidence: codex.evidence }, 'codex');
  if (!codex.ok || codex.verdict !== 'pass') return { ...run, status: 'failed', reason: 'codex_verification_failed' };
  if (run.cost_usd > params.mandate.max_cost_usd) return { ...run, status: 'failed', reason: 'cost_limit_exceeded' };

  run.status = 'assuring';
  if (expired()) return { ...run, status: 'failed', reason: 'runtime_limit_exceeded' };
  const assurance = await params.adapters.assurance.accept(params.mandate.mission_id, codex);
  run.cost_usd += assurance.cost_usd;
  append('checkpoint.created', { id: `${runId}-victoria`, run_id: runId, verdict: assurance.verdict, evidence: assurance.evidence }, 'agent');
  if (!assurance.ok || assurance.verdict !== 'pass') return { ...run, status: 'failed', reason: 'independent_assurance_failed' };
  if (run.cost_usd > params.mandate.max_cost_usd) return { ...run, status: 'failed', reason: 'cost_limit_exceeded' };
  return { ...run, status: 'complete', reason: null };
}
