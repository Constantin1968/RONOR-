/**
 * RONOR Runtime — L3 · Task Decomposition
 * ───────────────────────────────────────
 * Turns an objective into an ordered plan of agent tasks.
 *
 * The decomposer uses a MODEL, unlike the request classifier which is
 * deterministic. The distinction is deliberate: classification runs on every
 * request and must be free and reproducible, whereas decomposition runs once per
 * mission, is genuinely a reasoning problem, and benefits from a capable engine.
 *
 * Two safeguards matter more than the decomposition itself:
 *
 *   1. THE PLAN IS VALIDATED, NOT TRUSTED. A model asked for JSON will
 *      occasionally return prose, a fenced block, a plan with an unknown agent,
 *      or a dependency cycle. Every one of those is repaired or rejected here.
 *      Cycles are broken rather than merely detected, because a coordinator that
 *      deadlocks on a malformed plan is worse than one that runs a slightly
 *      wrong plan.
 *
 *   2. THERE IS ALWAYS A PLAN. If decomposition fails for any reason — no
 *      credential, malformed output, empty task list — a deterministic
 *      three-stage fallback plan (gather → analyse → verify) is returned and
 *      marked as such. A mission that cannot start because the planner was
 *      unavailable is an outage; a mission that runs the canonical plan is a
 *      degradation, and degradation is the correct posture.
 *
 * Prepared by AMB.
 */

import { executeExchange } from '../router/exchange';
import type { ConfidentialityLevel } from '../router/policy';
import { agentsFor, type AgentId, type AgentPassport } from './registry';

export interface PlannedTask {
  task_id: string;
  agent_id: AgentId;
  /** The instruction handed to the worker. */
  instruction: string;
  /** Task ids whose output this task requires. */
  depends_on: string[];
  /** Why this task exists, for the mission log. */
  rationale: string;
}

export interface DecompositionResult {
  ok: boolean;
  tasks: PlannedTask[];
  /** True when the deterministic fallback plan was used. */
  fallback: boolean
  reason: string | null;
  planner_model: string | null;
  cost_usd: number;
  latency_ms: number;
  /** Repairs applied to the model's plan, for the audit record. */
  repairs: string[];
}

const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['tasks'],
  properties: {
    tasks: {
      type: 'array',
      minItems: 1,
      maxItems: 8,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['task_id', 'agent_id', 'instruction', 'depends_on', 'rationale'],
        properties: {
          task_id: { type: 'string' },
          agent_id: { type: 'string', enum: ['researcher', 'analyst', 'evidence-curator'] },
          instruction: { type: 'string' },
          depends_on: { type: 'array', items: { type: 'string' } },
          rationale: { type: 'string' },
        },
      },
    },
  },
} as const;

