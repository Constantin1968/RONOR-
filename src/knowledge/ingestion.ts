/**
 * Ingestion Pipeline — eleven ordered stages
 * MIP-014 STEP 2 · Phase 4 (Pipelines) · STEP 1 § 8.1
 *
 *   I-1   Request validation                 strict schema, unknown keys rejected
 *   I-2   Size and rate bounds               bounded ingress
 *   I-3   Classification ceiling             BEFORE any write, hash or embedding
 *   I-4   Injection screening                BEFORE normalisation and chunking
 *   I-5   Normalisation                      deterministic, hash-stable
 *   I-6   Chunking                           deterministic, gapless cover
 *   I-7   Content hashing                    SHA-256 per chunk
 *   I-8   Duplicate detection                by content hash
 *   I-9   Embedding                          or level-1 degradation
 *   I-10  Object construction                sole constructor; completeness computed
 *   I-11  Persistence                        atomic per batch, partial reported
 *
 * The ORDER carries the governance, and two positions are load-bearing.
 *
 * Stage I-3 precedes every write, every hash and every embedding call. An
 * over-classified payload is therefore refused before it has been digested,
 * before it has been chunked and, decisively, before any text has been passed to
 * an embedding provider. Screening after embedding would already have transmitted
 * the material if the provider were remote — the refusal would be theatre.
 *
 * Stage I-4 precedes normalisation. Screening normalised text screens text the
 * pipeline has already altered, and an author who knows the normalisation rules
 * could construct input whose hostile form survives only past the screen.
 */

import { chunkText, isGaplessCover, normaliseText } from './chunker';
import { buildQuarantineRecord, screenForInjection } from './injection-guard';
import { constructKnowledgeObject, deriveParentDocumentId } from './provenance';
import { computeContentHash } from './schema';
import { CLASSIFICATION_RANK, IngestionRequestSchema } from '../planes/r-knowledge/types';
import type {
  DegradationState,
  EmbeddingAdapter,
  IngestionOutcome,
  IngestionRequest,
  KnowledgeConfig,
  KnowledgeObject,
  QuarantineRecord,
  VectorStore,
} from '../planes/r-knowledge/types';

/** Maximum admitted payload, in characters. Bounded ingress at stage I-2. */
export const MAX_INGESTION_CHARACTERS = 1_000_000;

export interface IngestionContext {
  config: KnowledgeConfig;
  store: VectorStore;
  embedder: EmbeddingAdapter;
  degradation: DegradationState;
  /** Injected so that ingestion is testable without a clock. */
  now: () => Date;
  /** Sink for quarantine records. Receives a digest, never a payload. */
  onQuarantine?: (record: QuarantineRecord) => void;
}

export interface IngestionStageTrace {
  stage: string;
  passed: boolean;
  detail?: string;
}

export interface IngestionResult extends IngestionOutcome {
  /** Ordered record of the stages executed, for evidence and diagnosis. */
  trace: IngestionStageTrace[];
  quarantineRecord: QuarantineRecord | null;
}

/**
 * Execute the pipeline.
 *
 * Every refusal returns an `IngestionResult` carrying the HTTP status the router
 * must return. The pipeline decides the status, not the router: a router that
 * inferred status from an error shape would drift from the pipeline's intent, and
 * the mapping from governance outcome to status is a governance decision.
 */
