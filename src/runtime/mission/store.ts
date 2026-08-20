/**
 * RONOR Runtime — L2 · Mission State
 * ──────────────────────────────────
 * A mission is a unit of work that outlives a single request: an objective, an
 * accumulating body of findings, a running cost, and a status. It is what makes
 * the runtime capable of a multi-step investigation rather than a series of
 * unrelated answers.
 *
 * Two decisions worth naming:
 *
 *   · STATE IS APPEND-ORIENTED. Findings, decisions and citations accumulate;
 *     nothing is silently overwritten. When a later step contradicts an earlier
 *     one, both are retained and the contradiction is recorded as a finding in
 *     its own right. A mission log that quietly replaced a superseded fact would
 *     destroy exactly the evidence an auditor needs to understand how a
 *     conclusion was reached.
 *
 *   · COST IS ACCUMULATED ON THE MISSION, NOT DERIVED AT READ TIME. A mission's
 *     spend is incremented as each request completes, so an operator watching a
 *     long-running mission sees the bill grow in real time rather than after the
 *     fact. The ledger remains the authority for reconciliation; this is the
 *     live figure.
 *
 * Prepared by AMB.
 */

import crypto from 'crypto';
import { getDb } from '../../audit/hash-chain';
import { ensureRuntimeLedgerSchema } from '../ledgers/schema';

export type MissionStatus = 'open' | 'executing' | 'complete' | 'failed' | 'abandoned';

export interface MissionFinding {
  at: string;
  /** Which worker or surface produced this. */
  source: string;
  statement: string;
  confidence: number | null;
  citations: Array<{ title: string; url?: string }>;
  /** Set when this finding contradicts an earlier one, naming it. */
  contradicts?: string;
}

export interface MissionState {
  findings: MissionFinding[];
  decisions: Array<{ at: string; decision: string; rationale: string; request_id: string }>;
  /** Free-form working notes keyed by worker. */
  notes: Record<string, string>;
  /** Request ids that contributed to this mission, in order. */
  request_ids: string[];
  /** Vendor-neutral, append-only state shared by every agent surface. */
  fabric: MissionFabricState;
}

export type MissionFabricEventType =
  | 'task.upserted'
  | 'task.status_changed'
  | 'evidence.added'
  | 'coverage.updated'
  | 'failure.recorded'
  | 'checkpoint.created'
  | 'approval.required'
  | 'approval.resolved'
  | 'message.recorded';

export interface MissionFabricEvent {
  event_id: string;
  sequence: number;
  at: string;
  actor: { kind: 'human' | 'ronor' | 'codex' | 'langgraph' | 'openhands' | 'agent'; id: string };
  type: MissionFabricEventType;
  payload: Record<string, unknown>;
  previous_hash: string | null;
  event_hash: string;
}

export interface MissionFabricState {
  schema_version: 1;
  version: number;
  event_head: string | null;
  events: MissionFabricEvent[];
}

export interface MissionFabricProjection {
  version: number;
  event_head: string | null;
  tasks: Record<string, Record<string, unknown>>;
  evidence: Record<string, Record<string, unknown>>;
  coverage: Record<string, Record<string, unknown>>;
  failures: MissionFabricEvent[];
  checkpoints: MissionFabricEvent[];
  approvals: Record<string, Record<string, unknown>>;
  messages: MissionFabricEvent[];
}

export interface Mission {
  mission_id: string;
  title: string;
  objective: string;
  status: MissionStatus;
  operator_id: string | null;
  state: MissionState;
  requests_count: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
}

const emptyFabric = (): MissionFabricState => ({
  schema_version: 1,
  version: 0,
  event_head: null,
  events: [],
});

const emptyState = (): MissionState => ({
  findings: [],
  decisions: [],
  notes: {},
  request_ids: [],
  fabric: emptyFabric(),
});

