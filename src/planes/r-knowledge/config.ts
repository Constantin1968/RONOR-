/**
 * R-Knowledge — Configuration Resolver
 * MIP-014 STEP 2 · Phase 1 (Contract Foundations)
 *
 * The activation predicate is the single most governance-sensitive line in the
 * plane and is therefore stated once, here, and nowhere else:
 *
 *     process.env.KNOWLEDGE_ENABLED === 'true'
 *
 * Strict equality against the lowercase string literal. Every other value —
 * '1', 'yes', 'TRUE', 'True', empty, unset, malformed — yields DISABLED
 * (Order Article 2.2; STEP 1 § 4.1).
 *
 * This module reads configuration. It constructs no store, opens no handle,
 * creates no directory and performs no input or output. Resolution is a pure
 * function of the environment snapshot it is given.
 */

import type {
  EmbeddingProviderId,
  KnowledgeClassification,
  KnowledgeConfig,
  KnowledgeEnvironmentClass,
  QdrantAdapterConfig,
  VectorStoreId,
} from './types';

/** Environment source. Injectable so that tests need not mutate `process.env`. */
export type EnvSource = Record<string, string | undefined>;

// ------------------------------------------------------------
// Pinned Qdrant reference values — Pre-Implementation Dossier § 1.2
//
// These values fix a protocol surface for writing the adapter. Their presence
// confers NO authority to obtain, run, reach or operate a server bearing them
// (Order Article 3.1; dossier § 0.2).
// ------------------------------------------------------------

export const QDRANT_PINNED_SERVER_VERSION = 'v1.18.3' as const;
export const QDRANT_PINNED_CLIENT_VERSION = '1.18.0' as const;
export const QDRANT_PINNED_IMAGE_DIGEST =
  'sha256:0bd98fa7977f1e75694779359ca4e212822e5a71334e28421182f72f209d5286' as const;

/** Defaults, stated explicitly so that no value is implicit. */
export const KNOWLEDGE_DEFAULTS = Object.freeze({
  vectorStore: 'sqlite' as VectorStoreId,
  sqlitePath: './data/knowledge.db',
  embeddingProvider: 'deterministic' as EmbeddingProviderId,
  embeddingDimensions: 384,
  maxClassification: 'INTERNAL' as KnowledgeClassification,
  chunkSizeTokens: 512,
  chunkOverlapTokens: 64,
  retrievalTopK: 8,
  minSimilarity: 0.25,
  ragMinSources: 2,
  quarantinePath: './data/knowledge-quarantine.jsonl',
  qdrantCollection: 'ronor_knowledge',
  qdrantTimeoutMs: 2000,
  qdrantMaxRetries: 2,
});

// ------------------------------------------------------------
// The activation predicate
// ------------------------------------------------------------

/**
 * The sole activation predicate of the plane. Exported so that the conformance
 * suite asserts the predicate itself rather than a paraphrase of it.
 */
export function isKnowledgeEnabled(env: EnvSource = process.env): boolean {
  return env.KNOWLEDGE_ENABLED === 'true';
}

// ------------------------------------------------------------
// Resolution helpers — total functions, no throwing
// ------------------------------------------------------------

function resolveEnvironmentClass(env: EnvSource): KnowledgeEnvironmentClass {
  // An explicit classification wins, because a deployment must be able to
  // declare itself production irrespective of NODE_ENV conventions.
  const explicit = (env.KNOWLEDGE_ENVIRONMENT_CLASS || '').trim().toLowerCase();
  if (explicit === 'ci' || explicit === 'test' || explicit === 'development' || explicit === 'production') {
    return explicit;
  }
  if (env.CI === 'true' || env.GITHUB_ACTIONS === 'true') return 'ci';
  const nodeEnv = (env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'production') return 'production';
  if (nodeEnv === 'test') return 'test';
  return 'development';
}