export async function ingest(
  raw: unknown,
  context: IngestionContext
): Promise<IngestionResult> {
  const trace: IngestionStageTrace[] = [];
  const nowIso = toOffsetIso(context.now());

  const refuse = (
    stage: string,
    httpStatus: IngestionOutcome['httpStatus'],
    reason: IngestionOutcome['reason'],
    detail: string,
    extras: Partial<IngestionResult> = {}
  ): IngestionResult => {
    trace.push({ stage, passed: false, detail });
    return {
      ok: false,
      httpStatus,
      objectIds: [],
      chunkTotal: 0,
      duplicate: false,
      reason,
      detail,
      degradationLevel: context.degradation.level,
      quarantined: false,
      vectorsWritten: 0,
      trace,
      quarantineRecord: null,
      ...extras,
    };
  };

  // ---------- I-1 Request validation ----------
  const parsed = IngestionRequestSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return refuse(
      'I-1',
      400,
      'ADMISSION_MALFORMED',
      `${issue.path.join('.') || '(root)'}: ${issue.message}`
    );
  }
  const request: IngestionRequest = parsed.data;
  trace.push({ stage: 'I-1', passed: true });

  // ---------- I-2 Size and rate bounds ----------
  if (request.content.length > MAX_INGESTION_CHARACTERS) {
    return refuse(
      'I-2',
      422,
      'ADMISSION_TOO_LARGE',
      `content length ${request.content.length} exceeds the bound ${MAX_INGESTION_CHARACTERS}`
    );
  }
  trace.push({ stage: 'I-2', passed: true });

  // ---------- I-3 Classification ceiling ----------
  // Positioned before hashing, chunking, embedding and persistence. Nothing has
  // been digested and nothing has been transmitted at the point of refusal.
  if (
    CLASSIFICATION_RANK[request.classification] >
    CLASSIFICATION_RANK[context.config.maxClassification]
  ) {
    const record = buildQuarantineRecord({
      raw: request.content,
      sourceUri: request.sourceUri,
      declaredClassification: request.classification,
      ingestedBy: request.ingestedBy,
      reason: 'CLASSIFICATION_CEILING_EXCEEDED',
      detectionRule: null,
      quarantinedAt: nowIso,
    });
    context.onQuarantine?.(record);
    return refuse(
      'I-3',
      403,
      'CLASSIFICATION_CEILING_EXCEEDED',
      `declared classification ${request.classification} exceeds the plane ceiling ${context.config.maxClassification}`,
      { quarantined: true, quarantineRecord: record }
    );
  }
  trace.push({ stage: 'I-3', passed: true });

  // ---------- I-4 Injection screening ----------
  // Applied to the RAW content, before normalisation removes the very characters
  // rule IG-12 exists to detect.
  const screening = screenForInjection(request.content);
  if (!screening.clean) {
    const record = buildQuarantineRecord({
      raw: request.content,
      sourceUri: request.sourceUri,
      declaredClassification: request.classification,
      ingestedBy: request.ingestedBy,
      reason: 'INJECTION_DETECTED',
      detectionRule: screening.ruleId,
      quarantinedAt: nowIso,
    });
    context.onQuarantine?.(record);
    return refuse(
      'I-4',
      422,
      'INJECTION_DETECTED',
      `injection screening matched ${screening.allMatches.join(', ')}: ${screening.ruleDescription}`,
      { quarantined: true, quarantineRecord: record }
    );
  }
  trace.push({ stage: 'I-4', passed: true });

  // ---------- I-5 Normalisation ----------
  // `normaliseText` is a total function: it cannot fail, because every input has a
  // normal form. What it CAN do is normalise the content away entirely — a payload
  // consisting only of zero-width characters normalises to the empty string — and
  // that outcome must be refused rather than ingested as an empty object.
  const normalised = normaliseText(request.content);
  if (normalised.text.length === 0) {
    return refuse(
      'I-5',
      422,
      'NORMALISATION_FAILED',
      `content normalised to the empty string; ${normalised.charactersRemoved} invisible or ` +
        'control character(s) were removed and no substantive text remained'
    );
  }
  trace.push({
    stage: 'I-5',
    passed: true,
    detail: normalised.altered
      ? `normalisation removed ${normalised.charactersRemoved} character(s)`
      : undefined,
  });

  // ---------- I-6 Chunking ----------
  const chunking = chunkText(request.content, {
    chunkSizeTokens: context.config.chunkSizeTokens,
    chunkOverlapTokens: context.config.chunkOverlapTokens,
  });
  if (!chunking.ok || chunking.chunks.length === 0) {
    return refuse('I-6', 422, 'NORMALISATION_FAILED', chunking.detail ?? 'chunking produced no chunks');
  }
  if (!isGaplessCover(chunking.chunks)) {
    // K-INV-5. A gap means some part of the document would be unretrievable while
    // appearing to have been ingested — a silent partial ingestion, which is worse
    // than a refusal because nothing signals it.
    return refuse('I-6', 422, 'SCHEMA_INVALID', 'chunk set does not form a gapless cover (K-INV-5)');
  }
  trace.push({ stage: 'I-6', passed: true, detail: `${chunking.chunks.length} chunk(s)` });

  // ---------- I-7 Content hashing ----------
  //
  // `computeContentHash` from the schema module is used, NOT a local SHA-256 call.
  // That module states the digest law once:
  //
  //     contentHash = SHA256(canonicalStringify(normalisedContent))
  //
  // A local `createHash('sha256').update(text)` omits the canonical-stringify step
  // and therefore produces a DIFFERENT digest for the same content. Duplicate
  // detection built on such a probe would never match a stored object, and the
  // symptom would be silent: every re-admission would create a fresh copy and the
  // corpus would accumulate duplicates that nothing reported. The single exported
  // function exists precisely so that a second, divergent implementation cannot
  // arise, and this pipeline must use it rather than reimplement it.
  const documentDigest = computeContentHash(normalised.text);
  trace.push({ stage: 'I-7', passed: true });

  // ---------- I-8 Duplicate detection ----------
  const firstChunkHash = computeContentHash(chunking.chunks[0].text);
  const existing = await context.store.getByHash(firstChunkHash);
  if (existing !== null) {
    trace.push({ stage: 'I-8', passed: true, detail: 'duplicate' });
    return {
      ok: true,
      // 200 rather than 201: idempotent re-admission is a success that created
      // nothing, and the distinction is observable to the caller.
      httpStatus: 200,
      objectIds: [existing.objectId],
      chunkTotal: existing.chunkTotal,
      duplicate: true,
      reason: 'DUPLICATE_OBJECT',
      detail: 'an object with this content hash is already held',
      degradationLevel: context.degradation.level,
      quarantined: false,
      vectorsWritten: 0,
      trace,
      quarantineRecord: null,
    };
  }
  trace.push({ stage: 'I-8', passed: true });

  // ---------- I-9 Embedding ----------
  const texts = chunking.chunks.map((c) => c.text);
  const embedded = await context.embedder.embed(texts);
  let vectors: number[][] | null = null;
  let embeddingDegraded = false;

  if (embedded.ok) {
    if (embedded.dimensions !== context.config.embeddingDimensions) {
      // Refused, never coerced. A silently truncated or padded vector is a
      // corpus-wide reproducibility failure that surfaces much later as poor
      // retrieval, at which point its cause is untraceable.
      return refuse(
        'I-9',
        422,
        'EMBEDDING_DIMENSION_MISMATCH',
        `adapter produced ${embedded.dimensions} dimensions; the configured dimensionality is ${context.config.embeddingDimensions}`
      );
    }
    vectors = embedded.vectors;
  } else {
    // Level-1 degradation: ingestion continues, objects are stored without
    // vectors and are flagged by the absence of a vector hash binding. Refusing
    // ingestion outright would lose the document; storing it unembedded preserves
    // it for re-embedding when the provider returns.
    embeddingDegraded = true;
    trace.push({
      stage: 'I-9',
      passed: true,
      detail: `embedding unavailable (${embedded.reason}); proceeding at degradation level 1`,
    });
  }
  if (!embeddingDegraded) trace.push({ stage: 'I-9', passed: true });

  // ---------- I-10 Object construction ----------
  const parentDocumentId = request.parentDocumentId ?? deriveParentDocumentId(request.sourceUri);
  const objects: KnowledgeObject[] = [];
  const vectorMap = new Map<string, number[]>();

  for (let i = 0; i < chunking.chunks.length; i++) {
    const built = constructKnowledgeObject({
      chunk: chunking.chunks[i],
      sourceUri: request.sourceUri,
      sourceType: request.sourceType,
      classification: request.classification,
      sovereigntyTier: request.sovereigntyTier,
      ingestedBy: request.ingestedBy,
      parentDocumentId,
      embeddingProvider: context.embedder.provider,
      embeddingModel: context.embedder.model,
      embeddingDimensions: context.config.embeddingDimensions,
      vector: vectors === null ? null : vectors[i],
      retrievalPath: `ingestion/${context.embedder.provider}`,
      // One instant shared by every chunk of one document, so that chunk
      // ordering is not confounded by sub-millisecond timing.
      ingestedAt: nowIso,
      title: request.title,
      author: request.author,
      publishedAt: request.publishedAt,
      language: request.language,
      tags: request.tags,
      expiresAt: request.expiresAt,
      metadata: request.metadata,
    });

    if (!built.ok || built.object === null) {
      return refuse(
        'I-10',
        422,
        built.reason ?? 'SCHEMA_INVALID',
        `chunk ${i}: ${built.detail ?? 'object construction failed'}${
          built.violations.length > 0 ? ` [${built.violations.join('; ')}]` : ''
        }`
      );
    }
    objects.push(built.object);
    if (vectors !== null) vectorMap.set(built.object.objectId, vectors[i]);
  }
  trace.push({ stage: 'I-10', passed: true, detail: `${objects.length} object(s)` });

  // ---------- I-11 Persistence ----------
  if (context.degradation.level >= 2) {
    // Store degraded or plane unavailable: ingestion is refused with 503 because
    // the condition is transient and recovery is automatic. The caller is being
    // asked to retry, not told the request was wrong.
    return refuse(
      'I-11',
      503,
      context.degradation.reason ?? 'STORE_UNAVAILABLE',
      `ingestion refused at degradation level ${context.degradation.level}`
    );
  }

  const upserted = await context.store.upsert(objects, vectorMap);
  if (!upserted.ok) {
    const firstFailure = upserted.failures[0];
    const reason = firstFailure?.reason ?? 'STORE_WRITE_REFUSED';
    // A classification refusal by the store is a governance outcome and carries
    // 403; a transport or write failure is transient and carries 503.
    const httpStatus = reason === 'STORE_CLASSIFICATION_REFUSED' ? 403 : 503;
    return refuse(
      'I-11',
      httpStatus,
      reason,
      `persistence reported ${upserted.written} of ${upserted.requested} written; ` +
        `first failure: ${firstFailure?.detail ?? reason}`
    );
  }
  trace.push({ stage: 'I-11', passed: true, detail: `${upserted.written} written` });

  return {
    ok: true,
    httpStatus: 201,
    objectIds: objects.map((o) => o.objectId),
    chunkTotal: objects.length,
    duplicate: false,
    reason: null,
    degradationLevel: embeddingDegraded ? 1 : context.degradation.level,
    quarantined: false,
    vectorsWritten: vectorMap.size,
    trace,
    quarantineRecord: null,
    detail: documentDigest,
  };
}

/**
 * ISO 8601 with an explicit UTC offset, as the Knowledge Object contract requires.
 * A bare `Z`-less local timestamp is ambiguous across hosts and would make
 * ingestion order unreconstructable after a timezone change.
 */
export function toOffsetIso(date: Date): string {
  return date.toISOString().replace(/Z$/, '+00:00');
}