export async function decomposeObjective(params: {
  objective: string;
  confidentiality: ConfidentialityLevel;
  maxTasks?: number;
  requireEvidence?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<DecompositionResult> {
  const started = Date.now();
  const available = agentsFor(params.confidentiality);
  const maxTasks = Math.min(8, Math.max(2, params.maxTasks ?? 4));

  if (available.length === 0) {
    // No worker may operate at this confidentiality. That is a governance
    // outcome, not a planning failure, and it must not be papered over with a
    // fallback plan that would then fail worker by worker.
    return {
      ok: false,
      tasks: [],
      fallback: false,
      reason: `no agent passport permits confidentiality_level=${params.confidentiality}`,
      planner_model: null,
      cost_usd: 0,
      latency_ms: Date.now() - started,
      repairs: [],
    };
  }

  const roster = available
    .map((a) => `- ${a.agent_id} (${a.name}): ${a.mandate} Tools: ${a.allowed_tools.join(', ')}.`)
    .join('\n');

  const system =
    'You are the RONOR task decomposition planner. Break an objective into the smallest ' +
    'sufficient sequence of agent tasks. Rules: (1) use ONLY the listed agents; (2) a task ' +
    'that reasons over evidence MUST depend on the task that gathered it; (3) prefer fewer, ' +
    'well-scoped tasks over many shallow ones; (4) task_id values must be short and unique; ' +
    '(5) if verification is required, the final task must be assigned to evidence-curator. ' +
    'Return JSON only.';

  const prompt = [
    `OBJECTIVE:\n${params.objective}`,
    '',
    `AVAILABLE AGENTS:\n${roster}`,
    '',
    `CONSTRAINTS: at most ${maxTasks} tasks. Confidentiality level: ${params.confidentiality}.`,
    params.requireEvidence !== false
      ? 'Evidence verification is REQUIRED: the final task must be assigned to evidence-curator.'
      : 'Evidence verification is optional.',
    '',
    'Produce the plan as JSON: {"tasks":[{"task_id":"t1","agent_id":"researcher","instruction":"…","depends_on":[],"rationale":"…"}]}',
  ].join('\n');

  const exchange = await executeExchange({
    constraints: {
      task_type: 'decomposition',
      confidentiality_level: params.confidentiality,
    },
    system,
    prompt,
    jsonSchema: { name: 'ronor_mission_plan', schema: PLAN_SCHEMA as unknown as Record<string, unknown> },
    reasoningEffort: 'medium',
    maxOutputTokens: 4096,
    env: params.env,
  });

  if (!exchange.ok || !exchange.content) {
    const fallback = fallbackPlan(params.objective, available, params.requireEvidence !== false);
    return {
      ok: fallback.length > 0,
      tasks: fallback,
      fallback: true,
      reason: `planner unavailable (${exchange.rejection_reason ?? exchange.status}); deterministic plan applied`,
      planner_model: exchange.chosen_model_id,
      cost_usd: exchange.total_cost_usd,
      latency_ms: Date.now() - started,
      repairs: [],
    };
  }

  const parsed = parsePlan(exchange.content);
  if (!parsed.tasks.length) {
    const fallback = fallbackPlan(params.objective, available, params.requireEvidence !== false);
    return {
      ok: fallback.length > 0,
      tasks: fallback,
      fallback: true,
      reason: `planner returned an unusable plan (${parsed.error ?? 'no tasks'}); deterministic plan applied`,
      planner_model: exchange.chosen_model_id,
      cost_usd: exchange.total_cost_usd,
      latency_ms: Date.now() - started,
      repairs: parsed.repairs,
    };
  }

  const validated = validatePlan(parsed.tasks, available, maxTasks);

  return {
    ok: validated.tasks.length > 0,
    tasks: validated.tasks,
    fallback: false,
    reason: null,
    planner_model: exchange.chosen_model_id,
    cost_usd: exchange.total_cost_usd,
    latency_ms: Date.now() - started,
    repairs: [...parsed.repairs, ...validated.repairs],
  };
}

/**
 * Extract a plan from model output.
 *
 * Tolerates a fenced code block and prose surrounding the JSON, because at least
 * one live engine ignores `response_format` when reached through a gateway. A
 * parser that assumed clean JSON would fail against a model that is otherwise
 * working correctly.
 */
export function parsePlan(content: string): {
  tasks: PlannedTask[];
  repairs: string[];
  error: string | null;
} {
  const repairs: string[] = [];
  let text = content.trim();

  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) {
    text = fence[1].trim();
    repairs.push('R1_STRIPPED_CODE_FENCE');
  }

  if (!text.startsWith('{')) {
    const first = text.indexOf('{');
    const last = text.lastIndexOf('}');
    if (first >= 0 && last > first) {
      text = text.slice(first, last + 1);
      repairs.push('R2_EXTRACTED_JSON_FROM_PROSE');
    }
  }

  try {
    const obj = JSON.parse(text) as { tasks?: unknown };
    if (!Array.isArray(obj.tasks)) {
      return { tasks: [], repairs, error: 'no tasks array in planner output' };
    }
    const tasks: PlannedTask[] = [];
    for (const raw of obj.tasks as Array<Record<string, unknown>>) {
      const task_id = typeof raw.task_id === 'string' ? raw.task_id.trim() : '';
      const agent_id = typeof raw.agent_id === 'string' ? raw.agent_id.trim() : '';
      const instruction = typeof raw.instruction === 'string' ? raw.instruction.trim() : '';
      if (!task_id || !agent_id || !instruction) continue;
      tasks.push({
        task_id,
        agent_id: agent_id as AgentId,
        instruction,
        depends_on: Array.isArray(raw.depends_on)
          ? (raw.depends_on as unknown[]).filter((d): d is string => typeof d === 'string')
          : [],
        rationale: typeof raw.rationale === 'string' ? raw.rationale : '',
      });
    }
    return { tasks, repairs, error: null };
  } catch (err) {
    return {
      tasks: [],
      repairs,
      error: `planner output was not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Repair a plan into something executable.
 *
 * Drops unknown agents, deduplicates ids, removes dangling dependencies, breaks
 * cycles and enforces the task cap. Every repair is named so the audit record
 * shows what the planner produced and what the runtime had to correct — a plan
 * silently rewritten is a plan no reviewer can evaluate.
 */
export function validatePlan(
  tasks: PlannedTask[],
  available: AgentPassport[],
  maxTasks: number,
): { tasks: PlannedTask[]; repairs: string[] } {
  const repairs: string[] = [];
  const allowedAgents = new Set(available.map((a) => a.agent_id));

  let out = tasks.filter((t) => {
    if (!allowedAgents.has(t.agent_id)) {
      repairs.push(`R3_DROPPED_UNKNOWN_AGENT:${t.agent_id}`);
      return false;
    }
    return true;
  });

  const seen = new Set<string>();
  out = out.filter((t) => {
    if (seen.has(t.task_id)) {
      repairs.push(`R4_DROPPED_DUPLICATE_TASK_ID:${t.task_id}`);
      return false;
    }
    seen.add(t.task_id);
    return true;
  });

  if (out.length > maxTasks) {
    repairs.push(`R5_TRUNCATED_TO_MAX_TASKS:${maxTasks}`);
    out = out.slice(0, maxTasks);
  }

  const ids = new Set(out.map((t) => t.task_id));
  out = out.map((t) => {
    const kept = t.depends_on.filter((d) => ids.has(d) && d !== t.task_id);
    if (kept.length !== t.depends_on.length) {
      repairs.push(`R6_REMOVED_DANGLING_DEPENDENCY:${t.task_id}`);
    }
    return { ...t, depends_on: kept };
  });

  const { ordered, brokenEdges } = topologicalOrder(out);
  for (const edge of brokenEdges) {
    repairs.push(`R7_BROKE_DEPENDENCY_CYCLE:${edge}`);
  }

  return { tasks: ordered, repairs };
}

/**
 * Kahn's algorithm, extended to break cycles rather than fail on them.
 *
 * When no task has zero in-degree, a dependency is severed and recorded. This
 * guarantees termination: a coordinator that waits forever on a cyclic plan
 * cannot be recovered by an operator, whereas a plan with one edge removed
 * produces a result they can inspect.
 */
export function topologicalOrder(tasks: PlannedTask[]): {
  ordered: PlannedTask[];
  brokenEdges: string[];
} {
  const byId = new Map(tasks.map((t) => [t.task_id, { ...t }]));
  const brokenEdges: string[] = [];
  const ordered: PlannedTask[] = [];
  const remaining = new Set(byId.keys());

  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) => {
      const t = byId.get(id);
      return t ? t.depends_on.every((d) => !remaining.has(d)) : false;
    });

    if (ready.length === 0) {
      // Cycle. Sever the first unmet dependency of the first remaining task.
      const victimId = [...remaining][0];
      const victim = byId.get(victimId);
      if (!victim) break;
      const unmet = victim.depends_on.find((d) => remaining.has(d));
      if (unmet) {
        victim.depends_on = victim.depends_on.filter((d) => d !== unmet);
        brokenEdges.push(`${victimId}->${unmet}`);
      } else {
        victim.depends_on = [];
        brokenEdges.push(`${victimId}->*`);
      }
      continue;
    }

    for (const id of ready) {
      const t = byId.get(id);
      if (t) ordered.push(t);
      remaining.delete(id);
    }
  }

  return { ordered, brokenEdges };
}

/**
 * The canonical gather → analyse → verify plan.
 *
 * Used whenever the planner cannot be reached or cannot be trusted. It is
 * correct for the large majority of research objectives, which is precisely why
 * it is safe as a fallback.
 */
export function fallbackPlan(
  objective: string,
  available: AgentPassport[],
  requireEvidence: boolean,
): PlannedTask[] {
  const has = (id: AgentId) => available.some((a) => a.agent_id === id);
  const tasks: PlannedTask[] = [];

  if (has('researcher')) {
    tasks.push({
      task_id: 't1',
      agent_id: 'researcher',
      instruction: `Gather the evidence needed to address this objective, with a citation for every factual claim: ${objective}`,
      depends_on: [],
      rationale: 'Deterministic fallback plan: evidence must be gathered before it can be analysed.',
    });
  }
  if (has('analyst')) {
    tasks.push({
      task_id: 't2',
      agent_id: 'analyst',
      instruction: `Analyse the gathered evidence and produce a structured assessment addressing: ${objective}. State plainly what the evidence does not support.`,
      depends_on: tasks.length ? ['t1'] : [],
      rationale: 'Deterministic fallback plan: reasoning stage over the gathered evidence.',
    });
  }
  if (requireEvidence && has('evidence-curator')) {
    tasks.push({
      task_id: 't3',
      agent_id: 'evidence-curator',
      instruction:
        'Verify each claim in the analysis against its cited source. Mark every unsupported claim and assign a defensible overall confidence score.',
      depends_on: tasks.map((t) => t.task_id),
      rationale: 'Deterministic fallback plan: adversarial verification before synthesis.',
    });
  }

  // If only one worker is permitted at this confidentiality, give it the whole
  // objective rather than returning nothing.
  if (tasks.length === 0 && available.length > 0) {
    tasks.push({
      task_id: 't1',
      agent_id: available[0].agent_id,
      instruction: objective,
      depends_on: [],
      rationale: `Deterministic fallback plan: only ${available[0].agent_id} is permitted at this confidentiality level.`,
    });
  }

  return tasks;
}
