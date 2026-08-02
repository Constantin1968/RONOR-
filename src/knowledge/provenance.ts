/**
 * Provenance — object construction, integrity verification and citation binding
 * MIP-014 STEP 2 · Phase 2 (Deterministic Core)
 *
 * This module is the sole constructor of Knowledge Objects. Centralising
 * construction is what makes K-INV-6 enforceable: provenance completeness is
 * computed here from the object's own state, so a caller-supplied completeness
 * value has no code path by which it could be honoured.
 *
 * Integrity is verified twice — once when an object is built, and again when one
 * is read back from a store (K-INV-2). The second verification is the one that
 * matters, because it is the only control that detects mutation of a store's
 * contents by any means outside the plane.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  computeContentHash,
  computeProvenanceCompleteness,
  computeVectorHash,
  isProvenanceComplete,
  validateKnowledgeObject,
} from './schema';
import { KNOWLEDGE_SCHEMA_VERSION } from '../planes/r-knowledge/types';
import type {
  KnowledgeObject,
  KnowledgeReasonCode,
  KnowledgeRetrievalResult,
} from '../planes/r-knowledge/types';
import type { Chunk } from './chunker';

// ------------------------------------------------------------
// Construction
// ------------------------------------------------------------

export interface ObjectConstructionInput {
  chunk: Chunk;
  sourceUri: string;
  sourceType: KnowledgeObject['sourceType'];
  classification: KnowledgeObject['classification'];
  sovereigntyTier: 1 | 2 | 3;
  ingestedBy: string;
  parentDocumentId: string;
  embeddingProvider: string;
  embeddingModel: string | null;
  embeddingDimensions: number;
  /** Absent when the plane is at degradation level 1 and stores without vectors. */
  vector: readonly number[] | null;
  retrievalPath: string;
  /** Supplied so that all chunks of one document share an ingestion instant. */
  ingestedAt: string;
  title?: string;
  author?: string;
  publishedAt?: string;
  language?: string;
  tags?: string[];
  expiresAt?: string;
  metadata?: Record<string, unknown>;
}

export interface ObjectConstructionResult {
  ok: boolean;
  object: KnowledgeObject | null;
  reason: KnowledgeReasonCode | null;
  detail?: string;
  violations: string[];
}

/**
 * Derive a stable, human-legible citation label from the parent document
 * identifier and the chunk position. Deterministic, so the same chunk always
 * carries the same label and a citation can be re-derived rather than stored.
 */
