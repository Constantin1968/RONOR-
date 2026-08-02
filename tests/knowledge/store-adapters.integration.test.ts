/**
 * R-Knowledge — Shared Store Conformance Suite
 * MIP-014 STEP 2 · Phase 3 · Gate G3
 *
 * This suite is the evidence for neutrality invariant N-7 and dossier evidence
 * artefact E-3, so its structure is itself part of the claim:
 *
 *   > The same conformance suite validates every store implementation. A suite
 *   > containing an adapter-specific branch is itself evidence of a neutrality
 *   > breach.
 *
 * Accordingly the conformance block below contains ZERO conditional logic keyed on
 * store identity. Every store is driven through the identical assertion set, and
 * the assertions are written against the declared `capabilities` of whichever
 * store is under test — which is the mechanism by which a store that cannot search
 * and a store that can are both held to the same contract.
 *
 * Adapter-specific behaviour is asserted in separate, explicitly labelled blocks
 * BELOW the conformance block, and those blocks are not part of the conformance
 * claim.
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { chunkText } from '../../src/knowledge/chunker';
import { DeterministicEmbeddingAdapter } from '../../src/knowledge/embedding/deterministic-adapter';
import { constructKnowledgeObject, deriveParentDocumentId } from '../../src/knowledge/provenance';
import {
  NullVectorStore,
  selectVectorStore,
  storeAdmitsClassification,
} from '../../src/knowledge/stores/vector-store';
import { SqliteVectorStore } from '../../src/knowledge/stores/sqlite-store';
import { QdrantVectorStore } from '../../src/knowledge/stores/qdrant-store';
import { resolveKnowledgeConfig } from '../../src/planes/r-knowledge/config';
import type { EnvSource } from '../../src/planes/r-knowledge/config';
import type {
  KnowledgeClassification,
  KnowledgeObject,
  VectorStore,
} from '../../src/planes/r-knowledge/types';
import { makeMockQdrantTransportFactory } from './helpers/mock-qdrant-transport';

const DIMENSIONS = 64;

let scratch: string;

beforeAll(() => {
  scratch = mkdtempSync(join(tmpdir(), 'ronor-knowledge-store-'));
});

afterAll(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// ------------------------------------------------------------
// Fixture construction, shared by every store under test
// ------------------------------------------------------------

async function makeObjects(
  count: number,
  classification: KnowledgeClassification = 'PUBLIC'
): Promise<{ objects: KnowledgeObject[]; vectors: Map<string, number[]> }> {
  const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
  const objects: KnowledgeObject[] = [];
  const vectors = new Map<string, number[]>();

  for (let i = 0; i < count; i++) {
    const text =
      `Operational record ${i}: the installation delivered frequency containment reserve ` +
      `during dispatch window ${i} with state of charge held within the governed band.`;
    const chunks = chunkText(text, { chunkSizeTokens: 512, chunkOverlapTokens: 64 });
    const embedded = await adapter.embed([chunks.chunks[0].text]);
    const sourceUri = `internal:fixtures/record-${i}`;
    const built = constructKnowledgeObject({
      chunk: chunks.chunks[0],
      sourceUri,
      sourceType: 'report',
      classification,
      sovereigntyTier: 1,
      ingestedBy: 'conformance',
      parentDocumentId: deriveParentDocumentId(sourceUri),
      embeddingProvider: 'deterministic',
      embeddingModel: null,
      embeddingDimensions: DIMENSIONS,
      vector: embedded.vectors[0],
      retrievalPath: 'ingestion/deterministic',
      ingestedAt: '2026-08-02T09:00:00+03:00',
    });
    expect(built.ok).toBe(true);
    objects.push(built.object!);
    vectors.set(built.object!.objectId, embedded.vectors[0]);
  }

  return { objects, vectors };
}

// ============================================================
// THE SHARED CONFORMANCE BLOCK — no adapter-specific branch
// ============================================================

interface StoreUnderTest {
  label: string;
  make: () => VectorStore;
}

const STORES_UNDER_TEST: StoreUnderTest[] = [
  {
    label: 'sqlite',
    make: () =>
      new SqliteVectorStore(
        resolveKnowledgeConfig({
          KNOWLEDGE_ENABLED: 'true',
          KNOWLEDGE_VECTOR_STORE: 'sqlite',
          KNOWLEDGE_SQLITE_PATH: join(scratch, `conformance-${Math.random().toString(36).slice(2)}.db`),
          KNOWLEDGE_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
        })
      ),
  },
  {
    label: 'null',
    make: () => new NullVectorStore('STORE_UNCONFIGURED', 'no store configured'),
  },
  {
    label: 'qdrant',
    make: () =>
      new QdrantVectorStore(
        resolveKnowledgeConfig({
          KNOWLEDGE_ENABLED: 'true',
          KNOWLEDGE_VECTOR_STORE: 'qdrant',
          KNOWLEDGE_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
          KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
          KNOWLEDGE_QDRANT_ENDPOINT: 'https://qdrant.invalid.example/',
          KNOWLEDGE_QDRANT_API_KEY: 'mocked-least-privilege-token',
          KNOWLEDGE_QDRANT_ENVIRONMENT_AUTHORISATION: 'MOCK-AUTH-REF-0001',
        }),
        // A fully mocked in-process transport. It performs no network input or
        // output, binds no port, resolves no hostname and opens no socket.
        makeMockQdrantTransportFactory({ dimensions: DIMENSIONS })
      ),
  },
];

describe.each(STORES_UNDER_TEST)(
  'R-Knowledge · VectorStore conformance — $label (identical assertion set)',
  ({ make }) => {
    test('declares a store identifier and a complete capability set', () => {
      const store = make();
      expect(typeof store.id).toBe('string');
      expect(store.id.length).toBeGreaterThan(0);
      expect(Object.keys(store.capabilities).sort()).toEqual([
        'lexicalFallback',
        'maxClassification',
        'persistent',
        'transactional',
        'vectorSearch',
      ]);
    });

    test('open returns a typed result and never throws', async () => {
      const store = make();
      const result = await store.open();
      expect(typeof result.ok).toBe('boolean');
      expect(result.storeId).toBe(store.id);
      expect([0, 1, 2, 3]).toContain(result.degradationLevel);
      if (!result.ok) expect(result.reason).not.toBeNull();
      await store.close();
    });

    test('open is idempotent', async () => {
      const store = make();
      const first = await store.open();
      const second = await store.open();
      expect(second.ok).toBe(first.ok);
      expect(second.storeId).toBe(first.storeId);
      await store.close();
    });

    test('close is idempotent and safe on a never-opened store', async () => {
      const store = make();
      await expect(store.close()).resolves.toBeUndefined();
      await expect(store.close()).resolves.toBeUndefined();
      const opened = make();
      await opened.open();
      await expect(opened.close()).resolves.toBeUndefined();
      await expect(opened.close()).resolves.toBeUndefined();
    });

    test('upsert reports requested, written and per-object failures explicitly', async () => {
      const store = make();
      await store.open();
      const { objects, vectors } = await makeObjects(3);
      const result = await store.upsert(objects, vectors);

      expect(result.requested).toBe(3);
      expect(typeof result.written).toBe('number');
      expect(Array.isArray(result.failures)).toBe(true);
      // The contract: a partial success is reported, never silently absorbed.
      expect(result.written + result.failures.length).toBeLessThanOrEqual(result.requested * 2);
      expect(result.ok).toBe(result.written === 3 && result.failures.length === 0);
      for (const failure of result.failures) {
        expect(typeof failure.objectId).toBe('string');
        expect(typeof failure.reason).toBe('string');
      }
      await store.close();
    });

    test('search returns an array of scored hits, never throws, and honours k', async () => {
      const store = make();
      await store.open();
      const { objects, vectors } = await makeObjects(5);
      await store.upsert(objects, vectors);

      const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
      const query = await adapter.embed(['frequency containment reserve dispatch window']);
      const hits = await store.search(query.vectors[0], 3);

      expect(Array.isArray(hits)).toBe(true);
      expect(hits.length).toBeLessThanOrEqual(3);
      for (const hit of hits) {
        expect(typeof hit.objectId).toBe('string');
        expect(typeof hit.score).toBe('number');
        expect(Number.isFinite(hit.score)).toBe(true);
      }
      // Ordering must be non-increasing by score.
      for (let i = 1; i < hits.length; i++) {
        expect(hits[i - 1].score).toBeGreaterThanOrEqual(hits[i].score);
      }
      await store.close();
    });

    test('search on an unopened store returns an empty array rather than throwing', async () => {
      const store = make();
      const hits = await store.search(new Array(DIMENSIONS).fill(0), 5);
      expect(hits).toEqual([]);
    });

    test('getByHash and getById return either a valid object or null', async () => {
      const store = make();
      await store.open();
      const { objects, vectors } = await makeObjects(2);
      await store.upsert(objects, vectors);

      const byHash = await store.getByHash(objects[0].contentHash);
      const byId = await store.getById(objects[0].objectId);
      for (const candidate of [byHash, byId]) {
        if (candidate !== null) {
          expect(candidate.objectId).toBeDefined();
          expect(candidate.contentHash).toMatch(/^[0-9a-f]{64}$/);
        }
      }
      expect(await store.getByHash('0'.repeat(64))).toBeNull();
      await store.close();
    });

    test('delete returns a count and tolerates unknown identifiers', async () => {
      const store = make();
      await store.open();
      const removed = await store.delete(['00000000-0000-4000-8000-000000000000']);
      expect(typeof removed).toBe('number');
      expect(removed).toBeGreaterThanOrEqual(0);
      expect(await store.delete([])).toBe(0);
      await store.close();
    });

    test('health reports reachability, latency and a typed error code', async () => {
      const store = make();
      await store.open();
      const health = await store.health();
      expect(health.storeId).toBe(store.id);
      expect(typeof health.reachable).toBe('boolean');
      expect(health.latencyMs).toBeGreaterThanOrEqual(0);
      expect(health.recordCount).toBeGreaterThanOrEqual(0);
      expect(health.checkedAt instanceof Date).toBe(true);
      if (!health.reachable) expect(health.lastErrorCode).not.toBeNull();
      await store.close();
    });

    test('stats reports an object count and a nullable dimension', async () => {
      const store = make();
      await store.open();
      const stats = await store.stats();
      expect(stats.storeId).toBe(store.id);
      expect(stats.objectCount).toBeGreaterThanOrEqual(0);
      expect(stats.dimensions === null || typeof stats.dimensions === 'number').toBe(true);
      await store.close();
    });

    test('no method throws across the plane boundary under any call sequence', async () => {
      const store = make();
      // Deliberately abusive ordering: operate before open, after close, twice.
      await expect(
        (async () => {
          await store.search(new Array(DIMENSIONS).fill(0), 1);
          await store.getByHash('x');
          await store.getById('y');
          await store.delete(['z']);
          await store.health();
          await store.stats();
          await store.open();
          await store.close();
          await store.upsert([], new Map());
          await store.health();
        })()
      ).resolves.toBeUndefined();
    });

    test('material above the declared ceiling is refused and never redirected', async () => {
      const store = make();
      await store.open();
      const verdict = storeAdmitsClassification(store, 'RESTRICTED');
      if (store.capabilities.maxClassification !== 'RESTRICTED') {
        expect(verdict.ok).toBe(false);
        expect(verdict.reason).toBe('STORE_CLASSIFICATION_REFUSED');
      }

      const { objects, vectors } = await makeObjects(1, 'RESTRICTED');
      const result = await store.upsert(objects, vectors);
      // Whatever the store, an over-ceiling object is not written and no
      // alternative destination is used.
      expect(result.ok).toBe(false);
      await store.close();
    });
  }
);

// ============================================================
// Store selection policy — RK-015, RK-016, RK-016a, RK-016b
// ============================================================

describe('R-Knowledge · store selection policy', () => {
  function dataDirEntries(dir: string): string[] {
    return existsSync(dir) ? readdirSync(dir) : [];
  }

  test('production with sqlite refuses and creates no file (RK-016a)', async () => {
    const dir = join(scratch, 'prod-sqlite');
    const before = dataDirEntries(dir);

    const selection = selectVectorStore(
      resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
        KNOWLEDGE_VECTOR_STORE: 'sqlite',
        KNOWLEDGE_SQLITE_PATH: join(dir, 'knowledge.db'),
      } as EnvSource)
    );

    expect(selection.ok).toBe(false);
    expect(selection.reason).toBe('SQLITE_PROHIBITED_IN_PRODUCTION');
    expect(selection.selectedId).toBe('null');

    const opened = await selection.store.open();
    expect(opened.ok).toBe(false);
    expect(opened.degradationLevel).toBe(3);
    expect(opened.reason).toBe('SQLITE_PROHIBITED_IN_PRODUCTION');

    // The decisive assertion: no file was created, because no SQLite store was
    // ever constructed.
    expect(dataDirEntries(dir)).toEqual(before);
    expect(existsSync(join(dir, 'knowledge.db'))).toBe(false);
  });

  test('production without an authorised store degrades to level 3, not to a local database (RK-016b)', async () => {
    const dir = join(scratch, 'prod-qdrant');
    const selection = selectVectorStore(
      resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
        KNOWLEDGE_VECTOR_STORE: 'qdrant',
        KNOWLEDGE_SQLITE_PATH: join(dir, 'knowledge.db'),
      })
    );

    expect(selection.ok).toBe(false);
    expect(selection.reason).toBe('NO_AUTHORISED_PRODUCTION_STORE');
    expect(selection.selectedId).toBe('null');
    const opened = await selection.store.open();
    expect(opened.degradationLevel).toBe(3);
    expect(existsSync(join(dir, 'knowledge.db'))).toBe(false);
  });

  test('an unavailable configured store degrades and is never substituted (RK-016)', async () => {
    const selection = selectVectorStore(
      resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_ENVIRONMENT_CLASS: 'development',
        KNOWLEDGE_VECTOR_STORE: 'qdrant',
      })
    );
    // The configured store remains the active store identity.
    expect(selection.selectedId).toBe('qdrant');
    expect(selection.store.id).toBe('qdrant');

    const opened = await selection.store.open();
    expect(opened.ok).toBe(false);
    expect(opened.storeId).toBe('qdrant');
    expect(opened.degradationLevel).toBe(3);
    // No SQLite substitution occurred.
    expect(opened.storeId).not.toBe('sqlite');
  });

  test('sqlite is selected in ci, test and development', () => {
    for (const environmentClass of ['ci', 'test', 'development']) {
      const selection = selectVectorStore(
        resolveKnowledgeConfig({
          KNOWLEDGE_ENABLED: 'true',
          KNOWLEDGE_ENVIRONMENT_CLASS: environmentClass,
          KNOWLEDGE_VECTOR_STORE: 'sqlite',
          KNOWLEDGE_SQLITE_PATH: join(scratch, `select-${environmentClass}.db`),
        })
      );
      expect(selection.ok).toBe(true);
      expect(selection.selectedId).toBe('sqlite');
    }
  });

  test('a chroma configuration selects nothing and does not fall back (ADR-K02)', async () => {
    const selection = selectVectorStore(
      resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_VECTOR_STORE: 'chroma',
      })
    );
    expect(selection.selectedId).toBe('null');
    expect(selection.reason).toBe('STORE_UNCONFIGURED');
    const opened = await selection.store.open();
    expect(opened.ok).toBe(false);
  });

  test('the selector contains no code path from a failure to an alternative store', () => {
    // Structural assertion (invariant N-5). A reviewer establishes this by reading
    // the function; the test pins the property so that it cannot regress silently.
    const source = selectVectorStore.toString();
    expect(source).not.toMatch(/catch\s*\([^)]*\)\s*\{[^}]*new\s+SqliteVectorStore/);
    expect(source).not.toMatch(/\|\|\s*new\s+SqliteVectorStore/);
  });
});

// ============================================================
// Null store — specific behaviour, outside the conformance claim
// ============================================================

describe('R-Knowledge · null store specifics', () => {
  test('reports the refusal that caused its selection and degradation level 3', async () => {
    const store = new NullVectorStore('STORE_UNAUTHORISED_EGRESS', 'egress not authorised');
    const opened = await store.open();
    expect(opened.reason).toBe('STORE_UNAUTHORISED_EGRESS');
    expect(opened.degradationLevel).toBe(3);
  });

  test('refuses every write with the selection reason and writes nothing', async () => {
    const store = new NullVectorStore('STORE_UNCONFIGURED', 'no store');
    const { objects, vectors } = await makeObjects(2);
    const result = await store.upsert(objects, vectors);
    expect(result.written).toBe(0);
    expect(result.failures).toHaveLength(2);
    expect(result.failures.every((f) => f.reason === 'STORE_UNCONFIGURED')).toBe(true);
  });

  test('serves nothing rather than serving an empty success', async () => {
    const store = new NullVectorStore('STORE_UNCONFIGURED', 'no store');
    await store.open();
    const health = await store.health();
    // Not "reachable and empty" — which would be an empty success — but
    // explicitly unreachable with a reason.
    expect(health.reachable).toBe(false);
    expect(health.lastErrorCode).toBe('STORE_UNCONFIGURED');
  });
});

// ============================================================
// SQLite store — specific behaviour, outside the conformance claim
// ============================================================

describe('R-Knowledge · sqlite store specifics', () => {
  function makeStore(name: string): SqliteVectorStore {
    return new SqliteVectorStore(
      resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_VECTOR_STORE: 'sqlite',
        KNOWLEDGE_SQLITE_PATH: join(scratch, name),
        KNOWLEDGE_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      })
    );
  }

  test('persists across a close and reopen', async () => {
    const path = `persist-${Date.now()}.db`;
    const first = makeStore(path);
    await first.open();
    const { objects, vectors } = await makeObjects(3);
    expect((await first.upsert(objects, vectors)).written).toBe(3);
    await first.close();

    const second = makeStore(path);
    await second.open();
    expect((await second.stats()).objectCount).toBe(3);
    const found = await second.getById(objects[0].objectId);
    expect(found?.objectId).toBe(objects[0].objectId);
    await second.close();
  });

  test('retrieves by content hash for duplicate detection', async () => {
    const store = makeStore(`hash-${Date.now()}.db`);
    await store.open();
    const { objects, vectors } = await makeObjects(2);
    await store.upsert(objects, vectors);
    const found = await store.getByHash(objects[1].contentHash);
    expect(found?.contentHash).toBe(objects[1].contentHash);
    await store.close();
  });

  test('an object mutated in the database is excluded from search results (K-INV-2)', async () => {
    const path = join(scratch, `tamper-${Date.now()}.db`);
    const store = new SqliteVectorStore(
      resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_SQLITE_PATH: path,
        KNOWLEDGE_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      })
    );
    await store.open();
    const { objects, vectors } = await makeObjects(2);
    await store.upsert(objects, vectors);
    await store.close();

    // Mutate the stored JSON directly, simulating tampering outside the plane.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const Database = require('better-sqlite3') as new (file: string) => {
      prepare: (sql: string) => { run: (...params: unknown[]) => unknown };
      close: () => void;
    };
    const db = new Database(path);
    const tampered = { ...objects[0], content: `${objects[0].content} INJECTED` };
    db.prepare('UPDATE knowledge_objects SET object_json = ? WHERE object_id = ?').run(
      JSON.stringify(tampered),
      objects[0].objectId
    );
    db.close();

    const reopened = new SqliteVectorStore(
      resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_SQLITE_PATH: path,
        KNOWLEDGE_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      })
    );
    await reopened.open();
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    const query = await adapter.embed(['operational record frequency containment']);
    const hits = await reopened.search(query.vectors[0], 10);

    expect(hits.map((h) => h.objectId)).not.toContain(objects[0].objectId);
    expect(await reopened.getById(objects[0].objectId)).toBeNull();
    await reopened.close();
  });

  test('deletes by identifier and reports the count removed', async () => {
    const store = makeStore(`delete-${Date.now()}.db`);
    await store.open();
    const { objects, vectors } = await makeObjects(3);
    await store.upsert(objects, vectors);
    expect(await store.delete([objects[0].objectId, objects[1].objectId])).toBe(2);
    expect((await store.stats()).objectCount).toBe(1);
    await store.close();
  });

  test('the store ceiling is INTERNAL, not RESTRICTED', () => {
    const store = makeStore('ceiling.db');
    expect(store.capabilities.maxClassification).toBe('INTERNAL');
  });

  test('a write failure produces the level-2 condition rather than an exception', async () => {
    const store = makeStore(`refuse-${Date.now()}.db`);
    await store.open();
    store.simulateWriteRefusal();
    expect(store.isWriteRefused()).toBe(true);
    const health = await store.health();
    expect(health.lastErrorCode).toBe('STORE_WRITE_REFUSED');
    expect(health.reachable).toBe(true); // reachable but refusing writes = level 2
    await store.close();
  });

  test('an unopenable path is a degradation event, not an exception', async () => {
    const store = new SqliteVectorStore(
      resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        // A directory path cannot be opened as a database file.
        KNOWLEDGE_SQLITE_PATH: scratch,
        KNOWLEDGE_EMBEDDING_DIMENSIONS: String(DIMENSIONS),
      })
    );
    const opened = await store.open();
    expect(opened.ok).toBe(false);
    expect(opened.reason).toBe('STORE_UNAVAILABLE');
    expect(opened.degradationLevel).toBe(3);
  });

  test('holds no handle on the audit database', () => {
    // Isolation (STEP 1 § 13.2): a corrupt knowledge database cannot impair the
    // audit chain, because this module imports nothing from src/audit/.
    //
    // The assertion is made against the module's IMPORT and REQUIRE statements
    // rather than against the whole file, because the file's prose deliberately
    // discusses the audit database in order to record the isolation obligation.
    // Asserting on prose would make a governance comment a test failure, which
    // would be an incentive to delete the comment — exactly the wrong incentive.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const source = require('fs').readFileSync(
      require.resolve('../../src/knowledge/stores/sqlite-store'),
      'utf8'
    ) as string;

    const importLines = source
      .split('\n')
      .filter((line) => /^\s*(import\b|const\s+.*=\s*require\()/.test(line));

    expect(importLines.length).toBeGreaterThan(0);
    for (const line of importLines) {
      expect(line).not.toMatch(/audit/i);
      expect(line).not.toMatch(/hash-chain/);
    }

    // No reference to the audit database in EXECUTABLE code. Comments are
    // stripped first, for the reason stated above.
    const executable = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(executable).not.toMatch(/audit\.db/);
    expect(executable).not.toMatch(/AUDIT_DB_PATH/);
    expect(executable).not.toMatch(/verifyChain/);
    expect(executable).not.toMatch(/AuditHashChain/);
  });
});
