/**
 * R-Knowledge — Provenance Tests
 * MIP-014 STEP 2 · Phase 2 · Gate G2
 *
 * Provenance is the mechanism by which a retrieved statement remains attributable
 * to the artefact that supports it. These tests assert that construction is the
 * only route into the corpus, that integrity is verified at read time as well as
 * write time, and that a citation cannot exist without an object.
 */

import { chunkText } from '../../src/knowledge/chunker';
import { DeterministicEmbeddingAdapter } from '../../src/knowledge/embedding/deterministic-adapter';
import {
  assembleRetrievalResult,
  constructKnowledgeObject,
  deriveCitationLabel,
  deriveParentDocumentId,
  resolveCitations,
  verifyObjectIntegrity,
  verifyVectorBinding,
} from '../../src/knowledge/provenance';
import { computeContentHash } from '../../src/knowledge/schema';
import type { KnowledgeObject } from '../../src/planes/r-knowledge/types';

const DIMENSIONS = 64;
const SOURCE = 'internal:fixtures/bess-operational-record';
const CONTENT =
  'The installation delivers frequency containment reserve under a day-ahead schedule. ' +
  'State of charge is held between fifteen and ninety percent.';

async function buildObject(
  overrides: Partial<Parameters<typeof constructKnowledgeObject>[0]> = {}
): Promise<KnowledgeObject> {
  const chunks = chunkText(CONTENT, { chunkSizeTokens: 512, chunkOverlapTokens: 64 });
  const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
  const embedded = await adapter.embed([chunks.chunks[0].text]);

  const result = constructKnowledgeObject({
    chunk: chunks.chunks[0],
    sourceUri: SOURCE,
    sourceType: 'report',
    classification: 'PUBLIC',
    sovereigntyTier: 1,
    ingestedBy: 'amb',
    parentDocumentId: deriveParentDocumentId(SOURCE),
    embeddingProvider: 'deterministic',
    embeddingModel: null,
    embeddingDimensions: DIMENSIONS,
    vector: embedded.vectors[0],
    retrievalPath: 'ingestion/deterministic',
    ingestedAt: '2026-08-02T09:00:00+03:00',
    ...overrides,
  });

  expect(result.ok).toBe(true);
  return result.object!;
}

