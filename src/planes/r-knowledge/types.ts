/**
 * R-Knowledge — Type Surface
 * MIP-014 STEP 2 · Phase 1 (Contract Foundations)
 *
 * The ninth operational plane of the RONOR runtime. This module declares the
 * plane's type surface only: the Knowledge Object contract of STEP 1 § 7, the
 * retrieval result contract of STEP 1 § 7.5, the store and embedding
 * abstractions of STEP 1 §§ 9.1 and 11.2, the four-level degradation ladder of
 * STEP 1 § 13.1 and the reason-code taxonomy.
 *
 * Governance properties of this file:
 *   - It declares types. It constructs nothing, opens nothing and reads no
 *     configuration. Importing it has no side effect of any kind.
 *   - Nothing here references the AuditHashChain, and nothing here constitutes
 *     or names an Evidence Registry (ADR-K01 Revision 3, decision items 4, 5, 6).
 *   - The `VectorStore` contract is architecture-neutral: no member, no field
 *     and no reason code is specific to any vendor product
 *     (ADR-K02 Revision 3 requirement GR-11; dossier invariants N-1 to N-8).
 */

import { z } from 'zod';

// ============================================================
// Classification and sovereignty
// ============================================================

/** Corpus classification ladder, ascending in sensitivity. */
export type KnowledgeClassification = 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED';

/**
 * Ordinal rank of each classification. Comparison is by rank, never by string
 * ordering, so that a ceiling check cannot be defeated by alphabetisation.
 */
export const CLASSIFICATION_RANK: Readonly<Record<KnowledgeClassification, number>> = Object.freeze({
  PUBLIC: 0,
  INTERNAL: 1,
  CONFIDENTIAL: 2,
  RESTRICTED: 3,
});

/** Provenance typing of an admitted source. */
export type KnowledgeSourceType =
  | 'document'
  | 'dataset'
  | 'standard'
  | 'filing'
  | 'report'
  | 'synthetic';

// ============================================================
// Knowledge Object — STEP 1 § 7
// ============================================================

/**
 * Reproducibility record binding a vector to the adapter that produced it.
 * `model` is nullable by contract: an object embedded by the deterministic
 * reference adapter carries `provider: 'deterministic'` and `model: null`, and
 * is a fully valid Knowledge Object. This is the type-level expression of
 * vendor independence (STEP 1 § 11.1).
 */
export interface EmbeddingRef {
  provider: string;
  model: string | null;
  dimensions: number;
  vectorHash: string;
}

/** Citation integrity and provenance completeness record. */
export interface KnowledgeProvenance {
  parentDocumentId: string;
  retrievalPath: string;
  citationLabel: string;
  /** Computed by the plane, never supplied by a caller (K-INV-6). */
  completeness: number;
}

/**
 * The atomic unit of the plane and the sole currency of every interface within
 * it. Fourteen mandatory fields; seven optional fields.
 */
export interface KnowledgeObject {
  objectId: string;
  schemaVersion: string;
  contentHash: string;
  content: string;
  sourceUri: string;
  sourceType: KnowledgeSourceType;
  classification: KnowledgeClassification;
  sovereigntyTier: 1 | 2 | 3;
  ingestedAt: string;
  ingestedBy: string;
  chunkIndex: number;
  chunkTotal: number;
  embeddingRef: EmbeddingRef;
  provenance: KnowledgeProvenance;

