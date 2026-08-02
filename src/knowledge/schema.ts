/**
 * Knowledge Object Schema — v1.0
 * MIP-014 STEP 2 · Phase 1 (Contract Foundations)
 *
 * The schema is strict in the governance sense as well as the zod sense:
 * unknown top-level keys are REJECTED, not stripped (K-INV-7), so that a
 * producer cannot smuggle unvalidated metadata into the corpus. A retrieval
 * result lacking any mandatory field is not a degraded result; it is a contract
 * violation and is refused before it reaches a consumer (STEP 1 § 7.1).
 *
 * This module validates. It performs no input or output, opens no store and
 * reads no configuration beyond what a caller passes to it.
 */

import { createHash } from 'crypto';
import { z } from 'zod';
import {
  CLASSIFICATION_RANK,
  KNOWLEDGE_SCHEMA_VERSION,
  KnowledgeClassificationSchema,
  KnowledgeSourceTypeSchema,
  MANDATORY_KNOWLEDGE_FIELDS,
} from '../planes/r-knowledge/types';
import type {
  KnowledgeClassification,
  KnowledgeObject,
  KnowledgeReasonCode,
} from '../planes/r-knowledge/types';

// ============================================================
// Primitive field schemas
// ============================================================

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/;
const ISO8601_WITH_OFFSET =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export const EmbeddingRefSchema = z
  .object({
    provider: z.string().min(1, 'embeddingRef.provider must be non-empty'),
    // Nullable by contract. This is the type-level expression of vendor
    // independence: no vendor model string can become an implicit default.
    model: z.string().min(1).nullable(),
    dimensions: z.number().int().positive('embeddingRef.dimensions must be a positive integer'),
    vectorHash: z.string().regex(SHA256_HEX, 'embeddingRef.vectorHash must be 64 lowercase hex characters'),
  })
  .strict();

export const KnowledgeProvenanceSchema = z
  .object({
    parentDocumentId: z.string().min(1, 'provenance.parentDocumentId must be non-empty'),
    retrievalPath: z.string().min(1, 'provenance.retrievalPath must be non-empty'),
    citationLabel: z.string().min(1, 'provenance.citationLabel must be non-empty'),
    completeness: z.number().min(0).max(1),
  })
  .strict();

/**
 * The Knowledge Object schema. `.strict()` is load-bearing: it is the mechanism
 * of K-INV-7.
 */
export const KnowledgeObjectSchema = z
  .object({
    objectId: z.string().regex(UUID_V4, 'objectId must be a UUID v4'),
    schemaVersion: z.literal(KNOWLEDGE_SCHEMA_VERSION),
    contentHash: z.string().regex(SHA256_HEX, 'contentHash must be 64 lowercase hex characters'),
    content: z.string().min(1, 'content must be non-empty'),
    sourceUri: z
      .string()
      .min(1)
      .regex(/^(file|https|internal):/, 'sourceUri must be scheme-qualified (file:, https:, internal:)'),
    sourceType: KnowledgeSourceTypeSchema,
    classification: KnowledgeClassificationSchema,
    sovereigntyTier: z.union([z.literal(1), z.literal(2), z.literal(3)]),
    ingestedAt: z.string().regex(ISO8601_WITH_OFFSET, 'ingestedAt must be ISO-8601 with a timezone offset'),
    ingestedBy: z.string().min(1, 'ingestedBy must be non-empty'),
    chunkIndex: z.number().int().min(0, 'chunkIndex must be >= 0'),
    chunkTotal: z.number().int().min(1, 'chunkTotal must be >= 1'),
    embeddingRef: EmbeddingRefSchema,
    provenance: KnowledgeProvenanceSchema,

    title: z.string().optional(),
    author: z.string().optional(),
    publishedAt: z.string().regex(ISO8601_WITH_OFFSET).optional(),
    language: z.string().min(2).optional(),
    tags: z.array(z.string()).max(64).optional(),
    expiresAt: z.string().regex(ISO8601_WITH_OFFSET).optional(),
    metadata: z.record(z.unknown()).optional(),
  })
  .strict()
  .superRefine((obj, ctx) => {
    if (obj.chunkIndex >= obj.chunkTotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['chunkIndex'],
        message: 'chunkIndex must be strictly less than chunkTotal',
      });
    }
  });

// ============================================================
// Canonicalisation and hashing
// ============================================================

