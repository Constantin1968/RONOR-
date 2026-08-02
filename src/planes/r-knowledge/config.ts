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
  OpenAIEmbeddingConfig,
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
  // Learned-provider defaults (MIP-015 STEP 3).
  //
  // Neither a model NOR an endpoint is defaulted to a vendor value. An operator
  // selecting the learned provider must name both, so that no corpus is ever
  // embedded by an unnamed model and no request is ever addressed to an endpoint
  // nobody chose. The conformance suite asserts that this object contains no
  // vendor string at all, and that assertion is worth keeping literally true.
  // Key names are vendor-neutral. These are properties of the LEARNED-PROVIDER
  // CLASS — timeout, retry budget, batch width — not of any particular vendor,
  // and naming them after one would embed a vendor into a structure the
  // conformance suite requires to be free of vendor strings.
  learnedTimeoutMs: 30_000,
  learnedMaxRetries: 2,
  learnedBatchSize: 64,
});

/**
 * Known output dimensionality of published embedding models.
 *
 * Deliberately NOT a member of `KNOWLEDGE_DEFAULTS`. The conformance suite
 * asserts that no vendor model string appears anywhere in the defaults, and that
 * assertion is worth keeping literally true: a lookup table living inside the
 * defaults would defeat a mechanical check whose whole purpose is to guarantee
 * that no corpus is ever embedded by a model nobody named.
 *
 * This is a reference table consulted only AFTER an operator has named a model.
 * It confers no authorisation to call any model in it, and its presence cannot
 * cause a model to be selected — `resolveOpenAI` reads it only when
 * `config.model` is already non-null.
 */
