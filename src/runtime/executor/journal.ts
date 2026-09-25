/**
 * Jurnalul executorului (SQLite): o înregistrare per execuție, confirmată
 * individual, plus STOP persistent, revocări și lease-uri pe resursă.
 *
 * F09 (registrul v6, „citire care ascunde scrierea”): starea fiecărei
 * înregistrări se scrie și se citește separat. O observare reușită nu șterge
 * eșecul unei actuări anterioare, pentru că nu există un indicator global de
 * eroare: raportul de stare dă ultima observare și ultima actuare distinct.
 * Reluarea aceleiași cereri (aceeași cheie de idempotență) întoarce rezultatul
 * înregistrat și nu execută a doua oară.
 *
 * F09 (auditul din 09.09, G1.4, „lease pe arbore”): lease-ul pe resursă e
 * persistent (supraviețuiește repornirii procesului) și reentrant pentru
 * același deținător, cu adâncime numărată.
 *
 * La deschidere, orice execuție rămasă `admitted` sau `started` al cărei proces
 * nu mai există devine `interrupted`: rezultatul ei e necunoscut și nu se reia
 * automat. O nouă încercare cere o nouă aprobare. Execuțiile unui proces viu
 * (de exemplu, un `execute` în curs cât timp consola dă STOP) nu sunt atinse.
 */
import Database from 'better-sqlite3';

export type ExecutionState = 'admitted' | 'started' | 'done' | 'failed' | 'interrupted';

export interface ExecutionRecord {
  execution_id: string;
  idempotency_key: string;
  mandate_id: string;
  action_type: string;
  target: string;
  command: string | null;
  action_hash: string;
  approval_id: string | null;
  owner: string;
  pid: number;
  state: ExecutionState;
  reason: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  exit_code: number | null;
  output_sha256: string | null;
  receipt: string | null;
}

function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export type LeaseOutcome = { outcome: 'acquired'; depth: number } | { outcome: 'busy'; holder: string };

export class ExecutorJournal {
  private db: Database.Database;