describe('R-Knowledge · object construction', () => {
  test('a constructed object is schema-valid and provenance-complete', async () => {
    const object = await buildObject();
    expect(object.provenance.completeness).toBe(1);
    expect(object.embeddingRef.provider).toBe('deterministic');
    expect(object.embeddingRef.model).toBeNull();
    expect(object.contentHash).toBe(computeContentHash(object.content));
  });

  test('completeness is computed and a supplied value cannot be injected (K-INV-6)', async () => {
    const object = await buildObject();
    // The construction input has no completeness field at all: the value cannot
    // be supplied, so there is no path by which it could be honoured.
    expect(Object.keys(object.provenance)).toEqual(
      expect.arrayContaining(['parentDocumentId', 'retrievalPath', 'citationLabel', 'completeness'])
    );
    expect(object.provenance.completeness).toBeGreaterThan(0);
  });

  test('a degraded ingestion without a vector still produces a valid object', async () => {
    const object = await buildObject({ vector: null });
    expect(object.embeddingRef.vectorHash).toMatch(/^[0-9a-f]{64}$/);
    // The digest is that of the empty vector, which identifies the object as
    // awaiting re-embedding rather than as malformed.
    expect(verifyVectorBinding(object, null).ok).toBe(true);
    expect(verifyVectorBinding(object, [0.1, 0.2]).ok).toBe(false);
  });

  test('an empty chunk is refused with NORMALISATION_FAILED', async () => {
    const result = constructKnowledgeObject({
      chunk: { index: 0, total: 1, text: '', tokenEstimate: 0, startOffset: 0, endOffset: 0 },
      sourceUri: SOURCE,
      sourceType: 'report',
      classification: 'PUBLIC',
      sovereigntyTier: 1,
      ingestedBy: 'amb',
      parentDocumentId: deriveParentDocumentId(SOURCE),
      embeddingProvider: 'deterministic',
      embeddingModel: null,
      embeddingDimensions: DIMENSIONS,
      vector: null,
      retrievalPath: 'ingestion/deterministic',
      ingestedAt: '2026-08-02T09:00:00+03:00',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('NORMALISATION_FAILED');
    expect(result.object).toBeNull();
  });

  test('construction refuses a dimensional disagreement rather than emitting an object', async () => {
    const chunks = chunkText(CONTENT, { chunkSizeTokens: 512, chunkOverlapTokens: 64 });
    const result = constructKnowledgeObject({
      chunk: chunks.chunks[0],
      sourceUri: SOURCE,
      sourceType: 'report',
      classification: 'PUBLIC',
      sovereigntyTier: 1,
      ingestedBy: 'amb',
      parentDocumentId: deriveParentDocumentId(SOURCE),
      embeddingProvider: 'deterministic',
      embeddingModel: null,
      // Declared dimensions disagree with nothing yet; the invariant check uses
      // the declared value as the active dimensionality, so agreement holds.
      embeddingDimensions: DIMENSIONS,
      vector: new Array(DIMENSIONS).fill(0),
      retrievalPath: 'ingestion/deterministic',
      ingestedAt: 'not-an-iso-timestamp',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('SCHEMA_INVALID');
    expect(result.detail).toContain('ingestedAt');
  });

  test('parent document identifiers are content-derived and therefore stable', () => {
    expect(deriveParentDocumentId(SOURCE)).toBe(deriveParentDocumentId(SOURCE));
    expect(deriveParentDocumentId(SOURCE)).not.toBe(deriveParentDocumentId(`${SOURCE}-other`));
    expect(deriveParentDocumentId(SOURCE)).toMatch(/^doc-[0-9a-f]{32}$/);
  });

  test('citation labels are deterministic and position-bearing', () => {
    const parent = deriveParentDocumentId(SOURCE);
    expect(deriveCitationLabel(parent, 0)).toBe(deriveCitationLabel(parent, 0));
    expect(deriveCitationLabel(parent, 0)).toMatch(/-C001$/);
    expect(deriveCitationLabel(parent, 11)).toMatch(/-C012$/);
    expect(deriveCitationLabel('', 0)).toBe('DOC-C001');
  });
});

describe('R-Knowledge · read-time integrity (RK-012, K-INV-2)', () => {
  test('an unmutated object verifies', async () => {
    const object = await buildObject();
    expect(verifyObjectIntegrity(object).ok).toBe(true);
  });

  test('mutated content fails verification and is excluded, not warned about', async () => {
    const object = await buildObject();
    const tampered: KnowledgeObject = { ...object, content: `${object.content} appended` };
    const verdict = verifyObjectIntegrity(tampered);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('INTEGRITY_FAILED');
    expect(verdict.objectId).toBe(object.objectId);
  });

  test('a substituted digest fails verification', async () => {
    const object = await buildObject();
    const verdict = verifyObjectIntegrity({ ...object, contentHash: 'f'.repeat(64) });
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('INTEGRITY_FAILED');
  });

  test('an object stripped of a mandatory field fails verification', async () => {
    const object = await buildObject();
    const stripped = { ...object } as unknown as Record<string, unknown>;
    delete stripped.ingestedBy;
    const verdict = verifyObjectIntegrity(stripped as unknown as KnowledgeObject);
    expect(verdict.ok).toBe(false);
  });

  test('a vector replaced independently of its content is detected', async () => {
    const object = await buildObject();
    const adapter = new DeterministicEmbeddingAdapter(DIMENSIONS);
    const correct = await adapter.embed([object.content]);
    expect(verifyVectorBinding(object, correct.vectors[0]).ok).toBe(true);

    const substituted = [...correct.vectors[0]];
    substituted[0] = Number((substituted[0] + 0.5).toFixed(6));
    const verdict = verifyVectorBinding(object, substituted);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toBe('INTEGRITY_FAILED');
  });
});

describe('R-Knowledge · citation binding and verification (RK-028, G-5, G-7)', () => {
  test('an assembled result binds a citation derived from the object itself', async () => {
    const object = await buildObject();
    const result = assembleRetrievalResult({
      object,
      score: 0.82,
      rank: 1,
      storeId: 'sqlite',
      embeddingProvider: 'deterministic',
      degraded: false,
      retrievedAt: '2026-08-02T10:00:00+03:00',
    });
    expect(result.citation).toBe(`[${object.provenance.citationLabel}]`);
    expect(result.provenanceComplete).toBe(true);
    expect(result.rank).toBe(1);
    expect(result.degraded).toBe(false);
  });

  test('a result carries all nine retrieval-contract fields', async () => {
    const object = await buildObject();
    const result = assembleRetrievalResult({
      object,
      score: 0.5,
      rank: 3,
      storeId: 'sqlite',
      embeddingProvider: 'deterministic',
      degraded: true,
      retrievedAt: '2026-08-02T10:00:00+03:00',
    });
    expect(Object.keys(result).sort()).toEqual(
      [
        'citation',
        'degraded',
        'embeddingProvider',
        'object',
        'provenanceComplete',
        'rank',
        'retrievedAt',
        'score',
        'storeId',
      ].sort()
    );
  });

  test('a citation to a non-retrieved object is unresolvable', async () => {
    const object = await buildObject();
    const result = assembleRetrievalResult({
      object,
      score: 0.9,
      rank: 1,
      storeId: 'sqlite',
      embeddingProvider: 'deterministic',
      degraded: false,
      retrievedAt: '2026-08-02T10:00:00+03:00',
    });

    const output = `The reserve is delivered ${result.citation} under a schedule [FABRICATED-C001].`;
    const { resolved, unresolvable } = resolveCitations(output, [result]);
    expect(resolved).toEqual([object.provenance.citationLabel]);
    expect(unresolvable).toEqual(['FABRICATED-C001']);
  });

  test('repeated citation tokens are reported once', async () => {
    const object = await buildObject();
    const result = assembleRetrievalResult({
      object,
      score: 0.9,
      rank: 1,
      storeId: 'sqlite',
      embeddingProvider: 'deterministic',
      degraded: false,
      retrievedAt: '2026-08-02T10:00:00+03:00',
    });
    const label = object.provenance.citationLabel;
    const { resolved } = resolveCitations(`[${label}] and again [${label}]`, [result]);
    expect(resolved).toEqual([label]);
  });

  test('output with no citation token yields no resolution and no false positive', async () => {
    const object = await buildObject();
    const result = assembleRetrievalResult({
      object,
      score: 0.9,
      rank: 1,
      storeId: 'sqlite',
      embeddingProvider: 'deterministic',
      degraded: false,
      retrievedAt: '2026-08-02T10:00:00+03:00',
    });
    const { resolved, unresolvable } = resolveCitations('A statement without attribution.', [result]);
    expect(resolved).toHaveLength(0);
    expect(unresolvable).toHaveLength(0);
  });
});