export function newMissionId(): string {
  return `msn_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

export function createMission(params: {
  title: string;
  objective: string;
  operatorId?: string | null;
  missionId?: string;
}): Mission {
  ensureRuntimeLedgerSchema();
  const missionId = params.missionId ?? newMissionId();
  getDb()
    .prepare(
      `INSERT INTO runtime_missions (mission_id, title, objective, status, operator_id, state_json)
       VALUES (?,?,?,'open',?,?)`,
    )
    .run(missionId, params.title, params.objective, params.operatorId ?? null, JSON.stringify(emptyState()));
  return getMission(missionId) as Mission;
}

export function getMission(missionId: string): Mission | null {
  ensureRuntimeLedgerSchema();
  const row = getDb()
    .prepare(`SELECT * FROM runtime_missions WHERE mission_id = ?`)
    .get(missionId) as
    | {
        mission_id: string;
        title: string;
        objective: string;
        status: string;
        operator_id: string | null;
        state_json: string;
        requests_count: number;
        cost_usd: number;
        created_at: string;
        updated_at: string;
      }
    | undefined;
  if (!row) return null;
  return {
    mission_id: row.mission_id,
    title: row.title,
    objective: row.objective,
    status: row.status as MissionStatus,
    operator_id: row.operator_id,
    state: parseState(row.state_json),
    requests_count: row.requests_count,
    cost_usd: row.cost_usd,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

export function listMissions(limit = 50): Mission[] {
  ensureRuntimeLedgerSchema();
  const rows = getDb()
    .prepare(`SELECT mission_id FROM runtime_missions ORDER BY id DESC LIMIT ?`)
    .all(Math.min(200, Math.max(1, limit))) as Array<{ mission_id: string }>;
  return rows.map((r) => getMission(r.mission_id)).filter((m): m is Mission => m !== null);
}

export function setMissionStatus(missionId: string, status: MissionStatus): boolean {
  ensureRuntimeLedgerSchema();
  const info = getDb()
    .prepare(
      `UPDATE runtime_missions SET status = ?, updated_at = datetime('now') WHERE mission_id = ?`,
    )
    .run(status, missionId);
  return info.changes > 0;
}

/**
 * Append findings and account for a request against a mission.
 *
 * A single transaction, because a mission whose cost advanced but whose findings
 * did not would misrepresent both.
 */
export function appendToMission(params: {
  missionId: string;
  requestId?: string;
  findings?: MissionFinding[];
  decision?: { decision: string; rationale: string; request_id: string };
  notes?: Record<string, string>;
  costUsd?: number;
}): Mission | null {
  ensureRuntimeLedgerSchema();
  const db = getDb();
  const tx = db.transaction(() => {
    // Read inside the write transaction. Mission Fabric writers update the same
    // JSON document; reading before BEGIN would let this legacy projection write
    // an older copy over a newly appended cross-agent event.
    const row = db.prepare(`SELECT state_json FROM runtime_missions WHERE mission_id = ?`).get(params.missionId) as
      | { state_json: string }
      | undefined;
    if (!row) return false;
    const state = parseState(row.state_json);
    if (params.findings?.length) {
      for (const f of params.findings) {
        const contradiction = findContradiction(state.findings, f);
        state.findings.push(contradiction ? { ...f, contradicts: contradiction } : f);
      }
    }
    if (params.decision) state.decisions.push({ at: new Date().toISOString(), ...params.decision });
    if (params.notes) state.notes = { ...state.notes, ...params.notes };
    if (params.requestId && !state.request_ids.includes(params.requestId)) {
      state.request_ids.push(params.requestId);
    }
    db.prepare(
      `UPDATE runtime_missions
          SET state_json = ?,
              requests_count = requests_count + ?,
              cost_usd = cost_usd + ?,
              updated_at = datetime('now')
        WHERE mission_id = ?`,
    ).run(
      JSON.stringify(state),
      params.requestId ? 1 : 0,
      params.costUsd ?? 0,
      params.missionId,
    );
    return true;
  });
  if (!tx()) return null;

  return getMission(params.missionId);
}

export class MissionFabricConflictError extends Error {}
export class MissionFabricValidationError extends Error {}

/**
 * Append one vendor-neutral event using optimistic concurrency.
 *
 * LangGraph, OpenHands, Codex and human operators all write through this same
 * contract. The expected version prevents two workers from silently replacing
 * each other's state, while the event hash makes corruption detectable without
 * exposing mission content outside the authorised read surface.
 */
export function appendMissionFabricEvent(params: {
  missionId: string;
  expectedVersion: number;
  actor: MissionFabricEvent['actor'];
  type: MissionFabricEventType;
  payload: Record<string, unknown>;
  at?: string;
}): MissionFabricProjection | null {
  ensureRuntimeLedgerSchema();
  validateFabricInput(params.actor, params.type, params.payload);
  const db = getDb();

  const tx = db.transaction(() => {
    const row = db.prepare(`SELECT state_json FROM runtime_missions WHERE mission_id = ?`).get(params.missionId) as
      | { state_json: string }
      | undefined;
    if (!row) return null;
    const state = parseState(row.state_json);
    if (state.fabric.version !== params.expectedVersion) {
      throw new MissionFabricConflictError(
        `Mission fabric version conflict: expected ${params.expectedVersion}, current ${state.fabric.version}.`,
      );
    }

    const sequence = state.fabric.version + 1;
    const at = params.at ?? new Date().toISOString();
    const previousHash = state.fabric.event_head;
    const eventCore = {
      sequence,
      at,
      actor: params.actor,
      type: params.type,
      payload: params.payload,
      previous_hash: previousHash,
    };
    const eventHash = crypto.createHash('sha256').update(stableJson(eventCore)).digest('hex');
    const event: MissionFabricEvent = {
      event_id: `mfe_${eventHash.slice(0, 24)}`,
      ...eventCore,
      event_hash: eventHash,
    };
    state.fabric.events.push(event);
    state.fabric.version = sequence;
    state.fabric.event_head = eventHash;
    db.prepare(
      `UPDATE runtime_missions SET state_json = ?, updated_at = datetime('now') WHERE mission_id = ?`,
    ).run(JSON.stringify(state), params.missionId);
    return projectMissionFabric(state.fabric);
  });

  return tx();
}

export function getMissionFabric(missionId: string): MissionFabricProjection | null {
  const mission = getMission(missionId);
  return mission ? projectMissionFabric(mission.state.fabric) : null;
}

export function verifyMissionFabric(missionId: string): { valid: boolean; events: number; broken_at: number | null } | null {
  const mission = getMission(missionId);
  if (!mission) return null;
  let previous: string | null = null;
  for (let index = 0; index < mission.state.fabric.events.length; index += 1) {
    const event = mission.state.fabric.events[index];
    const core = {
      sequence: event.sequence,
      at: event.at,
      actor: event.actor,
      type: event.type,
      payload: event.payload,
      previous_hash: event.previous_hash,
    };
    const calculated = crypto.createHash('sha256').update(stableJson(core)).digest('hex');
    if (event.sequence !== index + 1 || event.previous_hash !== previous || event.event_hash !== calculated) {
      return { valid: false, events: mission.state.fabric.events.length, broken_at: event.sequence };
    }
    previous = event.event_hash;
  }
  return {
    valid: previous === mission.state.fabric.event_head,
    events: mission.state.fabric.events.length,
    broken_at: previous === mission.state.fabric.event_head ? null : mission.state.fabric.version,
  };
}

function projectMissionFabric(fabric: MissionFabricState): MissionFabricProjection {
  const projection: MissionFabricProjection = {
    version: fabric.version,
    event_head: fabric.event_head,
    tasks: {}, evidence: {}, coverage: {}, failures: [], checkpoints: [], approvals: {}, messages: [],
  };
  for (const event of fabric.events) {
    const id = typeof event.payload.id === 'string' ? event.payload.id : event.event_id;
    if (event.type === 'task.upserted' || event.type === 'task.status_changed') {
      projection.tasks[id] = { ...(projection.tasks[id] ?? {}), ...event.payload };
    } else if (event.type === 'evidence.added') {
      projection.evidence[id] = { ...event.payload };
    } else if (event.type === 'coverage.updated') {
      projection.coverage[id] = { ...(projection.coverage[id] ?? {}), ...event.payload };
    } else if (event.type === 'failure.recorded') projection.failures.push(event);
    else if (event.type === 'checkpoint.created') projection.checkpoints.push(event);
    else if (event.type === 'approval.required' || event.type === 'approval.resolved') {
      projection.approvals[id] = { ...(projection.approvals[id] ?? {}), ...event.payload };
    } else if (event.type === 'message.recorded') projection.messages.push(event);
  }
  return projection;
}

function validateFabricInput(
  actor: MissionFabricEvent['actor'],
  type: MissionFabricEventType,
  payload: Record<string, unknown>,
): void {
  const allowedActors = new Set(['human', 'ronor', 'codex', 'langgraph', 'openhands', 'agent']);
  const allowedTypes = new Set<MissionFabricEventType>([
    'task.upserted', 'task.status_changed', 'evidence.added', 'coverage.updated',
    'failure.recorded', 'checkpoint.created', 'approval.required', 'approval.resolved', 'message.recorded',
  ]);
  if (!allowedActors.has(actor.kind) || !actor.id || actor.id.length > 120) {
    throw new MissionFabricValidationError('Invalid mission fabric actor.');
  }
  if (!allowedTypes.has(type)) throw new MissionFabricValidationError('Invalid mission fabric event type.');
  const json = JSON.stringify(payload);
  if (json.length > 16_384) throw new MissionFabricValidationError('Mission fabric payload exceeds 16 KiB.');
  if (/"(?:token|secret|password|private[_-]?key|api[_-]?key)"\s*:/i.test(json)) {
    throw new MissionFabricValidationError('Secret-like fields are forbidden in mission fabric events.');
  }
  if (!payload.id || typeof payload.id !== 'string' || payload.id.length > 160) {
    throw new MissionFabricValidationError('Mission fabric payload requires a bounded string `id`.');
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Identify a prior finding this one directly contradicts.
 *
 * Deliberately narrow: it looks for a prior statement with substantially the same
 * subject and an opposite polarity marker. A broad semantic contradiction
 * detector would require a model call on every append and would produce false
 * positives that pollute the mission log. Narrow and honest beats broad and
 * noisy for an audit surface.
 */
function findContradiction(existing: MissionFinding[], candidate: MissionFinding): string | undefined {
  const negated = /\b(?:not|no longer|never|false|incorrect|contrary)\b/i.test(candidate.statement);
  const candidateTokens = significantTokens(candidate.statement);
  if (candidateTokens.length < 3) return undefined;

  for (const prior of existing) {
    const priorNegated = /\b(?:not|no longer|never|false|incorrect|contrary)\b/i.test(prior.statement);
    if (negated === priorNegated) continue;
    const priorTokens = new Set(significantTokens(prior.statement));
    const overlap = candidateTokens.filter((t) => priorTokens.has(t)).length;
    if (overlap / candidateTokens.length >= 0.6) return prior.statement.slice(0, 200);
  }
  return undefined;
}

const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'and', 'or', 'of', 'to', 'in', 'on',
  'for', 'with', 'that', 'this', 'it', 'as', 'by', 'at', 'from', 'not', 'no', 'has', 'have', 'had',
]);

function significantTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOPWORDS.has(t));
}

function parseState(json: string): MissionState {
  try {
    const parsed = JSON.parse(json) as Partial<MissionState>;
    return {
      findings: parsed.findings ?? [],
      decisions: parsed.decisions ?? [],
      notes: parsed.notes ?? {},
      request_ids: parsed.request_ids ?? [],
      fabric: parsed.fabric?.schema_version === 1 ? parsed.fabric : emptyFabric(),
    };
  } catch {
    // A corrupt state blob must not make the mission unreadable; an operator
    // needs to see that the mission exists in order to investigate why.
    return emptyState();
  }
}
