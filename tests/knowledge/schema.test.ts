/**
 * R-Knowledge — Knowledge Object Schema Tests
 * MIP-014 STEP 2 · Phase 1 · Gate G1
 *
 * Gate G1 requires that the schema reject each of the fourteen mandatory-field
 * omissions with a field-specific error, accept a complete object, assert
 * invariants K-INV-1 to K-INV-7, and reject unknown top-level keys rather than
 * stripping them.
 */

import {
  KnowledgeObjectSchema,
  canonicalStringify,
  computeContentHash,
  computeProvenanceCompleteness,
  computeVectorHash,
  isProvenanceComplete,
  renderCitation,
  validateKnowledgeObject,
} from '../../src/knowledge/schema';
import {
  CLASSIFICATION_RANK,
  KNOWLEDGE_SCHEMA_VERSION,
  MANDATORY_KNOWLEDGE_FIELDS,
} from '../../src/planes/r-knowledge/types';
import type { KnowledgeObject } from '../../src/planes/r-knowledge/types';

// ------------------------------------------------------------
// Fixture — a complete, valid Knowledge Object
// ------------------------------------------------------------

const CONTENT = 'Battery energy storage dispatch schedule for the 20 MWh Romania site.';

function makeValidObject(overrides: Partial<KnowledgeObject> = {}): KnowledgeObject {
  const vector = [0.1, 0.2, 0.3, 0.4];
  const base: KnowledgeObject = {
    objectId: '6f9619ff-8b86-4d11-b42d-00c04fc964ff',
    schemaVersion: KNOWLEDGE_SCHEMA_VERSION,
    contentHash: computeContentHash(CONTENT),
    content: CONTENT,
    sourceUri: 'internal:fixtures/bess-dispatch-001',
    sourceType: 'report',
    classification: 'PUBLIC',
    sovereigntyTier: 1,
    ingestedAt: '2026-08-02T09:00:00+03:00',
    ingestedBy: 'amb',
    chunkIndex: 0,
    chunkTotal: 1,
    embeddingRef: {
      provider: 'deterministic',
      model: null,
      dimensions: 4,
      vectorHash: computeVectorHash(vector),
    },
    provenance: {
      parentDocumentId: 'doc-bess-dispatch-001',
      retrievalPath: 'ingestion/deterministic',
      citationLabel: 'BESS-DISPATCH-001',
      completeness: 1,
    },
  };
  return { ...base, ...overrides };
}

// ------------------------------------------------------------
// Acceptance
// ------------------------------------------------------------

