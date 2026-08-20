import crypto from 'crypto';
import { appendMissionFabricEvent, getMission, getMissionFabric } from '../mission/store';
import { actionPermitted, validateMandate } from './policy';
import type { AutomationAdapters, AutomationRun, ExecutionMandate } from './contracts';

export async function runExecutiveMission(params: {
  objective: string;
  workspaceRoot: string;
  branch: string;
  mandate: ExecutionMandate;
  adapters: AutomationAdapters;
}): Promise<AutomationRun> {
  const runId = `run_${crypto.createHash('sha256').update(params.mandate.mandate_id).digest('hex').slice(0, 20)}`;
  const base: AutomationRun = {
    run_id: runId, mission_id: params.mandate.mission_id, status: 'blocked', cost_usd: 0,
    completed_assignments: 0, total_assignments: 0, reason: null,
  };
  if (!getMission(params.mandate.mission_id)) return { ...base, reason: 'mission_not_found' };
  const validation = validateMandate(params.mandate, {
    objective: params.objective, workspaceRoot: params.workspaceRoot, branch: params.branch,
  });
  if (!validation.valid) return { ...base, reason: validation.reason };

  const initialFabric = getMissionFabric(params.mandate.mission_id)!;
  if (initialFabric.checkpoints.some((event) => event.payload.mandate_id === params.mandate.mandate_id)) {
    return { ...base, reason: 'mandate_already_consumed' };
  }
  let version = initialFabric.version;
  const append = (type: 'checkpoint.created' | 'task.upserted' | 'task.status_changed' | 'failure.recorded', payload: Record<string, unknown>, actor: 'langgraph' | 'openhands' | 'codex' | 'agent') => {
    appendMissionFabricEvent({
      missionId: params.mandate.mission_id, expectedVersion: version++, type, payload,
      actor: { kind: actor, id: actor === 'agent' ? 'victoria' : actor },
    });
  };
  append('checkpoint.created', { id: `${runId}-mandate`, run_id: runId, mandate_id: params.mandate.mandate_id, status: 'granted' }, 'langgraph');

  const assignments = await params.adapters.langgraph.plan(params.objective);
  let run: AutomationRun = { ...base, status: 'planned', total_assignments: assignments.length };
  for (const assignment of assignments) {
    const denied = assignment.actions.find((action) => !actionPermitted(params.mandate, action));
    if (denied) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-denied`, run_id: runId, action: denied, reason: 'outside_mandate' }, 'langgraph');
      return { ...run, status: 'blocked', reason: `action_outside_mandate:${denied}` };
    }
    append('task.upserted', { id: assignment.id, run_id: runId, assignee: 'openhands', status: 'executing', actions: assignment.actions }, 'langgraph');
    run.status = 'executing';
    const result = await params.adapters.openhands.execute(assignment, params.mandate);
    run.cost_usd += result.cost_usd;
    if (!result.ok || run.cost_usd > params.mandate.max_cost_usd) {
      append('failure.recorded', { id: `${runId}-${assignment.id}-failed`, run_id: runId, reason: result.ok ? 'cost_limit_exceeded' : result.summary }, 'openhands');
      return { ...run, status: 'failed', reason: result.ok ? 'cost_limit_exceeded' : result.summary };
    }
    run.completed_assignments += 1;
    append('task.status_changed', { id: assignment.id, run_id: runId, status: 'complete', evidence: result.evidence }, 'openhands');
  }

  run.status = 'verifying';
  const evidence = getMissionFabric(params.mandate.mission_id)!.checkpoints.map((e) => e.event_hash);
  const codex = await params.adapters.codex.verify(params.mandate.mission_id, evidence);
  run.cost_usd += codex.cost_usd;
  append('checkpoint.created', { id: `${runId}-codex`, run_id: runId, verdict: codex.verdict, evidence: codex.evidence }, 'codex');
  if (!codex.ok || codex.verdict !== 'pass') return { ...run, status: 'failed', reason: 'codex_verification_failed' };

  run.status = 'assuring';
  const assurance = await params.adapters.assurance.accept(params.mandate.mission_id, codex);
  run.cost_usd += assurance.cost_usd;
  append('checkpoint.created', { id: `${runId}-victoria`, run_id: runId, verdict: assurance.verdict, evidence: assurance.evidence }, 'agent');
  if (!assurance.ok || assurance.verdict !== 'pass') return { ...run, status: 'failed', reason: 'independent_assurance_failed' };
  return { ...run, status: 'complete', reason: null };
}
