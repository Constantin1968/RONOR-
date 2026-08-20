import crypto from 'crypto';
import { appendMissionFabricEvent, getMission, getMissionFabric } from '../mission/store';
import { actionPermitted, validateMandate } from './policy';
import type { AutomationAdapters, AutomationRun, ExecutionMandate } from './contracts';
import type { WorkspaceArtifactCollector } from './artifacts';

export function executionRunId(mandateId: string): string {
  return `run_${crypto.createHash('sha256').update(mandateId).digest('hex').slice(0, 20)}`;
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
  if (initialFabric.checkpoints.some((event) => event.payload.mandate_id === params.mandate.mandate_id)) {
    return { ...base, reason: 'mandate_already_consumed' };
  }
  const append = (type: 'checkpoint.created' | 'task.upserted' | 'task.status_changed' | 'failure.recorded', payload: Record<string, unknown>, actor: 'langgraph' | 'openhands' | 'codex' | 'agent') => {
    const version = getMissionFabric(params.mandate.mission_id)!.version;
    appendMissionFabricEvent({
      missionId: params.mandate.mission_id, expectedVersion: version, type, payload,
      actor: { kind: actor, id: actor === 'agent' ? 'victoria' : actor },
    });
  };
  append('checkpoint.created', { id: `${runId}-mandate`, run_id: runId, mandate_id: params.mandate.mandate_id, status: 'granted' }, 'langgraph');

  const expired = () => now().getTime() >= deadline;
  const cancelled = () => params.signal?.aborted === true;
  if (cancelled()) return { ...base, status: 'failed', reason: 'cancelled' };
  let assignments;
  try { assignments = await params.adapters.langgraph.plan(params.objective, params.signal); }
  catch { const reason = cancelled() ? 'cancelled' : 'langgraph_failed'; append('failure.recorded', { id: `${runId}-planning-failed`, run_id: runId, reason }, 'langgraph'); return { ...base, status: 'failed', reason }; }
  let run: AutomationRun = { ...base, status: 'planned', total_assignments: assignments.length };
  const workerEvidence: string[] = [];
  for (const assignment of assignments) {
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