describe('R-Knowledge · Knowledge Object schema — acceptance', () => {
  test('a complete object is accepted', () => {
    const outcome = validateKnowledgeObject(makeValidObject());
    expect(outcome.ok).toBe(true);
    expect(outcome.reason).toBeNull();
    expect(outcome.errors).toHaveLength(0);
    expect(outcome.object).not.toBeNull();
  });

  test('the contract declares exactly fourteen mandatory fields', () => {
    expect(MANDATORY_KNOWLEDGE_FIELDS).toHaveLength(14);
    expect(new Set(MANDATORY_KNOWLEDGE_FIELDS).size).toBe(14);
  });

  test('schemaVersion is exactly "1.0" and any other version is refused', () => {
    expect(KNOWLEDGE_SCHEMA_VERSION).toBe('1.0');
    const outcome = validateKnowledgeObject(makeValidObject({ schemaVersion: '1.1' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.some((e) => e.path === 'schemaVersion')).toBe(true);
  });

  test('an object embedded by the deterministic adapter with model null is valid', () => {
    const outcome = validateKnowledgeObject(makeValidObject());
    expect(outcome.ok).toBe(true);
    expect(outcome.object?.embeddingRef.model).toBeNull();
    expect(outcome.object?.embeddingRef.provider).toBe('deterministic');
  });

  test('optional fields are accepted when well formed', () => {
    const outcome = validateKnowledgeObject(
      makeValidObject({
        title: 'BESS dispatch schedule',
        author: 'Operations',
        publishedAt: '2026-07-01T00:00:00Z',
        language: 'en',
        tags: ['bess', 'dispatch'],
        expiresAt: '2027-07-01T00:00:00Z',
        metadata: { site: 'RO-20MWh' },
      })
    );
    expect(outcome.ok).toBe(true);
  });
});

// ------------------------------------------------------------
// K-INV-1 — the fourteen omission cases
// ------------------------------------------------------------

describe('R-Knowledge · K-INV-1 — each of the fourteen mandatory omissions is refused', () => {
  test.each(MANDATORY_KNOWLEDGE_FIELDS)('omitting %s is refused with a field-specific error', (field) => {
    const candidate = makeValidObject() as unknown as Record<string, unknown>;
    delete candidate[field];

    const outcome = validateKnowledgeObject(candidate);

    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('SCHEMA_INVALID');
    expect(outcome.violations).toContain('K-INV-1');
    // The error must name the omitted field, not merely report a failure.
    expect(outcome.errors.some((e) => e.path === field || e.path.startsWith(`${field}.`))).toBe(true);
    expect(outcome.object).toBeNull();
  });

  test('a null mandatory field is refused as firmly as an absent one', () => {
    const candidate = makeValidObject() as unknown as Record<string, unknown>;
    candidate.ingestedBy = null;
    const outcome = validateKnowledgeObject(candidate);
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.some((e) => e.path === 'ingestedBy')).toBe(true);
  });
});

// ------------------------------------------------------------
// K-INV-2 — content integrity
// ------------------------------------------------------------

describe('R-Knowledge · K-INV-2 — content integrity', () => {
  test('mutated content fails integrity and is refused', () => {
    const outcome = validateKnowledgeObject(
      makeValidObject({ content: `${CONTENT} tampered` })
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('INTEGRITY_FAILED');
    expect(outcome.violations).toContain('K-INV-2');
    expect(outcome.object).toBeNull();
  });

  test('a substituted contentHash fails integrity', () => {
    const outcome = validateKnowledgeObject(
      makeValidObject({ contentHash: 'a'.repeat(64) })
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('INTEGRITY_FAILED');
  });

  test('the content digest law is stable across repeated computation', () => {
    const first = computeContentHash(CONTENT);
    for (let i = 0; i < 50; i++) {
      expect(computeContentHash(CONTENT)).toBe(first);
    }
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  test('canonicalStringify is key-order independent', () => {
    const a = canonicalStringify({ beta: 2, alpha: 1, gamma: { y: 2, x: 1 } });
    const b = canonicalStringify({ gamma: { x: 1, y: 2 }, alpha: 1, beta: 2 });
    expect(a).toBe(b);
  });

  test('canonicalStringify is cycle-guarded', () => {
    const cyclic: Record<string, unknown> = { a: 1 };
    cyclic.self = cyclic;
    expect(() => canonicalStringify(cyclic)).not.toThrow();
    expect(canonicalStringify(cyclic)).toContain('[Circular]');
  });
});

// ------------------------------------------------------------
// K-INV-3 — classification ceiling
// ------------------------------------------------------------

describe('R-Knowledge · K-INV-3 — classification ceiling', () => {
  test('an over-classified object is refused against the ceiling', () => {
    const outcome = validateKnowledgeObject(makeValidObject({ classification: 'RESTRICTED' }), {
      maxClassification: 'INTERNAL',
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('CLASSIFICATION_CEILING_EXCEEDED');
    expect(outcome.violations).toContain('K-INV-3');
  });

  test('an object at the ceiling is admitted', () => {
    const outcome = validateKnowledgeObject(makeValidObject({ classification: 'INTERNAL' }), {
      maxClassification: 'INTERNAL',
    });
    expect(outcome.ok).toBe(true);
  });

  test('classification is compared by rank, never by string ordering', () => {
    // Alphabetically CONFIDENTIAL < INTERNAL, which would invert the ladder.
    expect(CLASSIFICATION_RANK.CONFIDENTIAL).toBeGreaterThan(CLASSIFICATION_RANK.INTERNAL);
    expect(CLASSIFICATION_RANK.RESTRICTED).toBeGreaterThan(CLASSIFICATION_RANK.CONFIDENTIAL);
    expect(CLASSIFICATION_RANK.PUBLIC).toBe(0);
  });
});

// ------------------------------------------------------------
// K-INV-4, K-INV-5, K-INV-6, K-INV-7
// ------------------------------------------------------------

describe('R-Knowledge · K-INV-4 — dimensional agreement', () => {
  test('a dimension mismatch is refused and no wrong-dimension vector is admitted', () => {
    const outcome = validateKnowledgeObject(makeValidObject(), { activeDimensions: 384 });
    expect(outcome.ok).toBe(false);
    expect(outcome.reason).toBe('EMBEDDING_DIMENSION_MISMATCH');
    expect(outcome.violations).toContain('K-INV-4');
    expect(outcome.object).toBeNull();
  });

  test('matching dimensions are admitted', () => {
    const outcome = validateKnowledgeObject(makeValidObject(), { activeDimensions: 4 });
    expect(outcome.ok).toBe(true);
  });
});

describe('R-Knowledge · K-INV-5 — gapless chunk cover', () => {
  test('a gap in the sibling cover is recorded as a violation without rejecting the object', () => {
    const outcome = validateKnowledgeObject(
      makeValidObject({ chunkIndex: 2, chunkTotal: 4 }),
      { siblingChunkIndices: [0, 3] } // index 1 missing
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.violations).toContain('K-INV-5');
  });

  test('a complete cover records no violation', () => {
    const outcome = validateKnowledgeObject(
      makeValidObject({ chunkIndex: 2, chunkTotal: 4 }),
      { siblingChunkIndices: [0, 1, 3] }
    );
    expect(outcome.ok).toBe(true);
    expect(outcome.violations).not.toContain('K-INV-5');
  });

  test('chunkIndex must be strictly less than chunkTotal', () => {
    const outcome = validateKnowledgeObject(makeValidObject({ chunkIndex: 3, chunkTotal: 3 }));
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.some((e) => e.path === 'chunkIndex')).toBe(true);
  });
});

describe('R-Knowledge · K-INV-6 — completeness is computed, never supplied', () => {
  test('a caller-supplied completeness value is not honoured', () => {
    const object = makeValidObject();
    const computed = computeProvenanceCompleteness({
      ...object,
      provenance: {
        parentDocumentId: object.provenance.parentDocumentId,
        retrievalPath: object.provenance.retrievalPath,
        citationLabel: object.provenance.citationLabel,
      },
    } as never);
    expect(computed).toBe(1);

    const tampered = makeValidObject({ content: `${CONTENT} tampered` });
    const computedTampered = computeProvenanceCompleteness({
      ...tampered,
      provenance: {
        parentDocumentId: tampered.provenance.parentDocumentId,
        retrievalPath: tampered.provenance.retrievalPath,
        citationLabel: tampered.provenance.citationLabel,
      },
    } as never);
    // Integrity is a necessary condition; a tampered object is not "almost complete".
    expect(computedTampered).toBe(0);
  });

  test('provenance completeness reflects integrity, not merely field presence', () => {
    expect(isProvenanceComplete(makeValidObject())).toBe(true);
    expect(isProvenanceComplete(makeValidObject({ contentHash: 'b'.repeat(64) }))).toBe(false);
  });
});

describe('R-Knowledge · K-INV-7 — unknown keys are rejected, not stripped', () => {
  test('an unknown top-level key causes rejection', () => {
    const candidate = { ...makeValidObject(), smuggled: 'payload' } as unknown;
    const outcome = validateKnowledgeObject(candidate);
    expect(outcome.ok).toBe(false);
    expect(outcome.violations).toContain('K-INV-7');
    expect(outcome.object).toBeNull();
  });

  test('the key is not silently stripped — parsing does not succeed', () => {
    const candidate = { ...makeValidObject(), smuggled: 'payload' } as unknown;
    const parsed = KnowledgeObjectSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  test('an unknown nested key in embeddingRef is rejected', () => {
    const object = makeValidObject();
    const candidate = {
      ...object,
      embeddingRef: { ...object.embeddingRef, extra: true },
    } as unknown;
    expect(KnowledgeObjectSchema.safeParse(candidate).success).toBe(false);
  });
});

// ------------------------------------------------------------
// Field constraint detail
// ------------------------------------------------------------

describe('R-Knowledge · field constraints', () => {
  test('objectId must be a UUID v4', () => {
    const outcome = validateKnowledgeObject(makeValidObject({ objectId: 'not-a-uuid' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.some((e) => e.path === 'objectId')).toBe(true);
  });

  test('sourceUri must be scheme-qualified', () => {
    const outcome = validateKnowledgeObject(makeValidObject({ sourceUri: 'bess-dispatch-001' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.some((e) => e.path === 'sourceUri')).toBe(true);
  });

  test('ingestedAt must carry a timezone offset', () => {
    const outcome = validateKnowledgeObject(makeValidObject({ ingestedAt: '2026-08-02 09:00:00' }));
    expect(outcome.ok).toBe(false);
    expect(outcome.errors.some((e) => e.path === 'ingestedAt')).toBe(true);
  });

  test('sovereigntyTier is restricted to 1, 2 or 3', () => {
    expect(validateKnowledgeObject(makeValidObject({ sovereigntyTier: 4 as never })).ok).toBe(false);
    expect(validateKnowledgeObject(makeValidObject({ sovereigntyTier: 2 })).ok).toBe(true);
  });

  test('citations render deterministically from provenance', () => {
    const object = makeValidObject();
    const first = renderCitation(object);
    expect(renderCitation(object)).toBe(first);
    expect(first).toContain('BESS-DISPATCH-001');
    expect(first).toContain('internal:fixtures/bess-dispatch-001');
  });
});