function resolveStore(env: EnvSource): VectorStoreId {
  const raw = (env.KNOWLEDGE_VECTOR_STORE || '').trim().toLowerCase();
  if (raw === 'sqlite' || raw === 'qdrant' || raw === 'none') {
    return raw === 'none' ? 'null' : raw;
  }
  if (raw === 'null') return 'null';
  // ChromaDB is EXCLUDED FOR THE CURRENT BASELINE (ADR-K02 Rev 3 § 3). A
  // configuration naming it does not select it and does not silently fall back
  // to another store; it resolves to the null store, which serves nothing.
  if (raw === 'chroma' || raw === 'chromadb') return 'null';
  return raw.length === 0 ? KNOWLEDGE_DEFAULTS.vectorStore : 'null';
}

function resolveEmbeddingProvider(env: EnvSource): EmbeddingProviderId {
  const raw = (env.KNOWLEDGE_EMBEDDING_PROVIDER || '').trim().toLowerCase();
  if (raw === 'deterministic' || raw === 'local' || raw === 'external') return raw;
  return KNOWLEDGE_DEFAULTS.embeddingProvider;
}

function resolveClassification(env: EnvSource): KnowledgeClassification {
  const raw = (env.KNOWLEDGE_MAX_CLASSIFICATION || '').trim().toUpperCase();
  if (raw === 'PUBLIC' || raw === 'INTERNAL' || raw === 'CONFIDENTIAL' || raw === 'RESTRICTED') {
    return raw;
  }
  return KNOWLEDGE_DEFAULTS.maxClassification;
}

function resolveInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseInt((raw || '').trim(), 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

function resolveFloat(raw: string | undefined, fallback: number, min: number, max: number): number {
  const parsed = Number.parseFloat((raw || '').trim());
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min || parsed > max) return fallback;
  return parsed;
}

/** Boolean keys are as strict as the master switch: only 'true' is true. */
function resolveStrictBoolean(raw: string | undefined): boolean {
  return raw === 'true';
}

function resolveQdrant(env: EnvSource): QdrantAdapterConfig {
  return Object.freeze({
    endpoint: (env.KNOWLEDGE_QDRANT_ENDPOINT || '').trim(),
    // The key material itself is never read into configuration, never stored
    // and never logged. Only its presence is recorded (dossier § 5).
    apiKeyPresent: typeof env.KNOWLEDGE_QDRANT_API_KEY === 'string' && env.KNOWLEDGE_QDRANT_API_KEY.length > 0,
    collection: (env.KNOWLEDGE_QDRANT_COLLECTION || '').trim() || KNOWLEDGE_DEFAULTS.qdrantCollection,
    timeoutMs: resolveInt(env.KNOWLEDGE_QDRANT_TIMEOUT_MS, KNOWLEDGE_DEFAULTS.qdrantTimeoutMs, 100, 10_000),
    maxRetries: resolveInt(env.KNOWLEDGE_QDRANT_MAX_RETRIES, KNOWLEDGE_DEFAULTS.qdrantMaxRetries, 0, 5),
    environmentAuthorisationRef: (env.KNOWLEDGE_QDRANT_ENVIRONMENT_AUTHORISATION || '').trim(),
    telemetryDisabled: env.QDRANT__TELEMETRY_DISABLED === 'true',
    tlsRequired: true,
    expectedServerVersion: QDRANT_PINNED_SERVER_VERSION,
    pinnedClientVersion: QDRANT_PINNED_CLIENT_VERSION,
    pinnedImageDigest: QDRANT_PINNED_IMAGE_DIGEST,
  });
}

// ------------------------------------------------------------
// Resolution
// ------------------------------------------------------------

/**
 * Resolve the plane configuration from an environment snapshot. Pure: the same
 * snapshot always yields the same configuration, and no key is read twice.
 *
 * Subordination is structural. When `enabled` is false the subordinate keys are
 * still *recorded* for diagnostic transparency, but no consumer may act on them,
 * because the composition root never constructs the plane at all.
 */
