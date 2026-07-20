/**
 * SHA-256 Hash-Chain Audit
 *
 * The audit chain is what makes RONOR's decisions bankable. Each decision is
 * recorded as an immutable, cryptographically linked audit record:
 *
 *   record_i.hash = SHA-256(record_i.payload || record_{i-1}.hash)
 *
 * Any modification of any past record breaks the chain and is detected by
 * `verifyChain()` at O(n).
 *
 * Persistence: better-sqlite3 (single-file, embedded, no external service).
 * The DB path defaults to ./data/audit.db and can be overridden with
 * AUDIT_DB_PATH.
 *
 * External auditors (a bank, a TSO regulator, an OSaaS client's finance team)
 * can independently re-hash the exported chain to verify integrity. See
 * scripts/verify-chain.ts for an offline verifier.
 */

import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { createLogger } from '../utils/logger';
import type { MI9Result, DecisionContext } from '../governance/mi9-gate';

const logger = createLogger('Audit:HashChain');

// ============================================================
// Types
// ============================================================

export interface AuditPayload {
  decisionId: string;
  decisionType: string;                       // e.g. "energy.bess.dispatch"
  timestamp: string;                          // ISO
  context: DecisionContext;
  mi9Result: MI9Result;
  aiProposal: {
    model: string;                            // e.g. "gpt-5.6"
    rationale: string;
    tokensUsed?: number;
    latencyMs?: number;
  };
  outcome: {
    action: 'executed' | 'held-for-cosign' | 'escalated' | 'blocked';
    baselineValue?: number;
    proposedValue?: number;
    incrementalGain?: number;
    unit?: string;
  };
  operatorSignature?: {
    operatorId: string;
    signedAt: string;
    role: string;
  };
  metadata?: Record<string, unknown>;
}

export interface AuditRecord {
  seq: number;                                // monotonic sequence number
  recordId: string;                           // UUID
  timestamp: string;
  payload: AuditPayload;
  payloadHash: string;                        // SHA-256 of canonical payload
  prevHash: string;                           // "0" * 64 for genesis
  chainHash: string;                          // SHA-256(payloadHash || prevHash)
}

export interface ChainVerificationResult {
  ok: boolean;
  totalRecords: number;
  brokenAtSeq?: number;
  brokenReason?: string;
  headHash: string;
  verifiedAt: string;
}

// ============================================================
// DB init
// ============================================================

function resolveDbPath(): string {
  return (
    process.env.AUDIT_DB_PATH ||
    path.resolve(process.cwd(), 'data', 'audit.db')
  );
}

function ensureDbDir(dbPath: string): void {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  const dbPath = resolveDbPath();
  ensureDbDir(dbPath);
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_chain (
      seq          INTEGER PRIMARY KEY AUTOINCREMENT,
      record_id    TEXT NOT NULL UNIQUE,
      timestamp    TEXT NOT NULL,
      decision_id  TEXT NOT NULL,
      decision_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      prev_hash    TEXT NOT NULL,
      chain_hash   TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_decision_id ON audit_chain(decision_id);
    CREATE INDEX IF NOT EXISTS idx_audit_timestamp   ON audit_chain(timestamp);
    CREATE INDEX IF NOT EXISTS idx_audit_type        ON audit_chain(decision_type);
  `);
  logger.info(`Audit chain DB ready at ${dbPath}`);
  return db;
}

// ============================================================
// Canonical serialisation
// ============================================================

/**
 * Canonical JSON: sorted keys, no whitespace. This ensures that identical
 * logical payloads always produce identical hashes across nodes and time.
 */
export function canonicalStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (v === null || typeof v !== 'object') return v;
    if (seen.has(v as object)) return null;
    seen.add(v as object);
    if (Array.isArray(v)) return v.map(walk);
    const obj = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj).sort()) out[k] = walk(obj[k]);
    return out;
  };
  return JSON.stringify(walk(value));
}

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

const GENESIS_HASH = '0'.repeat(64);

// ============================================================
// Append
// ============================================================

export function append(payload: AuditPayload): AuditRecord {
  const database = getDb();
  const canonical = canonicalStringify(payload);
  const payloadHash = sha256(canonical);

  const lastRow = database
    .prepare(
      'SELECT chain_hash FROM audit_chain ORDER BY seq DESC LIMIT 1'
    )
    .get() as { chain_hash: string } | undefined;
  const prevHash = lastRow ? lastRow.chain_hash : GENESIS_HASH;

  const chainHash = sha256(payloadHash + prevHash);
  const recordId = crypto.randomUUID();
  const timestamp = payload.timestamp || new Date().toISOString();

  const insert = database.prepare(`
    INSERT INTO audit_chain
      (record_id, timestamp, decision_id, decision_type,
       payload_json, payload_hash, prev_hash, chain_hash)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const info = insert.run(
    recordId,
    timestamp,
    payload.decisionId,
    payload.decisionType,
    canonical,
    payloadHash,
    prevHash,
    chainHash
  );

  const record: AuditRecord = {
    seq: info.lastInsertRowid as number,
    recordId,
    timestamp,
    payload,
    payloadHash,
    prevHash,
    chainHash,
  };
  logger.info(
    `Audit seq=${record.seq} decision=${payload.decisionId} verdict=${payload.mi9Result.verdict} chain=${chainHash.slice(0, 16)}…`
  );
  return record;
}

// ============================================================
// Read
// ============================================================

interface Row {
  seq: number;
  record_id: string;
  timestamp: string;
  decision_id: string;
  decision_type: string;
  payload_json: string;
  payload_hash: string;
  prev_hash: string;
  chain_hash: string;
}

function rowToRecord(r: Row): AuditRecord {
  return {
    seq: r.seq,
    recordId: r.record_id,
    timestamp: r.timestamp,
    payload: JSON.parse(r.payload_json) as AuditPayload,
    payloadHash: r.payload_hash,
    prevHash: r.prev_hash,
    chainHash: r.chain_hash,
  };
}

export function getRecord(recordId: string): AuditRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM audit_chain WHERE record_id = ?')
    .get(recordId) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

export function getRecordsForDecision(decisionId: string): AuditRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM audit_chain WHERE decision_id = ? ORDER BY seq ASC')
    .all(decisionId) as Row[];
  return rows.map(rowToRecord);
}