export function deriveCitationLabel(parentDocumentId: string, chunkIndex: number): string {
  const stem = parentDocumentId
    .replace(/^[a-z]+:/i, '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase()
    .slice(0, 48);
  const base = stem.length > 0 ? stem : 'DOC';
  return `${base}-C${String(chunkIndex + 1).padStart(3, '0')}`;
}

/**
 * Derive a stable parent document identifier from a source URI. Content-derived
 * rather than random, so that re-ingesting the same source yields the same
 * parent identifier and duplicate detection at I-8 can function.
 */
export function deriveParentDocumentId(sourceUri: string): string {
  return `doc-${computeContentHash(sourceUri).slice(0, 32)}`;
}

/**
 * Construct a single Knowledge Object from a chunk.
 *
 * The ordering of operations is the enforcement mechanism. The content digest is
 * computed from the chunk text before anything else, so the digest is of the
 * content that will actually be stored. The vector digest binds the vector to the
 * object. Completeness is computed last, from the assembled state. The object is
 * then validated against the full schema and the invariants, so that no object
 * can leave this function in a state the schema would reject.
 */
export function constructKnowledgeObject(
  input: ObjectConstructionInput
): ObjectConstructionResult {
  const content = input.chunk.text;
  if (content.length === 0) {
    return {
      ok: false,
      object: null,
      reason: 'NORMALISATION_FAILED',
      detail: 'chunk is empty after normalisation',
      violations: [],
    };
  }

  const contentHash = computeContentHash(content);

  // A level-1 (embedding-degraded) ingestion stores the object without a vector.
  // The embedding reference still exists and still carries a digest, computed
  // over the empty vector, so that the object remains schema-valid and is
  // identifiable as awaiting re-embedding rather than as malformed.
  const vector = input.vector ?? [];
  const vectorHash = computeVectorHash(vector);

  const citationLabel = deriveCitationLabel(input.parentDocumentId, input.chunk.index);

  const draft = {
    objectId: uuidv4(),
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    contentHash,
    content,
    sourceUri: input.sourceUri,
    sourceType: input.sourceType,
    classification: input.classification,
    sovereigntyTier: input.sovereigntyTier,
    ingestedAt: input.ingestedAt,
    ingestedBy: input.ingestedBy,
    chunkIndex: input.chunk.index,
    chunkTotal: input.chunk.total,
    embeddingRef: {
      provider: input.embeddingProvider,
      model: input.embeddingModel,
      dimensions: input.embeddingDimensions,
      vectorHash,
    },
    provenance: {
      parentDocumentId: input.parentDocumentId,
      retrievalPath: input.retrievalPath,
      citationLabel,
      // Placeholder. Replaced below by the computed value; never read from a
      // caller (K-INV-6).
      completeness: 0,
    },
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.author !== undefined ? { author: input.author } : {}),
    ...(input.publishedAt !== undefined ? { publishedAt: input.publishedAt } : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.tags !== undefined ? { tags: input.tags } : {}),
    ...(input.expiresAt !== undefined ? { expiresAt: input.expiresAt } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
  };

  const completeness = computeProvenanceCompleteness({
    ...draft,
    provenance: {
      parentDocumentId: draft.provenance.parentDocumentId,
      retrievalPath: draft.provenance.retrievalPath,
      citationLabel: draft.provenance.citationLabel,
    },
  } as never);

  const candidate = {
    ...draft,
    provenance: { ...draft.provenance, completeness },
  };

  const validation = validateKnowledgeObject(candidate, {
    activeDimensions: input.embeddingDimensions,
  });

  if (!validation.ok || validation.object === null) {
    return {
      ok: false,
      object: null,
      reason: validation.reason,
      detail: validation.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      violations: validation.violations,
    };
  }

  return { ok: true, object: validation.object, reason: null, violations: validation.violations };
}

// ------------------------------------------------------------
// Read-time integrity verification — K-INV-2, second application
// ------------------------------------------------------------

export interface IntegrityVerdict {
  ok: boolean;
  objectId: string;
  reason: KnowledgeReasonCode | null;
  detail?: string;
}

/**
 * Verify an object read back from a store.
 *
 * A failure here means the stored bytes no longer match their digest. The object
 * is excluded from retrieval rather than returned with a warning, because a
 * warning attached to unverified content invites a consumer to use it anyway
 * (RK-012).
 */
export function verifyObjectIntegrity(object: KnowledgeObject): IntegrityVerdict {
  const recomputed = computeContentHash(object.content);
  if (recomputed !== object.contentHash) {
    return {
      ok: false,
      objectId: object.objectId,
      reason: 'INTEGRITY_FAILED',
      detail: 'stored content does not match its recorded digest',
    };
  }
  if (!isProvenanceComplete(object)) {
    return {
      ok: false,
      objectId: object.objectId,
      reason: 'SCHEMA_INVALID',
      detail: 'stored object is not provenance-complete',
    };
  }
  return { ok: true, objectId: object.objectId, reason: null };
}

/**
 * Verify a vector read back from a store against the digest recorded on its
 * object. This detects a vector having been replaced independently of its
 * content — a failure mode that content hashing alone cannot see.
 */
export function verifyVectorBinding(
  object: KnowledgeObject,
  vector: readonly number[] | null
): IntegrityVerdict {
  const recomputed = computeVectorHash(vector ?? []);
  if (recomputed !== object.embeddingRef.vectorHash) {
    return {
      ok: false,
      objectId: object.objectId,
      reason: 'INTEGRITY_FAILED',
      detail: 'stored vector does not match the digest recorded on the object',
    };
  }
  return { ok: true, objectId: object.objectId, reason: null };
}

// ------------------------------------------------------------
// Retrieval result assembly — citation binding
// ------------------------------------------------------------

export interface ResultAssemblyInput {
  object: KnowledgeObject;
  score: number;
  rank: number;
  storeId: string;
  embeddingProvider: string;
  degraded: boolean;
  retrievedAt: string;
}

/**
 * Assemble a retrieval result, binding a citation to the object that supports it
 * (G-5). The citation is derived from the object's own provenance, so a citation
 * cannot exist without an object, which is what makes citation forgery
 * detectable at verification time.
 */
export function assembleRetrievalResult(input: ResultAssemblyInput): KnowledgeRetrievalResult {
  const { object } = input;
  return {
    object,
    score: input.score,
    rank: input.rank,
    citation: `[${object.provenance.citationLabel}]`,
    provenanceComplete: isProvenanceComplete(object),
    retrievedAt: input.retrievedAt,
    storeId: input.storeId,
    embeddingProvider: input.embeddingProvider,
    degraded: input.degraded,
  };
}

/**
 * Resolve the citation tokens appearing in generated output against the
 * retrieval set (G-7).
 *
 * A token that resolves to no retrieved object is unresolvable and must be
 * stripped, and the response marked incomplete. The function reports both sets
 * so that the caller can act on them; it does not decide policy.
 */
export function resolveCitations(
  output: string,
  results: readonly KnowledgeRetrievalResult[]
): { resolved: string[]; unresolvable: string[] } {
  const available = new Set(results.map((r) => r.object.provenance.citationLabel));
  const tokens = output.match(/\[([A-Z0-9][A-Z0-9-]{0,63})\]/g) ?? [];

  const resolved: string[] = [];
  const unresolvable: string[] = [];
  const seen = new Set<string>();

  for (const token of tokens) {
    const label = token.slice(1, -1);
    if (seen.has(label)) continue;
    seen.add(label);
    if (available.has(label)) resolved.push(label);
    else unresolvable.push(label);
  }

  return { resolved, unresolvable };
}