export function resolveKnowledgeConfig(env: EnvSource = process.env): KnowledgeConfig {
  const embeddingModelRaw = (env.KNOWLEDGE_EMBEDDING_MODEL || '').trim();

  return Object.freeze({
    enabled: isKnowledgeEnabled(env),
    environmentClass: resolveEnvironmentClass(env),
    vectorStore: resolveStore(env),
    sqlitePath: (env.KNOWLEDGE_SQLITE_PATH || '').trim() || KNOWLEDGE_DEFAULTS.sqlitePath,
    embeddingProvider: resolveEmbeddingProvider(env),
    embeddingDimensions: resolveInt(
      env.KNOWLEDGE_EMBEDDING_DIMENSIONS,
      KNOWLEDGE_DEFAULTS.embeddingDimensions,
      8,
      4096
    ),
    // No vendor model string is ever a default. An empty value stays null.
    embeddingModel: embeddingModelRaw.length > 0 ? embeddingModelRaw : null,
    externalEgressAuthorised: resolveStrictBoolean(env.KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED),
    maxClassification: resolveClassification(env),
    chunkSizeTokens: resolveInt(
      env.KNOWLEDGE_CHUNK_SIZE_TOKENS,
      KNOWLEDGE_DEFAULTS.chunkSizeTokens,
      32,
      8192
    ),
    chunkOverlapTokens: resolveInt(
      env.KNOWLEDGE_CHUNK_OVERLAP_TOKENS,
      KNOWLEDGE_DEFAULTS.chunkOverlapTokens,
      0,
      2048
    ),
    retrievalTopK: resolveInt(env.KNOWLEDGE_RETRIEVAL_TOP_K, KNOWLEDGE_DEFAULTS.retrievalTopK, 1, 100),
    minSimilarity: resolveFloat(env.KNOWLEDGE_MIN_SIMILARITY, KNOWLEDGE_DEFAULTS.minSimilarity, 0, 1),
    ragEnabled: resolveStrictBoolean(env.KNOWLEDGE_RAG_ENABLED),
    ragMinSources: resolveInt(env.KNOWLEDGE_RAG_MIN_SOURCES, KNOWLEDGE_DEFAULTS.ragMinSources, 1, 50),
    quarantinePath: (env.KNOWLEDGE_QUARANTINE_PATH || '').trim() || KNOWLEDGE_DEFAULTS.quarantinePath,
    qdrant: resolveQdrant(env),
  });
}

// ------------------------------------------------------------
// Configuration admissibility — the environment/store policy
// ------------------------------------------------------------

export interface ConfigAdmissibility {
  admissible: boolean;
  reason:
    | null
    | 'SQLITE_PROHIBITED_IN_PRODUCTION'
    | 'NO_AUTHORISED_PRODUCTION_STORE'
    | 'CONFIG_INVALID';
  detail?: string;
}

/**
 * The environment/store policy of STEP 1 §§ 9.2 and 9.3, evaluated at
 * configuration time. This is the first of the two deliberately redundant
 * controls on the SQLite production prohibition; the second is the structural
 * absence of any fallback code path in the store selector.
 *
 * The function decides admissibility. It opens nothing, so a refusal cannot be
 * accompanied by a file having already been created.
 */
export function assessConfigAdmissibility(config: KnowledgeConfig): ConfigAdmissibility {
  if (config.chunkOverlapTokens >= config.chunkSizeTokens) {
    return {
      admissible: false,
      reason: 'CONFIG_INVALID',
      detail: 'chunk overlap must be strictly smaller than chunk size',
    };
  }

  if (config.environmentClass === 'production') {
    if (config.vectorStore === 'sqlite') {
      return {
        admissible: false,
        reason: 'SQLITE_PROHIBITED_IN_PRODUCTION',
        detail:
          'SQLite is authorised for CI, automated testing and local development only. ' +
          'Production requires an externally governed store holding explicit written approval.',
      };
    }
    // No externally governed store holds production authorisation under
    // MIP-014. Qdrant is a candidate for validation and is expressly not
    // production-certified (ADR-K02 Rev 3). The plane therefore has no
    // authorised production configuration, by design and by disclosure.
    return {
      admissible: false,
      reason: 'NO_AUTHORISED_PRODUCTION_STORE',
      detail:
        'No vector store holds explicit written production authorisation for this environment. ' +
        'R-Knowledge resolves to degradation level 3 and shall not create or use a local database.',
    };
  }

  return { admissible: true, reason: null };
}
