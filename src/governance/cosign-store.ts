/**
 * RONOR — retinerea deciziilor care cer cosemnare umana.
 *
 * Cand poarta MI9 intoarce `escalate` sau `allow-with-cosign`, raspunsul nu
 * pleaca. Se retine aici, alaturi de contextul si de verdictul care au produs
 * retinerea, pana cand un om il elibereaza. Fara acest depozit, impunerea ar
 * fi doar un refuz: decizia s-ar pierde si cererea ar trebui refacuta.
 *
 * Depozitul trateaza aceeasi baza ca lantul de audit, ca sa nu existe doua
 * surse de adevar despre o singura decizie.
 */

import { getDb } from '../audit/hash-chain';

export interface HeldDecision {
  recordId: string;
  requestId: string;
  sessionId: string;
  verdict: string;
  content: string;
  modelUsed: string;
  contextJson: string;
  mi9Json: string;
  createdAt: string;
  releasedAt: string | null;
  releasedBy: string | null;
}

export interface HoldInput {
  recordId: string;
  requestId: string;
  sessionId: string;
  verdict: string;
  content: string;
  modelUsed: string;
  contextJson: string;
  mi9Json: string;
}

interface Row {
  record_id: string;
  request_id: string;
  session_id: string;
  verdict: string;
  content: string;
  model_used: string;
  context_json: string;
  mi9_json: string;
  created_at: string;
  released_at: string | null;
  released_by: string | null;
}

let tableReady = false;

function ensureTable(): void {
  if (tableReady) return;
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS cosign_pending (
      record_id    TEXT PRIMARY KEY,
      request_id   TEXT NOT NULL,
      session_id   TEXT NOT NULL,
      verdict      TEXT NOT NULL,
      content      TEXT NOT NULL,
      model_used   TEXT NOT NULL,
      context_json TEXT NOT NULL,
      mi9_json     TEXT NOT NULL,
      created_at   TEXT NOT NULL,
      released_at  TEXT,
      released_by  TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cosign_open ON cosign_pending (released_at);
  `);
  tableReady = true;
}

function toHeld(row: Row): HeldDecision {
  return {
    recordId: row.record_id,
    requestId: row.request_id,
    sessionId: row.session_id,
    verdict: row.verdict,
    content: row.content,
    modelUsed: row.model_used,
    contextJson: row.context_json,
    mi9Json: row.mi9_json,
    createdAt: row.created_at,
    releasedAt: row.released_at,
    releasedBy: row.released_by,
  };
}

export function hold(input: HoldInput): void {
  ensureTable();
  getDb()
    .prepare(
      `INSERT OR REPLACE INTO cosign_pending
         (record_id, request_id, session_id, verdict, content, model_used,
          context_json, mi9_json, created_at, released_at, released_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)`,
    )
    .run(
      input.recordId,
      input.requestId,
      input.sessionId,
      input.verdict,
      input.content,
      input.modelUsed,
      input.contextJson,
      input.mi9Json,
      new Date().toISOString(),
    );
}

export function get(recordId: string): HeldDecision | undefined {
  ensureTable();
  const row = getDb()
    .prepare(`SELECT * FROM cosign_pending WHERE record_id = ?`)
    .get(recordId) as Row | undefined;
  return row ? toHeld(row) : undefined;
}

export function listOpen(limit = 50): HeldDecision[] {
  ensureTable();
  const rows = getDb()
    .prepare(
      `SELECT * FROM cosign_pending
        WHERE released_at IS NULL
        ORDER BY created_at DESC
        LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map(toHeld);
}

export function countOpen(): number {
  ensureTable();
  const row = getDb()
    .prepare(`SELECT COUNT(*) AS n FROM cosign_pending WHERE released_at IS NULL`)
    .get() as { n: number };
  return row.n;
}

/**
 * Marcheaza decizia drept cosemnata. Intoarce false daca nu exista sau daca a
 * fost deja eliberata, ca a doua cosemnare sa nu treaca drept prima.
 */
export function markReleased(recordId: string, operator: string): boolean {
  ensureTable();
  const res = getDb()
    .prepare(
      `UPDATE cosign_pending
          SET released_at = ?, released_by = ?
        WHERE record_id = ? AND released_at IS NULL`,
    )
    .run(new Date().toISOString(), operator, recordId);
  return res.changes === 1;
}