export const PUBLISHED_EMBEDDING_MODEL_DIMENSIONS: Readonly<Record<string, number>> = Object.freeze({
  'text-embedding-3-small': 1536,
  'text-embedding-3-large': 3072,
  'text-embedding-ada-002': 1536,
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
  if (raw === 'deterministic' || raw === 'local' || raw === 'external' || raw === 'openai') {
    return raw;
  }
  return KNOWLEDGE_DEFAULTS.embeddingProvider;
}

/**
 * Resolve the OpenAI embedding configuration.
 *
 * Two environment variable families are consulted, in this order of precedence:
 *   1. `KNOWLEDGE_OPENAI_*` — plane-specific, wins when present.
 *   2. `OPENAI_API_KEY` / `OPENAI_API_BASE` — the process-wide convention.
 *
 * The plane-specific family exists so that an operator can point R-Knowledge at a
 * different endpoint or credential from the rest of the runtime without having to
 * disturb the shared variables. Reading the shared variables as a fallback is what
 * makes the common single-credential deployment work without duplication.
 *
 * The credential is NOT read into the returned structure. Only its presence is.
 */
function resolveOpenAI(env: EnvSource, dimensionsFallback: number): OpenAIEmbeddingConfig {
  const model = (env.KNOWLEDGE_OPENAI_MODEL || '').trim() || (env.KNOWLEDGE_EMBEDDING_MODEL || '').trim();
  // No vendor endpoint default. An unconfigured base URL stays empty, and the
  // adapter's ENDPOINT_ABSOLUTE condition then refuses — which is the correct
  // outcome, because a request addressed to a default nobody chose is exactly the
  // silent egress this plane exists to prevent.
  const baseUrl =
    (env.KNOWLEDGE_OPENAI_BASE_URL || '').trim() || (env.OPENAI_API_BASE || '').trim();

  const keyPresent =
    (typeof env.KNOWLEDGE_OPENAI_API_KEY === 'string' && env.KNOWLEDGE_OPENAI_API_KEY.length > 0) ||
    (typeof env.OPENAI_API_KEY === 'string' && env.OPENAI_API_KEY.length > 0);

  // When the model is one whose width is known, that width governs. An explicit
  // KNOWLEDGE_EMBEDDING_DIMENSIONS that disagrees with a known model would
  // otherwise silently produce a corpus at the wrong width, so the known value is
  // preferred and the disagreement is surfaced by assessConfigAdmissibility.
  const knownDimensions = model.length > 0 ? PUBLISHED_EMBEDDING_MODEL_DIMENSIONS[model] : undefined;

  return Object.freeze({
    baseUrl,
    apiKeyPresent: keyPresent,
    model: model.length > 0 ? model : null,
    dimensions: typeof knownDimensions === 'number' ? knownDimensions : dimensionsFallback,
    timeoutMs: resolveInt(env.KNOWLEDGE_OPENAI_TIMEOUT_MS, KNOWLEDGE_DEFAULTS.learnedTimeoutMs, 500, 120_000),
    maxRetries: resolveInt(env.KNOWLEDGE_OPENAI_MAX_RETRIES, KNOWLEDGE_DEFAULTS.learnedMaxRetries, 0, 5),
    batchSize: resolveInt(env.KNOWLEDGE_OPENAI_BATCH_SIZE, KNOWLEDGE_DEFAULTS.learnedBatchSize, 1, 2048),
    // Fallback is ON unless explicitly disabled. An operator who requires that
    // the corpus be embedded ONLY by the learned model sets this to 'false', and
    // then an unreachable provider becomes a refusal instead of a silent quality
    // downgrade. Both behaviours are legitimate; neither may be implicit.
    fallbackToDeterministic: env.KNOWLEDGE_OPENAI_FALLBACK !== 'false',
  });
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

/**
 * Distance metric for a provisioned collection.
 *
 * Cosine is the default and is the correct pairing for the plane's L2-normalised
 * vectors: with unit-length vectors cosine and dot agree, and cosine remains
 * correct if a future embedder emits unnormalised output. An unrecognised value
 * resolves to Cosine rather than being refused, because the metric is a
 * performance characteristic rather than a governance boundary.
 */
function resolveDistance(env: EnvSource): 'Cosine' | 'Dot' | 'Euclid' {
  const raw = (env.KNOWLEDGE_QDRANT_DISTANCE || '').trim().toLowerCase();
  if (raw === 'dot') return 'Dot';
  if (raw === 'euclid' || raw === 'euclidean') return 'Euclid';
  return 'Cosine';
}

function resolveQdrant(env: EnvSource): QdrantAdapterConfig {
  return Object.freeze({
    // Two variable families, plane-specific first. `QDRANT_URL`,
    // `QDRANT_API_KEY` and `QDRANT_COLLECTION_NAME` are the conventional names an
    // operator will already have in a deployment manifest; the `KNOWLEDGE_QDRANT_*`
    // family exists so R-Knowledge can be pointed elsewhere without disturbing
    // them. Precedence is plane-specific over conventional, so the more specific
    // instruction always wins.
    endpoint: (env.KNOWLEDGE_QDRANT_ENDPOINT || '').trim() || (env.QDRANT_URL || '').trim(),
    // The key material itself is never read into configuration, never stored
    // and never logged. Only its presence is recorded (dossier § 5).
    apiKeyPresent:
      (typeof env.KNOWLEDGE_QDRANT_API_KEY === 'string' && env.KNOWLEDGE_QDRANT_API_KEY.length > 0) ||
      (typeof env.QDRANT_API_KEY === 'string' && env.QDRANT_API_KEY.length > 0),
    collection:
      (env.KNOWLEDGE_QDRANT_COLLECTION || '').trim() ||
      (env.QDRANT_COLLECTION_NAME || '').trim() ||
      KNOWLEDGE_DEFAULTS.qdrantCollection,
    timeoutMs: resolveInt(env.KNOWLEDGE_QDRANT_TIMEOUT_MS, KNOWLEDGE_DEFAULTS.qdrantTimeoutMs, 100, 10_000),
    maxRetries: resolveInt(env.KNOWLEDGE_QDRANT_MAX_RETRIES, KNOWLEDGE_DEFAULTS.qdrantMaxRetries, 0, 5),
    // Strict, like every other boolean in the plane: only the exact string 'true'
    // enables provisioning. Auto-creating storage nobody asked for is how a typo in
    // a collection name becomes an empty corpus that appears to be working.
    autoCreateCollection: resolveStrictBoolean(env.KNOWLEDGE_QDRANT_AUTO_CREATE_COLLECTION),
    distance: resolveDistance(env),
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
  const provider = resolveEmbeddingProvider(env);
  const declaredDimensions = resolveInt(
    env.KNOWLEDGE_EMBEDDING_DIMENSIONS,
    KNOWLEDGE_DEFAULTS.embeddingDimensions,
    8,
    4096
  );
  const openai = resolveOpenAI(env, declaredDimensions);

  // When the learned provider is selected, the ACTIVE dimensionality is the one
  // the model actually emits, not the plane's 384-wide default. Leaving the
  // default in place would cause every vector to be refused by the dimension
  // check — a refusal that is correct in mechanism but useless in practice, since
  // the operator's intent is unambiguous once they have named the model.
  const effectiveDimensions = provider === 'openai' ? openai.dimensions : declaredDimensions;

  return Object.freeze({
    enabled: isKnowledgeEnabled(env),
    environmentClass: resolveEnvironmentClass(env),
    vectorStore: resolveStore(env),
    sqlitePath: (env.KNOWLEDGE_SQLITE_PATH || '').trim() || KNOWLEDGE_DEFAULTS.sqlitePath,
    embeddingProvider: provider,
    embeddingDimensions: effectiveDimensions,
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
    openai,
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

  // The learned provider requires a named model. Selecting `openai` without
  // naming a model is inadmissible rather than defaulted, because a corpus
  // embedded by an unnamed model cannot be reproduced or re-embedded later.
  if (config.embeddingProvider === 'openai' && config.openai.model === null) {
    return {
      admissible: false,
      reason: 'CONFIG_INVALID',
      detail:
        'KNOWLEDGE_EMBEDDING_PROVIDER=openai requires KNOWLEDGE_OPENAI_MODEL (or ' +
        'KNOWLEDGE_EMBEDDING_MODEL) to name the model explicitly. The plane supplies no ' +
        'vendor model as a default.',
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

    // MIP-015 STEP 3 authorises Qdrant as the production store, superseding the
    // MIP-014 position in which no store held production authorisation. The
    // authorisation is conditional, not blanket: the adapter still enforces its
    // eight conditions precedent at open() time, so an authorised-but-
    // misconfigured deployment degrades rather than proceeding.
    if (config.vectorStore === 'qdrant') {
      if (config.qdrant.endpoint.length === 0) {
        return {
          admissible: false,
          reason: 'CONFIG_INVALID',
          detail:
            'The production store is Qdrant but no endpoint is configured. Set QDRANT_URL ' +
            '(or KNOWLEDGE_QDRANT_ENDPOINT) to an absolute https:// URL.',
        };
      }
      return { admissible: true, reason: null };
    }

    // The null store in production is admissible as an explicit choice: it is how
    // an operator runs the plane mounted but serving nothing. It is not a silent
    // fallback, because resolveStore never selects it from an empty value.
    if (config.vectorStore === 'null') {
      return { admissible: true, reason: null };
    }

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
