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

const EMPTY_STATE: MissionState = { findings: [], decisions: [], notes: {}, request_ids: [] };

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
    .run(missionId, params.title, params.objective, params.operatorId ?? null, JSON.stringify(EMPTY_STATE));
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
  const current = getMission(params.missionId);
  if (!current) return null;

  const state = current.state;
  if (params.findings?.length) {
    for (const f of params.findings) {
      // Detect a direct contradiction of an existing finding and record it
      // rather than replacing the earlier statement.
      const contradiction = findContradiction(state.findings, f);
      state.findings.push(contradiction ? { ...f, contradicts: contradiction } : f);
    }
  }
  if (params.decision) {
    state.decisions.push({ at: new Date().toISOString(), ...params.decision });
  }
  if (params.notes) {
    state.notes = { ...state.notes, ...params.notes };
  }
  if (params.requestId && !state.request_ids.includes(params.requestId)) {
    state.request_ids.push(params.requestId);
  }

  const tx = db.transaction(() => {
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
  });
  tx();

  return getMission(params.missionId);
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
    };
  } catch {
    // A corrupt state blob must not make the mission unreadable; an operator
    // needs to see that the mission exists in order to investigate why.
    return { ...EMPTY_STATE };
  }
}