export function listRecords(limit = 100, offset = 0): AuditRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM audit_chain ORDER BY seq DESC LIMIT ? OFFSET ?')
    .all(limit, offset) as Row[];
  return rows.map(rowToRecord);
}

export function getHeadHash(): string {
  const row = getDb()
    .prepare('SELECT chain_hash FROM audit_chain ORDER BY seq DESC LIMIT 1')
    .get() as { chain_hash: string } | undefined;
  return row ? row.chain_hash : GENESIS_HASH;
}

export function countRecords(): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) as c FROM audit_chain')
    .get() as { c: number };
  return row.c;
}

// ============================================================
// Verify
// ============================================================

/**
 * Walk the chain and verify every link. Returns detailed diagnostics if a
 * break is detected. Safe to run against a large chain — O(n) with one
 * SHA-256 hash per record.
 */
export function verifyChain(): ChainVerificationResult {
  const rows = getDb()
    .prepare('SELECT * FROM audit_chain ORDER BY seq ASC')
    .all() as Row[];

  let prev = GENESIS_HASH;
  for (const row of rows) {
    // Re-hash payload from stored canonical JSON
    const rehashPayload = sha256(row.payload_json);
    if (rehashPayload !== row.payload_hash) {
      return {
        ok: false,
        totalRecords: rows.length,
        brokenAtSeq: row.seq,
        brokenReason: `Payload hash mismatch: stored=${row.payload_hash.slice(0, 12)}… recomputed=${rehashPayload.slice(0, 12)}…`,
        headHash: prev,
        verifiedAt: new Date().toISOString(),
      };
    }
    if (row.prev_hash !== prev) {
      return {
        ok: false,
        totalRecords: rows.length,
        brokenAtSeq: row.seq,
        brokenReason: `Prev-hash mismatch: expected=${prev.slice(0, 12)}… stored=${row.prev_hash.slice(0, 12)}…`,
        headHash: prev,
        verifiedAt: new Date().toISOString(),
      };
    }
    const rehashChain = sha256(row.payload_hash + row.prev_hash);
    if (rehashChain !== row.chain_hash) {
      return {
        ok: false,
        totalRecords: rows.length,
        brokenAtSeq: row.seq,
        brokenReason: `Chain hash mismatch at seq ${row.seq}.`,
        headHash: prev,
        verifiedAt: new Date().toISOString(),
      };
    }
    prev = row.chain_hash;
  }

  return {
    ok: true,
    totalRecords: rows.length,
    headHash: prev,
    verifiedAt: new Date().toISOString(),
  };
}

// ============================================================
// Export for offline verification
// ============================================================

export function exportChain(): AuditRecord[] {
  const rows = getDb()
    .prepare('SELECT * FROM audit_chain ORDER BY seq ASC')
    .all() as Row[];
  return rows.map(rowToRecord);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
