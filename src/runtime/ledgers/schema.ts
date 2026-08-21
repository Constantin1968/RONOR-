/**
 * RONOR Runtime — L7 · Operational Ledger Schema
 * ──────────────────────────────────────────────
 * Three ledgers, one database, one migration path. They share the SQLite file
 * that already holds the SHA-256 audit chain so that an auditor can reconcile
 * work-done against evidence-recorded in a single query rather than joining
 * across systems and hoping the clocks agree.
 *
 *   runtime_work        — one row per governed request. What was asked, which
 *                         engine answered, how long it took, what it cost, which
 *                         audit record signs it.
 *   runtime_attempts    — one row per PROVIDER ATTEMPT. This is the table that
 *                         makes fallback visible: a request that succeeded on the
 *                         third provider has three rows here and one in
 *                         runtime_work, and the difference between the two counts
 *                         is the runtime's true reliability picture.
 *   runtime_value       — realised and forgone value. Cost alone answers "what
 *                         did we spend"; an intelligence runtime must also answer
 *                         "what did we get, and what did the cheaper choice cost
 *                         us in quality".
 *
 * Two schema decisions are deliberate:
 *
 *   · COSTS ARE STORED AS REAL, NOT AS SCALED INTEGERS. Per-request costs here
 *     run to eight decimal places (a nano-cent scale), and an integer cent
 *     column would round almost every row to zero. Aggregate precision matters
 *     more than exact decimal representation for this workload.
 *   · usage_estimated IS A COLUMN, NOT A FOOTNOTE. When a vendor omits token
 *     accounting we infer it, and a cost dashboard that presented inferred spend
 *     identically to measured spend would be quietly misleading. Every aggregate
 *     view can therefore separate the two.
 *
 * Prepared by AMB.
 */

import { getDb } from '../../audit/hash-chain';

let ensured = false;

