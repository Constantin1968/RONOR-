/**
 * Vector Store Selector
 * MIP-014 STEP 2 · Phase 3 (Store Layer)
 *
 * The selector is the single point at which a store is chosen, and it is written
 * so that the prohibited behaviours are *structurally impossible* rather than
 * merely unimplemented:
 *
 *   - There is no code path from a failed store selection to a different store.
 *     No `catch` block constructs an alternative, no `||` supplies a fallback and
 *     no default branch reaches SQLite. A reviewer can establish this by reading
 *     the function, which is the point (RK-015, RK-016).
 *
 *   - Production admissibility is evaluated BEFORE any adapter is constructed, so
 *     a refusal cannot be accompanied by a file having already been created
 *     (RK-016a). This is the second of two deliberately redundant controls; the
 *     first is `assessConfigAdmissibility` in the configuration resolver.
 *
 *   - A refusal returns a null store, which is a fully functional VectorStore
 *     that serves nothing. The plane therefore degrades rather than crashing, and
 *     no call site needs a null check.
 */

import {
  assessConfigAdmissibility,
} from '../../planes/r-knowledge/config';
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
import { QdrantVectorStore } from './qdrant-store';
import { SqliteVectorStore } from './sqlite-store';

// ============================================================
// The null store — a store that serves nothing, correctly
// ============================================================

/**
 * A complete VectorStore that holds nothing and refuses every mutation.
 *
 * The null-object pattern is used deliberately in place of returning `null`. A
 * null return would require every call site to branch, and a missing branch would
 * become an outage. This object cannot cause an outage: every method returns a
 * typed result, `open()` succeeds (there is nothing to open), and every write is
 * refused with the reason that caused the null store to be selected.
 *
 * Critically, it creates no file, opens no handle and resolves no hostname.
 */
export class NullVectorStore implements VectorStore {
  readonly id: VectorStoreId = 'null';
  readonly capabilities: VectorStoreCapabilities = Object.freeze({
    persistent: false,
    vectorSearch: false,
    lexicalFallback: false,
    maxClassification: 'PUBLIC' as const,
    transactional: false,
  });

  private readonly refusal: KnowledgeReasonCode;
  private readonly detail: string;

  constructor(refusal: KnowledgeReasonCode, detail: string) {
    this.refusal = refusal;
    this.detail = detail;
  }

  async open(): Promise<StoreOpenResult> {
    // Reports the refusal that caused its selection, and a degradation level of
    // 3, because a plane whose store serves nothing is unavailable — not
    // "available and empty", which would be an empty success.
    return {
      ok: false,
      storeId: this.id,
      reason: this.refusal,
      detail: this.detail,
      degradationLevel: 3,
    };
  }

  async close(): Promise<void> {
    // Idempotent no-op (N-7).
  }

  async upsert(
    objects: KnowledgeObject[],
    _vectors: Map<string, number[]>
  ): Promise<UpsertResult> {
    return {
      requested: objects.length,
      written: 0,
      failures: objects.map((o) => ({ objectId: o.objectId, reason: this.refusal, detail: this.detail })),
      ok: false,
    };
  }

  async search(
    _vector: number[],
    _k: number,
    _filters?: SearchFilters
  ): Promise<RawHit[]> {
    return [];
  }

  async getByHash(_contentHash: string): Promise<KnowledgeObject | null> {
    return null;
  }

  async getById(_objectId: string): Promise<KnowledgeObject | null> {
    return null;
  }

  async delete(_objectIds: string[]): Promise<number> {
    return 0;
  }

  async health(): Promise<StoreHealth> {
    return {
      storeId: this.id,
      reachable: false,
      latencyMs: 0,
      recordCount: 0,
      lastErrorCode: this.refusal,
      checkedAt: new Date(),
    };
  }

  async stats(): Promise<StoreStats> {
    return { storeId: this.id, objectCount: 0, dimensions: null, indexSizeBytes: null };
  }
}

// ============================================================
// Selection
// ============================================================

export interface StoreSelection {
  store: VectorStore;
  /** The store actually selected. Never differs from the configured store
   *  except by resolving to `null`; it is never silently another product. */
  selectedId: VectorStoreId;
  ok: boolean;
  reason: KnowledgeReasonCode | null;
  detail?: string;
}

/**
 * Select the configured store.
 *
 * Read this function as the enforcement of the environment/store policy. The
 * production check is first and is unconditional. There is no branch below it
 * that can be reached from a production configuration.
 */
export function selectVectorStore(config: KnowledgeConfig): StoreSelection {
  // ---- Environment/store policy, evaluated before any construction ----
  const admissibility = assessConfigAdmissibility(config);
  if (!admissibility.admissible) {
    const reason = (admissibility.reason ?? 'CONFIG_INVALID') as KnowledgeReasonCode;
    return {
      // A null store, not an alternative store. This is RK-016a and RK-016b: no
      // local database is created, no file appears under data/, and the plane
      // reports degradation level 3.
      store: new NullVectorStore(reason, admissibility.detail ?? 'configuration is not admissible'),
      selectedId: 'null',
      ok: false,
      reason,
      detail: admissibility.detail,
    };
  }

  switch (config.vectorStore) {
    case 'sqlite':
      // Reachable only in ci, test or development: the production branch above
      // returns before this point, unconditionally.
      return {
        store: new SqliteVectorStore(config),
        selectedId: 'sqlite',
        ok: true,
        reason: null,
      };

    case 'qdrant':
      // The adapter is constructed, but construction performs no input or
      // output. The adapter evaluates its own eight conditions precedent at
      // open() and refuses without egress unless all are satisfied.
      return {
        store: new QdrantVectorStore(config),
        selectedId: 'qdrant',
        ok: true,
        reason: null,
      };

    case 'null':
      return {
        store: new NullVectorStore(
          'STORE_UNCONFIGURED',
          'No vector store is configured. The plane serves no retrieval and creates no artefact.'
        ),
        selectedId: 'null',
        ok: false,
        reason: 'STORE_UNCONFIGURED',
      };

    default: {
      const unreachable: never = config.vectorStore;
      return {
        store: new NullVectorStore(
          'CONFIG_INVALID',
          `unrecognised store identifier: ${String(unreachable)}`
        ),
        selectedId: 'null',
        ok: false,
        reason: 'CONFIG_INVALID',
      };
    }
  }
}

/**
 * Whether a store may hold material at a given classification.
 *
 * A refusal here never redirects the material elsewhere (RK-015). The caller's
 * only options are to refuse the admission or to change the configuration; there
 * is no third option in which the object is written somewhere else.
 */
export function storeAdmitsClassification(
  store: VectorStore,
  classification: KnowledgeObject['classification']
): { ok: boolean; reason: KnowledgeReasonCode | null } {
  const rank: Record<KnowledgeObject['classification'], number> = {
    PUBLIC: 0,
    INTERNAL: 1,
    CONFIDENTIAL: 2,
    RESTRICTED: 3,
  };
  if (rank[classification] > rank[store.capabilities.maxClassification]) {
    return { ok: false, reason: 'STORE_CLASSIFICATION_REFUSED' };
  }
  return { ok: true, reason: null };
}