/**
 * Recursive key-sorted, whitespace-free serialisation. The discipline mirrors
 * the audit chain's `canonicalStringify` so that a reviewer familiar with
 * `src/audit/hash-chain.ts` reads one convention rather than two.
 *
 * This is a deliberate re-implementation, not an import. R-Knowledge holds no
 * handle on the audit module and introduces no coupling to the programme's
 * integrity root (ADR-K01 Revision 3, decision items 5 and 7).
 */
export function canonicalStringify(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'undefined') return 'null';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalStringify(item, seen)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj)) return '"[Circular]"';
    seen.add(obj);
    const keys = Object.keys(obj).sort();
    const parts = keys
      .filter((key) => typeof obj[key] !== 'function')
      .map((key) => `${JSON.stringify(key)}:${canonicalStringify(obj[key], seen)}`);
    return `{${parts.join(',')}}`;
  }
  return 'null';
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * The content digest law of the plane:
 *
 *     contentHash = SHA256(canonicalStringify(normalisedContent))
 *
 * Stated as a single exported function so that no second, divergent
 * implementation can arise.
 */
export function computeContentHash(normalisedContent: string): string {
  return sha256Hex(canonicalStringify(normalisedContent));
}

/** The vector digest law, binding a vector to the object that carries it. */
export function computeVectorHash(vector: readonly number[]): string {
  return sha256Hex(canonicalStringify(Array.from(vector)));
}

// ============================================================
// Validation outcomes
// ============================================================

export interface FieldError {
  path: string;
  message: string;
}

export interface ValidationOutcome {
  ok: boolean;
  reason: KnowledgeReasonCode | null;
  errors: FieldError[];
  /** Invariant identifiers violated, e.g. ['K-INV-2']. */
  violations: string[];
  object: KnowledgeObject | null;
}

function toFieldErrors(error: z.ZodError): FieldError[] {
  return error.issues.map((issue) => ({
    path: issue.path.length > 0 ? issue.path.join('.') : '<root>',
    message: issue.message,
  }));
}

// ============================================================
// The seven invariants — K-INV-1 to K-INV-7
// ============================================================

export interface InvariantContext {
  /** Active adapter dimensionality; K-INV-4 is skipped when not supplied. */
  activeDimensions?: number;
  /** Configured ceiling; K-INV-3 is skipped when not supplied. */
  maxClassification?: KnowledgeClassification;
  /** Sibling chunk indices of the same parent document, for K-INV-5. */
  siblingChunkIndices?: readonly number[];
}

/**
 * Validate a candidate object against the schema and against the invariants.
 *
 * The ordering is deliberate. Schema structure is checked first, because an
 * object missing a mandatory field cannot meaningfully be tested for integrity.
 * K-INV-2 is then checked before any classification or dimension test, because
 * a tampered object must be identified as tampered rather than as
 * over-classified.
 */
export function validateKnowledgeObject(
  candidate: unknown,
  context: InvariantContext = {}
): ValidationOutcome {
  const parsed = KnowledgeObjectSchema.safeParse(candidate);
  if (!parsed.success) {
    const errors = toFieldErrors(parsed.error);
    const violations = new Set<string>();
    for (const err of errors) {
      const top = err.path.split('.')[0];
      if (err.message.includes('Unrecognized key')) violations.add('K-INV-7');
      else if (MANDATORY_KNOWLEDGE_FIELDS.includes(top)) violations.add('K-INV-1');
    }
    // A zod "Unrecognized key(s)" issue is reported at the root path.
    if (errors.some((e) => /unrecognized key/i.test(e.message))) violations.add('K-INV-7');
    return {
      ok: false,
      reason: 'SCHEMA_INVALID',
      errors,
      violations: Array.from(violations),
      object: null,
    };
  }

  const object = parsed.data as KnowledgeObject;
  const errors: FieldError[] = [];
  const violations: string[] = [];

  // K-INV-2 — content integrity, verified at write time and at read time.
  const recomputed = computeContentHash(object.content);
  if (recomputed !== object.contentHash) {
    violations.push('K-INV-2');
    errors.push({
      path: 'contentHash',
      message: 'contentHash does not equal the recomputed digest of the canonical normalised content',
    });
    return { ok: false, reason: 'INTEGRITY_FAILED', errors, violations, object: null };
  }

  // K-INV-3 — classification ceiling. No redirection to any alternative store.
  if (context.maxClassification) {
    if (CLASSIFICATION_RANK[object.classification] > CLASSIFICATION_RANK[context.maxClassification]) {
      violations.push('K-INV-3');
      errors.push({
        path: 'classification',
        message: `classification ${object.classification} exceeds the configured ceiling ${context.maxClassification}`,
      });
      return {
        ok: false,
        reason: 'CLASSIFICATION_CEILING_EXCEEDED',
        errors,
        violations,
        object: null,
      };
    }
  }

  // K-INV-4 — dimensional agreement. No vector of the wrong dimension may enter.
  if (typeof context.activeDimensions === 'number') {
    if (object.embeddingRef.dimensions !== context.activeDimensions) {
      violations.push('K-INV-4');
      errors.push({
        path: 'embeddingRef.dimensions',
        message: `embeddingRef.dimensions ${object.embeddingRef.dimensions} does not equal the active adapter dimensionality ${context.activeDimensions}`,
      });
      return {
        ok: false,
        reason: 'EMBEDDING_DIMENSION_MISMATCH',
        errors,
        violations,
        object: null,
      };
    }
  }

  // K-INV-5 — gapless chunk cover. A gap does not reject the object; it reduces
  // the parent document's completeness, which is what the contract requires.
  if (context.siblingChunkIndices && context.siblingChunkIndices.length > 0) {
    const cover = new Set<number>(context.siblingChunkIndices);
    cover.add(object.chunkIndex);
    let gapless = cover.size === object.chunkTotal;
    for (let i = 0; i < object.chunkTotal && gapless; i++) {
      if (!cover.has(i)) gapless = false;
    }
    if (!gapless) violations.push('K-INV-5');
  }

  return { ok: true, reason: null, errors: [], violations, object };
}