export function ensureRuntimeLedgerSchema(): void {
  // Idempotent and cheap, but the guard keeps it off the hot path: this is
  // called at the top of every ledger write.
  if (ensured) return;
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS runtime_work (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id         TEXT NOT NULL UNIQUE,
      mission_id         TEXT,
      operator_id        TEXT,
      api_key_id         TEXT,
      task_type          TEXT NOT NULL,
      confidentiality    TEXT NOT NULL,
      surface            TEXT NOT NULL,      -- query | agent | worker | tool
      agent_id           TEXT,
      status             TEXT NOT NULL,      -- completed | completed-after-fallback | rejected-policy | rejected-governance | all-providers-failed | content-refused | error
      chosen_model_id    TEXT,
      chosen_provider    TEXT,
      transport          TEXT,
      input_tokens       INTEGER NOT NULL DEFAULT 0,
      output_tokens      INTEGER NOT NULL DEFAULT 0,
      usage_estimated    INTEGER NOT NULL DEFAULT 0,
      cost_usd           REAL NOT NULL DEFAULT 0,
      latency_ms         INTEGER NOT NULL DEFAULT 0,
      attempts           INTEGER NOT NULL DEFAULT 0,
      fallback_used      INTEGER NOT NULL DEFAULT 0,
      verified_confidence INTEGER,
      citations_count    INTEGER NOT NULL DEFAULT 0,
      mi9_verdict        TEXT,
      trace_hash         TEXT,
      prompt_digest      TEXT,               -- SHA-256 of the prompt; never the prompt
      created_at         TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rt_work_mission  ON runtime_work(mission_id);
    CREATE INDEX IF NOT EXISTS idx_rt_work_model    ON runtime_work(chosen_model_id);
    CREATE INDEX IF NOT EXISTS idx_rt_work_created  ON runtime_work(created_at);
    CREATE INDEX IF NOT EXISTS idx_rt_work_status   ON runtime_work(status);
    CREATE INDEX IF NOT EXISTS idx_rt_work_agent    ON runtime_work(agent_id);

    CREATE TABLE IF NOT EXISTS runtime_attempts (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id      TEXT NOT NULL,
      attempt_no      INTEGER NOT NULL,
      model_id        TEXT NOT NULL,
      provider        TEXT NOT NULL,
      transport       TEXT NOT NULL,
      ok              INTEGER NOT NULL,
      latency_ms      INTEGER NOT NULL DEFAULT 0,
      input_tokens    INTEGER NOT NULL DEFAULT 0,
      output_tokens   INTEGER NOT NULL DEFAULT 0,
      cost_usd        REAL NOT NULL DEFAULT 0,
      failure_kind    TEXT,
      failure_message TEXT,
      fallback_reason TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rt_att_request  ON runtime_attempts(request_id);
    CREATE INDEX IF NOT EXISTS idx_rt_att_model    ON runtime_attempts(model_id);
    CREATE INDEX IF NOT EXISTS idx_rt_att_ok       ON runtime_attempts(ok);

    CREATE TABLE IF NOT EXISTS runtime_value (
      id                   INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id           TEXT NOT NULL,
      mission_id           TEXT,
      /* What the runtime spent to answer. */
      cost_usd             REAL NOT NULL DEFAULT 0,
      /* What the highest-quality eligible engine would have cost. The gap is the
         saving the router realised; a negative gap means the router chose to pay
         more for quality and should be able to justify it. */
      premium_cost_usd     REAL NOT NULL DEFAULT 0,
      cost_avoided_usd     REAL NOT NULL DEFAULT 0,
      /* Quality delta in score points, so a saving that cost accuracy is visible
         rather than presented as a pure win. */
      quality_delta        REAL NOT NULL DEFAULT 0,
      verified_confidence  INTEGER,
      /* Operator-declared value of the answer, when supplied. */
      declared_value_usd   REAL,
      value_unit           TEXT,
      created_at           TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rt_value_request ON runtime_value(request_id);
    CREATE INDEX IF NOT EXISTS idx_rt_value_mission ON runtime_value(mission_id);

    CREATE TABLE IF NOT EXISTS runtime_api_keys (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      key_id       TEXT NOT NULL UNIQUE,
      /* SHA-256 of the secret. The secret itself is never stored, so a database
         disclosure does not hand an attacker working credentials. */
      key_hash     TEXT NOT NULL,
      label        TEXT NOT NULL,
      role         TEXT NOT NULL DEFAULT 'operator',  -- operator | admin | readonly
      scopes       TEXT NOT NULL DEFAULT 'query',
      rate_limit_rpm INTEGER NOT NULL DEFAULT 60,
      active       INTEGER NOT NULL DEFAULT 1,
      created_at   TEXT NOT NULL DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rt_keys_hash ON runtime_api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS runtime_missions (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      mission_id     TEXT NOT NULL UNIQUE,
      title          TEXT NOT NULL,
      objective      TEXT NOT NULL,
      status         TEXT NOT NULL DEFAULT 'open',   -- open | executing | complete | failed | abandoned
      operator_id    TEXT,
      /* JSON blob of accumulated findings and decisions. Kept as text because
         mission state is read whole and never queried by field. */
      state_json     TEXT NOT NULL DEFAULT '{}',
      requests_count INTEGER NOT NULL DEFAULT 0,
      cost_usd       REAL NOT NULL DEFAULT 0,
      created_at     TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_rt_missions_status ON runtime_missions(status);

    CREATE TABLE IF NOT EXISTS runtime_automation_runs (
      run_id               TEXT PRIMARY KEY,
      mandate_id           TEXT NOT NULL UNIQUE,
      mission_id           TEXT NOT NULL,
      mandate_fingerprint  TEXT NOT NULL,
      mandate_json         TEXT NOT NULL,
      status               TEXT NOT NULL, -- running | failed | complete | cancelled
      lease_token          TEXT,
      lease_owner          TEXT,
      lease_expires_at     TEXT,
      attempt_count        INTEGER NOT NULL DEFAULT 1,
      created_at           TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at           TEXT NOT NULL DEFAULT (datetime('now')),
      completed_at         TEXT,
      cancel_requested_at  TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_rt_automation_mission ON runtime_automation_runs(mission_id);
    CREATE INDEX IF NOT EXISTS idx_rt_automation_status ON runtime_automation_runs(status);
  `);
  const automationColumns = db.prepare(`PRAGMA table_info(runtime_automation_runs)`).all() as Array<{ name: string }>;
  if (!automationColumns.some((column) => column.name === 'cancel_requested_at')) {
    db.exec(`ALTER TABLE runtime_automation_runs ADD COLUMN cancel_requested_at TEXT`);
  }
  ensured = true;
}

/** Test affordance: forget that the schema was ensured. */
export function resetSchemaGuard(): void {
  ensured = false;
}