  // Optional fields — STEP 1 § 7.3
  title?: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  tags?: string[];
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

/** The current and only recognised Knowledge Object schema version. */
export const KNOWLEDGE_SCHEMA_VERSION = '1.0' as const;

/**
 * The fourteen mandatory field names, in contract order. Exported so that the
 * conformance suite enumerates the contract rather than restating it.
 */
export const MANDATORY_KNOWLEDGE_FIELDS: readonly string[] = Object.freeze([
  'objectId',
  'schemaVersion',
  'contentHash',
  'content',
  'sourceUri',
  'sourceType',
  'classification',
  'sovereigntyTier',
  'ingestedAt',
  'ingestedBy',
  'chunkIndex',
  'chunkTotal',
  'embeddingRef',
  'provenance',
]);

// ============================================================
// Retrieval result contract — STEP 1 § 7.5
// ============================================================

/**
 * A retrieval result is a Knowledge Object plus retrieval-time attribution.
 * The two are separated so that retrieval-time values can never be written
 * back into the corpus.
 */
export interface KnowledgeRetrievalResult {
  object: KnowledgeObject;
  score: number;
  rank: number;
  citation: string;
  provenanceComplete: boolean;
  retrievedAt: string;
  storeId: string;
  embeddingProvider: string;
  degraded: boolean;
}

/** Envelope returned by the retrieval pipeline, including explicit emptiness. */
export interface KnowledgeRetrievalResponse {
  ok: boolean;
  results: KnowledgeRetrievalResult[];
  /**
   * Populated whenever `results` is empty or the response is degraded. A
   * zero-result retrieval is an explicit, reasoned outcome — never an empty
   * success and never substituted model knowledge (STEP 1 § 8.2 R-11).
   */
  reason: KnowledgeReasonCode | null;
  degradationLevel: DegradationLevel;
  storeId: string;
  embeddingProvider: string;
  queryNormalised: boolean;
  generatedAt: string;
}

// ============================================================
// Reason-code taxonomy
// ============================================================

/**
 * Every refusal, degradation and failure in the plane is a typed reason code.
 * No member of this union is vendor-specific: the store-related codes are
 * expressed in terms of the abstract store contract, which is what preserves
 * architecture neutrality (dossier invariant N-4).
 */
export type KnowledgeReasonCode =
  // Activation and configuration
  | 'KNOWLEDGE_DISABLED'
  | 'CONFIG_INVALID'
  | 'SQLITE_PROHIBITED_IN_PRODUCTION'
  | 'NO_AUTHORISED_PRODUCTION_STORE'
  // Admission
  | 'ADMISSION_MALFORMED'
  | 'ADMISSION_TOO_LARGE'
  | 'CLASSIFICATION_CEILING_EXCEEDED'
  | 'INJECTION_DETECTED'
  | 'NORMALISATION_FAILED'
  | 'SCHEMA_INVALID'
  | 'INTEGRITY_FAILED'
  | 'DUPLICATE_OBJECT'
  // Embedding
  | 'EMBEDDING_UNAVAILABLE'
  | 'EMBEDDING_MODEL_ABSENT'
  | 'EMBEDDING_CREDENTIALS_ABSENT'
  | 'EMBEDDING_EGRESS_UNAUTHORISED'
  | 'EMBEDDING_DIMENSION_MISMATCH'
  | 'EMBEDDING_PROVIDER_MISMATCH'
  // Store — abstract, vendor-neutral
  | 'STORE_UNCONFIGURED'
  | 'STORE_UNAVAILABLE'
  | 'STORE_WRITE_REFUSED'
  | 'STORE_UNAUTHORISED_EGRESS'
  | 'STORE_CLASSIFICATION_REFUSED'
  | 'STORE_DIMENSION_MISMATCH'
  | 'STORE_CIRCUIT_OPEN'
  | 'STORE_TIMEOUT'
  | 'STORE_AUTH_FAILURE'
  | 'STORE_TLS_FAILURE'
  | 'STORE_PROTOCOL_ERROR'
  | 'STORE_NOT_AUTHORISED_FOR_ENVIRONMENT'
  | 'STORE_VERSION_MISMATCH'
  // Retrieval and generation
  | 'RETRIEVAL_EMPTY'
  | 'RETRIEVAL_BELOW_SIMILARITY_FLOOR'
  | 'RETRIEVAL_UNAVAILABLE'
  | 'RAG_DISABLED'
  | 'RAG_INSUFFICIENT_EVIDENCE'
  | 'RAG_CITATION_UNRESOLVABLE';

// ============================================================
// Degradation ladder — STEP 1 § 13.1
// ============================================================

/**
 * Four levels. Every level is reversible without restart and without data loss.
 *   0 Normal · 1 Embedding degraded · 2 Store degraded · 3 Plane unavailable
 */
export type DegradationLevel = 0 | 1 | 2 | 3;

export interface DegradationState {
  level: DegradationLevel;
  name: 'normal' | 'embedding-degraded' | 'store-degraded' | 'plane-unavailable';
  reason: KnowledgeReasonCode | null;
  /** Every R-Knowledge degradation is reversible — enforced by construction. */
  reversible: true;
  since: Date;
}

// ============================================================
// Store abstraction — STEP 1 § 9.1
// ============================================================

/**
 * Store identity. The union is open to additional governed adapters; it names
 * capability classes, not products, save where an adapter's identifier is
 * necessarily its own name.
 */
export type VectorStoreId = 'sqlite' | 'qdrant' | 'null';

export interface VectorStoreCapabilities {
  persistent: boolean;
  vectorSearch: boolean;
  lexicalFallback: boolean;
  maxClassification: KnowledgeClassification;
  transactional: boolean;
}

export interface UpsertResult {
  requested: number;
  written: number;
  /** Per-object failures, reported explicitly and never silently. */
  failures: { objectId: string; reason: KnowledgeReasonCode; detail?: string }[];
  ok: boolean;
}

export interface RawHit {
  objectId: string;
  score: number;
}

export interface SearchFilters {
  maxClassification?: KnowledgeClassification;
  parentDocumentId?: string;
  sourceType?: KnowledgeSourceType;
}

export interface StoreHealth {
  storeId: VectorStoreId;
  reachable: boolean;
  latencyMs: number;
  recordCount: number;
  lastErrorCode: KnowledgeReasonCode | null;
  checkedAt: Date;
}

export interface StoreStats {
  storeId: VectorStoreId;
  objectCount: number;
  dimensions: number | null;
  indexSizeBytes: number | null;
}

/**
 * The architecture-neutral persistence contract. Every pipeline stage reaches
 * persistence through this interface and no pipeline stage contains
 * store-specific logic.
 *
 * Neutrality obligations (dossier § 8, invariants N-1 to N-8):
 *   N-1 The interface names no vendor concept.
 *   N-2 No member signature is shaped by any product's protocol.
 *   N-3 Adapters are substitutable without a pipeline change.
 *   N-4 Failures surface as the abstract reason codes above.
 *   N-5 No adapter type leaks through this contract.
 *   N-6 The shared conformance suite has no adapter-specific branch.
 *   N-7 `open()` and `close()` are idempotent; neither throws across the plane
 *       boundary.
 *   N-8 No member may perform network input or output unless the adapter has
 *       been explicitly authorised to do so.
 */
export interface VectorStore {
  readonly id: VectorStoreId;
  readonly capabilities: VectorStoreCapabilities;
  open(): Promise<StoreOpenResult>;
  close(): Promise<void>;
  upsert(objects: KnowledgeObject[], vectors: Map<string, number[]>): Promise<UpsertResult>;
  search(vector: number[], k: number, filters?: SearchFilters): Promise<RawHit[]>;
  getByHash(contentHash: string): Promise<KnowledgeObject | null>;
  getById(objectId: string): Promise<KnowledgeObject | null>;
  delete(objectIds: string[]): Promise<number>;
  health(): Promise<StoreHealth>;
  stats(): Promise<StoreStats>;
}

/**
 * `open()` returns a typed outcome rather than throwing, because a store that
 * cannot open is a degradation event and not an exception (STEP 1 § 9.1).
 */
export interface StoreOpenResult {
  ok: boolean;
  storeId: VectorStoreId;
  reason: KnowledgeReasonCode | null;
  detail?: string;
  /** Degradation level implied by a refusal, per STEP 1 § 13.1. */
  degradationLevel: DegradationLevel;
}

// ============================================================
// Embedding abstraction — STEP 1 § 11.2
// ============================================================

/**
 * Embedding provider identifiers.
 *
 * `openai` is added by MIP-015 (STEP 3) as a LEARNED provider requiring network
 * egress and a credential. It is an ADDITION to the union, not a replacement:
 * `deterministic` remains the offline provider and remains the value actually
 * used whenever egress is unauthorised, no credential is present, or the learned
 * provider is unreachable. A learned provider that cannot be reached must never
 * become a silent outage, so the plane falls back rather than failing closed on
 * retrieval.
 */
export type EmbeddingProviderId = 'deterministic' | 'local' | 'external' | 'openai';

/**
 * Resolved configuration for the OpenAI-compatible embedding provider.
 *
 * The credential itself never appears in this structure — only whether one is
 * present. This mirrors the Qdrant configuration discipline: configuration is a
 * diagnostic surface, and a diagnostic surface that can disclose a credential is
 * a defect regardless of who is expected to read it.
 */
export interface OpenAIEmbeddingConfig {
  /** Absolute base URL of the OpenAI-compatible API. */
  readonly baseUrl: string;
  /** Whether a credential is available. Never the credential itself. */
  readonly apiKeyPresent: boolean;
  /**
   * Explicit model identifier. Null unless configured: the plane never supplies
   * a vendor model string as a default (STEP 1 § 11.1).
   */
  readonly model: string | null;
  /** Declared output dimensionality expected from the model. */
  readonly dimensions: number;
  /** Per-request timeout in milliseconds. */
  readonly timeoutMs: number;
  /** Maximum retry attempts on a retryable failure. */
  readonly maxRetries: number;
  /** Maximum number of texts submitted in a single request. */
  readonly batchSize: number;
  /**
   * Whether the plane may fall back to the deterministic adapter when the
   * learned provider is unavailable. True by default: an unreachable third party
   * should degrade retrieval quality, not remove retrieval.
   */
  readonly fallbackToDeterministic: boolean;
}

export interface EmbedResult {
  ok: boolean;
  vectors: number[][];
  provider: string;
  model: string | null;
  dimensions: number;
  reason: KnowledgeReasonCode | null;
}

export interface EmbeddingHealth {
  provider: EmbeddingProviderId;
  available: boolean;
  latencyMs: number;
  lastErrorCode: KnowledgeReasonCode | null;
  checkedAt: Date;
}

export interface EmbeddingInitResult {
  ok: boolean;
  provider: EmbeddingProviderId;
  reason: KnowledgeReasonCode | null;
  detail?: string;
}

export interface EmbeddingAdapter {
  readonly id: EmbeddingProviderId;
  readonly provider: string;
  readonly model: string | null;
  readonly dimensions: number;
  readonly requiresEgress: boolean;
  readonly requiresCredentials: boolean;
  readonly deterministic: boolean;
  init(): Promise<EmbeddingInitResult>;
  embed(texts: string[]): Promise<EmbedResult>;
  health(): Promise<EmbeddingHealth>;
}

// ============================================================
// Ingestion and generation contracts
// ============================================================

export interface IngestionRequest {
  content: string;
  sourceUri: string;
  sourceType: KnowledgeSourceType;
  classification: KnowledgeClassification;
  sovereigntyTier: 1 | 2 | 3;
  ingestedBy: string;
  parentDocumentId?: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  tags?: string[];
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface IngestionOutcome {
  ok: boolean;
  /** HTTP status the router shall return; the pipeline decides, not the router. */
  httpStatus: 200 | 201 | 400 | 403 | 422 | 503;
  objectIds: string[];
  chunkTotal: number;
  duplicate: boolean;
  reason: KnowledgeReasonCode | null;
  detail?: string;
  degradationLevel: DegradationLevel;
  quarantined: boolean;
  vectorsWritten: number;
}

export interface RagOutcome {
  ok: boolean;
  httpStatus: 200 | 403 | 422 | 503;
  /** Composed prompt; generation itself is routed through R-Model Fabric. */
  composedPrompt: string | null;
  results: KnowledgeRetrievalResult[];
  citations: string[];
  strippedCitations: string[];
  complete: boolean;
  reason: KnowledgeReasonCode | null;
  degradationLevel: DegradationLevel;
}

export interface QuarantineRecord {
  quarantinedAt: string;
  reason: KnowledgeReasonCode;
  detectionRule: string | null;
  sourceUri: string;
  declaredClassification: KnowledgeClassification;
  /** Digest of the refused payload — never the payload itself. */
  payloadDigest: string;
  ingestedBy: string;
}

// ============================================================
// Plane configuration — resolved once, immutable thereafter
// ============================================================

export type KnowledgeEnvironmentClass = 'ci' | 'test' | 'development' | 'production';

export interface KnowledgeConfig {
  /** `process.env.KNOWLEDGE_ENABLED === 'true'` — strict, lowercase, exact. */
  readonly enabled: boolean;
  readonly environmentClass: KnowledgeEnvironmentClass;
  readonly vectorStore: VectorStoreId;
  readonly sqlitePath: string;
  readonly embeddingProvider: EmbeddingProviderId;
  readonly embeddingDimensions: number;
  readonly embeddingModel: string | null;
  readonly externalEgressAuthorised: boolean;
  readonly maxClassification: KnowledgeClassification;
  readonly chunkSizeTokens: number;
  readonly chunkOverlapTokens: number;
  readonly retrievalTopK: number;
  readonly minSimilarity: number;
  readonly ragEnabled: boolean;
  readonly ragMinSources: number;
  readonly quarantinePath: string;
  /** Qdrant adapter reference values — inert unless the adapter is selected. */
  readonly qdrant: QdrantAdapterConfig;
  /** OpenAI embedding configuration — inert unless the provider is selected. */
  readonly openai: OpenAIEmbeddingConfig;
}

/**
 * Qdrant adapter configuration. Recording these values fixes a protocol surface
 * for the adapter; it confers no authority to obtain, run, reach or operate a
 * server bearing them (Order Article 3.1).
 */
export interface QdrantAdapterConfig {
  readonly endpoint: string;
  readonly apiKeyPresent: boolean;
  readonly collection: string;
  readonly timeoutMs: number;
  readonly maxRetries: number;
  /**
   * Whether the adapter may CREATE a missing collection (MIP-015 STEP 3).
   *
   * Default DISABLED. A deployment that has not asked for provisioning refuses on
   * a missing collection exactly as it did under MIP-014, because silently
   * creating storage an operator did not ask for is how a typo in a collection
   * name becomes an empty corpus that appears to work.
   */
  readonly autoCreateCollection: boolean;
  /** Distance metric used when provisioning. Cosine matches L2-normalised vectors. */
  readonly distance: 'Cosine' | 'Dot' | 'Euclid';
  readonly environmentAuthorisationRef: string;
  readonly telemetryDisabled: boolean;
  readonly tlsRequired: true;
  readonly expectedServerVersion: string;
  readonly pinnedClientVersion: string;
  readonly pinnedImageDigest: string;
}

// ============================================================
// Plane health and diagnostics
// ============================================================

export interface KnowledgeDiagnostics {
  enabled: boolean;
  degradation: DegradationState;
  storeId: VectorStoreId;
  storeHealth: StoreHealth | null;
  embeddingProvider: EmbeddingProviderId;
  embeddingHealth: EmbeddingHealth | null;
  objectsIngested: number;
  objectsRefused: number;
  queriesServed: number;
  quarantineEvents: number;
  /** Egress attempts observed by the plane's own accounting. Expected: 0. */
  egressEvents: number;
  requestsTotal: number;
  errorsTotal: number;
}

// ============================================================
// Zod schemas at trust boundaries
// ============================================================

export const KnowledgeClassificationSchema = z.enum([
  'PUBLIC',
  'INTERNAL',
  'CONFIDENTIAL',
  'RESTRICTED',
]);

export const KnowledgeSourceTypeSchema = z.enum([
  'document',
  'dataset',
  'standard',
  'filing',
  'report',
  'synthetic',
]);

export const IngestionRequestSchema = z
  .object({
    content: z.string().min(1, 'content must be non-empty'),
    sourceUri: z
      .string()
      .min(1)
      .regex(/^(file|https|internal):/, 'sourceUri must be scheme-qualified'),
    sourceType: KnowledgeSourceTypeSchema,
    classification: KnowledgeClassificationSchema,
    sovereigntyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    ingestedBy: z.string().min(1),
    parentDocumentId: z.string().min(1).optional(),
    title: z.string().optional(),
    author: z.string().optional(),
    publishedAt: z.string().optional(),
    language: z.string().optional(),
    tags: z.array(z.string()).optional(),
    expiresAt: z.string().optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict();

export const KnowledgeQuerySchema = z
  .object({
    query: z.string().min(1),
    k: z.coerce.number().int().positive().max(100).optional(),
    maxClassification: KnowledgeClassificationSchema.optional(),
    parentDocumentId: z.string().min(1).optional(),
    sourceType: KnowledgeSourceTypeSchema.optional(),
  })
  .strict();

export type KnowledgeQuery = z.infer<typeof KnowledgeQuerySchema>;