  constructor(file: string, now: () => Date = () => new Date()) {
    this.db = new Database(file);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS executions (
        execution_id TEXT PRIMARY KEY,
        idempotency_key TEXT NOT NULL UNIQUE,
        mandate_id TEXT NOT NULL,
        action_type TEXT NOT NULL,
        target TEXT NOT NULL,
        command TEXT,
        action_hash TEXT NOT NULL,
        approval_id TEXT UNIQUE,
        owner TEXT NOT NULL,
        pid INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('admitted','started','done','failed','interrupted')),
        reason TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        exit_code INTEGER,
        output_sha256 TEXT,
        receipt TEXT
      );
      CREATE TABLE IF NOT EXISTS stop_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        active INTEGER NOT NULL,
        reason TEXT,
        changed_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS revocations (
        kind TEXT NOT NULL CHECK (kind IN ('mandate','approval')),
        value TEXT NOT NULL,
        reason TEXT,
        revoked_at TEXT NOT NULL,
        PRIMARY KEY (kind, value)
      );
      CREATE TABLE IF NOT EXISTS leases (
        resource TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        depth INTEGER NOT NULL,
        expires_at_ms INTEGER NOT NULL
      );
    `);
    const open = this.db.prepare(`SELECT execution_id, pid FROM executions WHERE state IN ('admitted','started')`).all() as Array<{
      execution_id: string;
      pid: number;
    }>;
    const orphan = this.db.prepare(
      `UPDATE executions SET state = 'interrupted', reason = 'process_restart_outcome_unknown', finished_at = ?
       WHERE execution_id = ? AND state IN ('admitted','started')`,
    );
    for (const row of open) if (!processAlive(row.pid)) orphan.run(now().toISOString(), row.execution_id);
  }

  close(): void {
    this.db.close();
  }

  // ── STOP ────────────────────────────────────────────────────────────────
  setStop(active: boolean, reason: string | null, at: Date): void {
    this.db
      .prepare(
        `INSERT INTO stop_state (id, active, reason, changed_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET active = excluded.active, reason = excluded.reason, changed_at = excluded.changed_at`,
      )
      .run(active ? 1 : 0, reason, at.toISOString());
  }

  stopState(): { active: boolean; reason: string | null } {
    const row = this.db.prepare('SELECT active, reason FROM stop_state WHERE id = 1').get() as
      | { active: number; reason: string | null }
      | undefined;
    return { active: row?.active === 1, reason: row?.reason ?? null };
  }

  // ── Revocări ────────────────────────────────────────────────────────────
  revoke(kind: 'mandate' | 'approval', value: string, reason: string | null, at: Date): void {
    this.db
      .prepare('INSERT OR IGNORE INTO revocations (kind, value, reason, revoked_at) VALUES (?, ?, ?, ?)')
      .run(kind, value, reason, at.toISOString());
  }

  isRevoked(kind: 'mandate' | 'approval', value: string | null): boolean {
    if (!value) return false;
    return this.db.prepare('SELECT 1 FROM revocations WHERE kind = ? AND value = ?').get(kind, value) !== undefined;
  }

  // ── Execuții ────────────────────────────────────────────────────────────
  findByIdempotencyKey(key: string): ExecutionRecord | null {
    return (this.db.prepare('SELECT * FROM executions WHERE idempotency_key = ?').get(key) as ExecutionRecord) ?? null;
  }

  findByApproval(approvalId: string): ExecutionRecord | null {
    return (this.db.prepare('SELECT * FROM executions WHERE approval_id = ?').get(approvalId) as ExecutionRecord) ?? null;
  }

  /** Admite o execuție; aprobarea e consumată aici, atomic, prin constrângerea UNIQUE. */
  admit(record: Omit<ExecutionRecord, 'pid' | 'state' | 'reason' | 'started_at' | 'finished_at' | 'exit_code' | 'output_sha256' | 'receipt'>): void {
    this.db
      .prepare(
        `INSERT INTO executions (execution_id, idempotency_key, mandate_id, action_type, target, command, action_hash,
           approval_id, owner, pid, state, created_at)
         VALUES (@execution_id, @idempotency_key, @mandate_id, @action_type, @target, @command, @action_hash,
           @approval_id, @owner, @pid, 'admitted', @created_at)`,
      )
      .run({ ...record, pid: process.pid });
  }

  markStarted(executionId: string, at: Date): void {
    const info = this.db
      .prepare(`UPDATE executions SET state = 'started', started_at = ? WHERE execution_id = ? AND state = 'admitted'`)
      .run(at.toISOString(), executionId);
    if (info.changes !== 1) throw new Error('executor_journal_transition_refused:started');
  }

  /** Închide o execuție; scrierea e confirmată prin numărul de rânduri schimbate, nu presupusă. */
  finish(
    executionId: string,
    fields: { state: 'done' | 'failed' | 'interrupted'; reason: string | null; exitCode: number | null; outputSha256: string | null; receipt: string | null; at: Date },
  ): void {
    const info = this.db
      .prepare(
        `UPDATE executions SET state = ?, reason = ?, exit_code = ?, output_sha256 = ?, receipt = ?, finished_at = ?
         WHERE execution_id = ? AND state IN ('admitted','started')`,
      )
      .run(fields.state, fields.reason, fields.exitCode, fields.outputSha256, fields.receipt, fields.at.toISOString(), executionId);
    if (info.changes !== 1) throw new Error(`executor_journal_transition_refused:${fields.state}`);
  }

  get(executionId: string): ExecutionRecord | null {
    return (this.db.prepare('SELECT * FROM executions WHERE execution_id = ?').get(executionId) as ExecutionRecord) ?? null;
  }

  inFlightOn(target: string): ExecutionRecord | null {
    return (
      (this.db
        .prepare(`SELECT * FROM executions WHERE target = ? AND action_type = 'ops.actuate' AND state IN ('admitted','started') LIMIT 1`)
        .get(target) as ExecutionRecord) ?? null
    );
  }

  lastOf(actionType: 'ops.observe' | 'ops.actuate'): ExecutionRecord | null {
    return (
      (this.db
        .prepare('SELECT * FROM executions WHERE action_type = ? ORDER BY created_at DESC, rowid DESC LIMIT 1')
        .get(actionType) as ExecutionRecord) ?? null
    );
  }

  // ── Lease persistent și reentrant ───────────────────────────────────────
  claimLease(resource: string, owner: string, leaseMs: number, now: Date): LeaseOutcome {
    const nowMs = now.getTime();
    const tx = this.db.transaction((): LeaseOutcome => {
      const row = this.db.prepare('SELECT owner, depth, expires_at_ms FROM leases WHERE resource = ?').get(resource) as
        | { owner: string; depth: number; expires_at_ms: number }
        | undefined;
      if (row && row.expires_at_ms > nowMs && row.owner !== owner) return { outcome: 'busy', holder: row.owner };
      const depth = row && row.expires_at_ms > nowMs ? row.depth + 1 : 1;
      this.db
        .prepare(
          `INSERT INTO leases (resource, owner, depth, expires_at_ms) VALUES (?, ?, ?, ?)
           ON CONFLICT(resource) DO UPDATE SET owner = excluded.owner, depth = excluded.depth,
             expires_at_ms = MAX(excluded.expires_at_ms, leases.expires_at_ms)`,
        )
        .run(resource, owner, depth, nowMs + leaseMs);
      return { outcome: 'acquired', depth };
    });
    return tx();
  }

  releaseLease(resource: string, owner: string): boolean {
    const tx = this.db.transaction((): boolean => {
      const row = this.db.prepare('SELECT owner, depth FROM leases WHERE resource = ?').get(resource) as
        | { owner: string; depth: number }
        | undefined;
      if (!row || row.owner !== owner) return false;
      if (row.depth > 1) this.db.prepare('UPDATE leases SET depth = depth - 1 WHERE resource = ?').run(resource);
      else this.db.prepare('DELETE FROM leases WHERE resource = ?').run(resource);
      return true;
    });
    return tx();
  }

  leaseHolder(resource: string, now: Date): { owner: string; depth: number } | null {
    const row = this.db.prepare('SELECT owner, depth, expires_at_ms FROM leases WHERE resource = ?').get(resource) as
      | { owner: string; depth: number; expires_at_ms: number }
      | undefined;
    if (!row || row.expires_at_ms <= now.getTime()) return null;
    return { owner: row.owner, depth: row.depth };
  }
}
