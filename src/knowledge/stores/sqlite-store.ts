/**
 * SQLite Reference Vector Store
 * MIP-014 STEP 2 · Phase 3 (Store Layer)
 *
 * Authorised for CI, automated testing and local development ONLY. Its use in
 * production is prohibited, and the prohibition is enforced upstream in the
 * selector, before this class can be constructed (STEP 1 §§ 9.2, 9.3).
 *
 * The store is a brute-force linear scanner over quantised vectors. That is an
 * adequate and honest choice for a reference implementation over a fixture corpus,
 * and it is stated plainly rather than dressed as an index: at corpus sizes beyond
 * the low tens of thousands of objects the scan cost would become the dominant
 * term in retrieval latency. The purpose of this adapter is to establish that the
 * pipeline is correct, not that it is fast.
 *
 * Isolation obligations (STEP 1 § 13.2):
 *   - `knowledge.db` is a distinct file from `audit.db`. This class holds no
 *     handle on the audit database and imports nothing from `src/audit/`.
 *   - No timer is created. No process-level handler is installed.
 *   - No method throws across the plane boundary; every failure is a typed value.
 */

import Database from 'better-sqlite3';
import { existsSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';

import { cosineSimilarity } from '../embedding/deterministic-adapter';
import { verifyObjectIntegrity, verifyVectorBinding } from '../provenance';
import { KnowledgeObjectSchema } from '../schema';
import { CLASSIFICATION_RANK } from '../../planes/r-knowledge/types';
import type {
  KnowledgeConfig,
  KnowledgeObject,
  KnowledgeReasonCode,
  RawHit,
  SearchFilters,
  StoreHealth,
  StoreOpenResult,
  StoreStats,
  UpsertResult,
  VectorStore,
  VectorStoreCapabilities,
  VectorStoreId,
} from '../../planes/r-knowledge/types';

interface ObjectRow {
  object_id: string;
  content_hash: string;
  parent_document_id: string;
  classification: string;
  source_type: string;
  dimensions: number;
  vector_json: string;
  object_json: string;
}

export class SqliteVectorStore implements VectorStore {
  readonly id: VectorStoreId = 'sqlite';

  /**
   * The ceiling is INTERNAL, not RESTRICTED. An embedded file-based store with no
   * encryption at rest, no access control and no audit of reads is not an
   * appropriate custodian for CONFIDENTIAL or RESTRICTED material, and declaring
   * a higher ceiling would make the classification filter a formality.
   */
  readonly capabilities: VectorStoreCapabilities = Object.freeze({
    persistent: true,
    vectorSearch: true,
    lexicalFallback: true,
    maxClassification: 'INTERNAL' as const,
    transactional: true,
  });

  private db: Database.Database | null = null;
  private readonly dbPath: string;
  private readonly expectedDimensions: number;
  private lastErrorCode: KnowledgeReasonCode | null = null;
  /** Set when a write has failed, which is the level-2 condition. */
  private writeRefused = false;

  constructor(config: KnowledgeConfig) {
    this.dbPath = resolve(config.sqlitePath);
    this.expectedDimensions = config.embeddingDimensions;
  }

  /**
   * Open the database, creating the file and its parent directory if necessary.
   *
   * Idempotent (N-7): a second call on an open store returns success without
   * reopening. This matters because the plane's lifecycle may call `open()` after
   * a recovery attempt, and reopening would discard the WAL state.
   */
  async open(): Promise<StoreOpenResult> {
    if (this.db !== null) {
      return { ok: true, storeId: this.id, reason: null, degradationLevel: 0 };
    }
    try {
      const dir = dirname(this.dbPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('synchronous = NORMAL');
      this.db.exec(`
        CREATE TABLE IF NOT EXISTS knowledge_objects (
          object_id          TEXT PRIMARY KEY,
          content_hash       TEXT NOT NULL,
          parent_document_id TEXT NOT NULL,
          classification     TEXT NOT NULL,
          source_type        TEXT NOT NULL,
          chunk_index        INTEGER NOT NULL,
          chunk_total        INTEGER NOT NULL,
          dimensions         INTEGER NOT NULL,
          vector_json        TEXT NOT NULL,
          object_json        TEXT NOT NULL,
          ingested_at        TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_knowledge_content_hash ON knowledge_objects(content_hash);
        CREATE INDEX IF NOT EXISTS idx_knowledge_parent ON knowledge_objects(parent_document_id);
        CREATE INDEX IF NOT EXISTS idx_knowledge_classification ON knowledge_objects(classification);
      `);
      this.writeRefused = false;
      this.lastErrorCode = null;
      return { ok: true, storeId: this.id, reason: null, degradationLevel: 0 };
    } catch (error) {
      // A corrupt or locked database file is a degradation event, not an
      // exception. It must not propagate: an exception escaping here could
      // disturb another plane's flow, which § 13.2 forbids.
      this.db = null;
      this.lastErrorCode = 'STORE_UNAVAILABLE';
      return {
        ok: false,
        storeId: this.id,
        reason: 'STORE_UNAVAILABLE',
        detail: error instanceof Error ? error.message : 'store could not be opened',
        degradationLevel: 3,
      };
    }
  }

  /** Idempotent (N-7). Safe to call on a never-opened or already-closed store. */
  async close(): Promise<void> {
    if (this.db === null) return;
    try {
      this.db.close();
    } catch {
      // Closing a store that is already gone is not a failure worth reporting.
    } finally {
      this.db = null;
    }
  }

  async upsert(objects: KnowledgeObject[], vectors: Map<string, number[]>): Promise<UpsertResult> {
    const failures: UpsertResult['failures'] = [];
    if (this.db === null) {
      return {
        requested: objects.length,
        written: 0,
        failures: objects.map((o) => ({ objectId: o.objectId, reason: 'STORE_UNAVAILABLE' as const })),
        ok: false,
      };
    }

    // Classification ceiling, applied per object. A refusal excludes the object
    // and never redirects it (RK-015).
    const admissible: KnowledgeObject[] = [];
    for (const object of objects) {
      if (
        CLASSIFICATION_RANK[object.classification] >
        CLASSIFICATION_RANK[this.capabilities.maxClassification]
      ) {
        failures.push({
          objectId: object.objectId,
          reason: 'STORE_CLASSIFICATION_REFUSED',
          detail: `store ceiling is ${this.capabilities.maxClassification}`,
        });
        continue;
      }
      const vector = vectors.get(object.objectId) ?? [];
      if (vector.length > 0 && vector.length !== this.expectedDimensions) {
        failures.push({ objectId: object.objectId, reason: 'STORE_DIMENSION_MISMATCH' });
        continue;
      }
      admissible.push(object);
    }

    let written = 0;
    try {
      const statement = this.db.prepare(`
        INSERT INTO knowledge_objects (
          object_id, content_hash, parent_document_id, classification, source_type,
          chunk_index, chunk_total, dimensions, vector_json, object_json, ingested_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(object_id) DO UPDATE SET
          content_hash = excluded.content_hash,
          vector_json = excluded.vector_json,
          object_json = excluded.object_json
      `);

      const transaction = this.db.transaction((batch: KnowledgeObject[]) => {
        for (const object of batch) {
          const vector = vectors.get(object.objectId) ?? [];
          statement.run(
            object.objectId,
            object.contentHash,
            object.provenance.parentDocumentId,
            object.classification,
            object.sourceType,
            object.chunkIndex,
            object.chunkTotal,
            object.embeddingRef.dimensions,
            JSON.stringify(vector),
            JSON.stringify(object),
            object.ingestedAt
          );
        }
      });

      transaction(admissible);
      written = admissible.length;
      this.writeRefused = false;
    } catch (error) {
      this.writeRefused = true;
      this.lastErrorCode = 'STORE_WRITE_REFUSED';
      for (const object of admissible) {
        failures.push({
          objectId: object.objectId,
          reason: 'STORE_WRITE_REFUSED',
          detail: error instanceof Error ? error.message : 'write refused',
        });
      }
      written = 0;
    }

    return {
      requested: objects.length,
      written,
      failures,
      ok: failures.length === 0 && written === objects.length,
    };
  }

  /**
   * Brute-force similarity scan.
   *
   * Read-time integrity verification (K-INV-2) is applied here rather than at the
   * pipeline layer, because this is the boundary at which stored bytes re-enter
   * the process. An object whose digest does not verify is excluded from the
   * candidate set entirely and can therefore never be ranked, cited or returned.
   */
  async search(vector: number[], k: number, filters?: SearchFilters): Promise<RawHit[]> {
    if (this.db === null) return [];
    try {
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (filters?.parentDocumentId) {
        clauses.push('parent_document_id = ?');
        params.push(filters.parentDocumentId);
      }
      if (filters?.sourceType) {
        clauses.push('source_type = ?');
        params.push(filters.sourceType);
      }
      if (filters?.maxClassification) {
        const ceiling = CLASSIFICATION_RANK[filters.maxClassification];
        const admitted = Object.entries(CLASSIFICATION_RANK)
          .filter(([, rank]) => rank <= ceiling)
          .map(([name]) => name);
        clauses.push(`classification IN (${admitted.map(() => '?').join(',')})`);
        params.push(...admitted);
      }

      const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
      const rows = this.db
        .prepare(
          `SELECT object_id, content_hash, parent_document_id, classification, source_type,
                  dimensions, vector_json, object_json
           FROM knowledge_objects ${where}`
        )
        .all(...params) as ObjectRow[];

      const hits: RawHit[] = [];
      for (const row of rows) {
        let stored: number[];
        let object: KnowledgeObject;
        try {
          stored = JSON.parse(row.vector_json) as number[];
          object = JSON.parse(row.object_json) as KnowledgeObject;
        } catch {
          continue; // Unparseable row: excluded, never returned.
        }
        if (!KnowledgeObjectSchema.safeParse(object).success) continue;
        if (!verifyObjectIntegrity(object).ok) continue;
        if (!verifyVectorBinding(object, stored).ok) continue;
        if (stored.length !== vector.length) continue;

        hits.push({ objectId: row.object_id, score: cosineSimilarity(vector, stored) });
      }

      // Ordering is by descending score with objectId as a deterministic
      // tie-break, so that equal scores do not produce a run-dependent order.
      hits.sort((a, b) => (b.score - a.score) || a.objectId.localeCompare(b.objectId));
      return hits.slice(0, k);
    } catch (error) {
      this.lastErrorCode = 'STORE_PROTOCOL_ERROR';
      return [];
    }
  }

  async getByHash(contentHash: string): Promise<KnowledgeObject | null> {
    return this.fetchOne('content_hash = ?', contentHash);
  }

  async getById(objectId: string): Promise<KnowledgeObject | null> {
    return this.fetchOne('object_id = ?', objectId);
  }

  private async fetchOne(predicate: string, value: string): Promise<KnowledgeObject | null> {
    if (this.db === null) return null;
    try {
      const row = this.db
        .prepare(`SELECT object_json, vector_json FROM knowledge_objects WHERE ${predicate} LIMIT 1`)
        .get(value) as { object_json: string; vector_json: string } | undefined;
      if (!row) return null;
      const object = JSON.parse(row.object_json) as KnowledgeObject;
      if (!KnowledgeObjectSchema.safeParse(object).success) return null;
      // A read that fails integrity returns null rather than the object. The
      // caller cannot accidentally use unverified content, because it never has it.
      if (!verifyObjectIntegrity(object).ok) return null;
      return object;
    } catch {
      this.lastErrorCode = 'STORE_PROTOCOL_ERROR';
      return null;
    }
  }

  async delete(objectIds: string[]): Promise<number> {
    if (this.db === null || objectIds.length === 0) return 0;
    try {
      const statement = this.db.prepare('DELETE FROM knowledge_objects WHERE object_id = ?');
      const transaction = this.db.transaction((ids: string[]) => {
        let removed = 0;
        for (const id of ids) removed += statement.run(id).changes;
        return removed;
      });
      return transaction(objectIds) as number;
    } catch {
      this.lastErrorCode = 'STORE_WRITE_REFUSED';
      return 0;
    }
  }

  async health(): Promise<StoreHealth> {
    const started = Date.now();
    if (this.db === null) {
      return {
        storeId: this.id,
        reachable: false,
        latencyMs: 0,
        recordCount: 0,
        lastErrorCode: this.lastErrorCode ?? 'STORE_UNAVAILABLE',
        checkedAt: new Date(),
      };
    }
    try {
      const row = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_objects').get() as { n: number };
      return {
        storeId: this.id,
        reachable: true,
        latencyMs: Date.now() - started,
        recordCount: row.n,
        lastErrorCode: this.writeRefused ? 'STORE_WRITE_REFUSED' : null,
        checkedAt: new Date(),
      };
    } catch (error) {
      this.lastErrorCode = 'STORE_UNAVAILABLE';
      return {
        storeId: this.id,
        reachable: false,
        latencyMs: Date.now() - started,
        recordCount: 0,
        lastErrorCode: 'STORE_UNAVAILABLE',
        checkedAt: new Date(),
      };
    }
  }

  async stats(): Promise<StoreStats> {
    if (this.db === null) {
      return { storeId: this.id, objectCount: 0, dimensions: null, indexSizeBytes: null };
    }
    try {
      const count = this.db.prepare('SELECT COUNT(*) AS n FROM knowledge_objects').get() as { n: number };
      const dims = this.db
        .prepare('SELECT dimensions FROM knowledge_objects LIMIT 1')
        .get() as { dimensions: number } | undefined;
      return {
        storeId: this.id,
        objectCount: count.n,
        dimensions: dims?.dimensions ?? null,
        indexSizeBytes: null,
      };
    } catch {
      return { storeId: this.id, objectCount: 0, dimensions: null, indexSizeBytes: null };
    }
  }

  /** Test seam: force the write-refused condition that produces level 2. */
  simulateWriteRefusal(): void {
    this.writeRefused = true;
    this.lastErrorCode = 'STORE_WRITE_REFUSED';
  }

  isWriteRefused(): boolean {
    return this.writeRefused;
  }
}