// ============================================================
// K-INV-6 — completeness is computed, never supplied
// ============================================================

/**
 * Compute provenance completeness. The value is a pure function of the object's
 * own state, so a caller-supplied value is not merely ignored — there is no code
 * path by which it could be honoured.
 */
export function computeProvenanceCompleteness(
  object: Omit<KnowledgeObject, 'provenance'> & { provenance: Omit<KnowledgeProvenanceInput, 'completeness'> }
): number {
  const mandatoryPresent = MANDATORY_KNOWLEDGE_FIELDS.filter((field) => {
    if (field === 'provenance') {
      const p = object.provenance;
      return (
        typeof p?.parentDocumentId === 'string' &&
        p.parentDocumentId.length > 0 &&
        typeof p?.retrievalPath === 'string' &&
        p.retrievalPath.length > 0 &&
        typeof p?.citationLabel === 'string' &&
        p.citationLabel.length > 0
      );
    }
    if (field === 'embeddingRef') {
      const e = (object as { embeddingRef?: { provider?: string; dimensions?: number; vectorHash?: string } })
        .embeddingRef;
      return (
        typeof e?.provider === 'string' &&
        e.provider.length > 0 &&
        typeof e?.dimensions === 'number' &&
        typeof e?.vectorHash === 'string' &&
        SHA256_HEX.test(e.vectorHash)
      );
    }
    const value = (object as unknown as Record<string, unknown>)[field];
    return value !== undefined && value !== null && value !== '';
  }).length;

  const integrityHolds =
    typeof object.content === 'string' &&
    typeof object.contentHash === 'string' &&
    computeContentHash(object.content) === object.contentHash;

  const fieldScore = mandatoryPresent / MANDATORY_KNOWLEDGE_FIELDS.length;
  // Integrity is a necessary condition for completeness. An object whose digest
  // does not verify is not "almost complete"; it is not provenance-complete.
  return integrityHolds ? Number(fieldScore.toFixed(6)) : 0;
}

export interface KnowledgeProvenanceInput {
  parentDocumentId: string;
  retrievalPath: string;
  citationLabel: string;
  completeness: number;
}

/**
 * Whether an object is provenance-complete: all fourteen mandatory fields
 * present and K-INV-2 holding (STEP 1 § 7.5).
 */
export function isProvenanceComplete(object: KnowledgeObject): boolean {
  const schemaOk = KnowledgeObjectSchema.safeParse(object).success;
  if (!schemaOk) return false;
  return computeContentHash(object.content) === object.contentHash;
}

/**
 * Render a citation from an object's own provenance. Deterministic, so that the
 * same object always yields the same citation string.
 */
export function renderCitation(object: KnowledgeObject): string {
  return `[${object.provenance.citationLabel}] ${object.sourceUri}#chunk=${object.chunkIndex + 1}/${object.chunkTotal}`;
}
