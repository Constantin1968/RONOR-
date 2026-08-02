/**
 * Retrieval Pipeline — eleven ordered stages
 * MIP-014 STEP 2 · Phase 4 (Pipelines) · STEP 1 § 8.2
 *
 *   R-1   Query validation                strict schema
 *   R-2   Availability gate               level 3 refuses outright
 *   R-3   Query normalisation             same rules as ingestion
 *   R-4   Query injection screening       a query is untrusted input too
 *   R-5   Query embedding                 or lexical degradation
 *   R-6   Vector search                   k oversampled for post-filtering
 *   R-7   Object hydration                integrity verified at read
 *   R-8   Classification filter           applied PLANE-SIDE, never store-side alone
 *   R-9   Similarity floor                below floor is excluded, not returned weakly
 *   R-10  Ranking and citation binding    citation derived from the object
 *   R-11  Explicit emptiness              a reasoned zero-result, never a silent one
 *
 * Stage R-8 is the one to read carefully. The store may apply a classification
 * filter as a retrieval optimisation, but the store is NEVER the sole enforcement
 * point: the plane re-applies the ceiling over whatever comes back. A filter
 * expression sent to a store is a request; a check performed on the returned set
 * is a control. Only the latter survives a store that misbehaves, a filter that
 * is silently dropped, or an index that is stale.
 *
 * Stage R-11 exists because the failure mode it prevents is the most damaging one
 * available to a retrieval system: returning nothing, being interpreted as
 * "no constraint", and having a model's unattributed prior knowledge substituted
 * in place of the corpus. A zero-result retrieval is therefore an explicit,
 * reasoned outcome that a caller must handle, not an empty success it can ignore.
 */

import { screenForInjection } from './injection-guard';
import { normaliseText } from './chunker';
import { assembleRetrievalResult, verifyObjectIntegrity } from './provenance';
import { CLASSIFICATION_RANK, KnowledgeQuerySchema } from '../planes/r-knowledge/types';
import type {
  DegradationState,
  EmbeddingAdapter,
  KnowledgeConfig,
  KnowledgeRetrievalResponse,
  KnowledgeRetrievalResult,
  SearchFilters,
  VectorStore,
} from '../planes/r-knowledge/types';
import { toOffsetIso } from './ingestion';

export interface RetrievalContext {
  config: KnowledgeConfig;
  store: VectorStore;
  embedder: EmbeddingAdapter;
  degradation: DegradationState;
  now: () => Date;
}

/**
 * Oversampling factor for the store query.
 *
 * The store is asked for more candidates than the caller requested, because
 * stages R-7 through R-9 remove candidates after the store has ranked them: an
 * object failing integrity verification, exceeding the classification ceiling or
 * falling below the similarity floor is dropped. Requesting exactly k would return
 * fewer than k results whenever any candidate is dropped, and the shortfall would
 * look like corpus sparsity rather than filtering.
 */
export const OVERSAMPLE_FACTOR = 4;

export async function retrieve(
  raw: unknown,
  context: RetrievalContext
): Promise<KnowledgeRetrievalResponse> {
  const generatedAt = toOffsetIso(context.now());
  const base = {
    storeId: context.store.id,
    embeddingProvider: context.embedder.provider,
    degradationLevel: context.degradation.level,
    generatedAt,
  };

  // ---------- R-1 Query validation ----------
  const parsed = KnowledgeQuerySchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      results: [],
      reason: 'ADMISSION_MALFORMED',
      queryNormalised: false,
      ...base,
    };
  }
  const query = parsed.data;

  // ---------- R-2 Availability gate ----------
  if (context.degradation.level >= 3) {
    // An explicit unavailable result with a reason code. Not an empty list.
    return {
      ok: false,
      results: [],
      reason: context.degradation.reason ?? 'RETRIEVAL_UNAVAILABLE',
      queryNormalised: false,
      ...base,
    };
  }

  // ---------- R-3 Query normalisation ----------
  // The same normalisation the corpus received, for the reason that a query
  // normalised differently from the corpus would systematically fail to match it.
  // A query that normalises to nothing is refused rather than embedded, because an
  // embedding of the empty string is a meaningless vector that would still return
  // ranked results.
  const normalised = normaliseText(query.query);
  if (normalised.text.length === 0) {
    return {
      ok: false,
      results: [],
      reason: 'NORMALISATION_FAILED',
      queryNormalised: false,
      ...base,
    };
  }

  // ---------- R-4 Query injection screening ----------
  // A query is untrusted input on the same footing as ingested content. Screening
  // only the corpus would leave the obvious channel open.
  const screening = screenForInjection(query.query);
  if (!screening.clean) {
    return {
      ok: false,
      results: [],
      reason: 'INJECTION_DETECTED',
      queryNormalised: true,
      ...base,
    };
  }

  // ---------- R-5 Query embedding ----------
  const embedded = await context.embedder.embed([normalised.text]);
  if (!embedded.ok) {
    // Level 1: no semantic search is possible. The plane reports the reason
    // rather than returning an unmarked empty list.
    return {
      ok: false,
      results: [],
      reason: embedded.reason ?? 'EMBEDDING_UNAVAILABLE',
      queryNormalised: true,
      ...base,
      degradationLevel: 1,
    };
  }
  if (embedded.dimensions !== context.config.embeddingDimensions) {
    return {
      ok: false,
      results: [],
      reason: 'EMBEDDING_DIMENSION_MISMATCH',
      queryNormalised: true,
      ...base,
    };
  }

  // ---------- R-6 Vector search ----------
  const k = query.k ?? context.config.retrievalTopK;
  const filters: SearchFilters = {
    maxClassification: query.maxClassification ?? context.config.maxClassification,
    parentDocumentId: query.parentDocumentId,
    sourceType: query.sourceType,
  };
  const hits = await context.store.search(embedded.vectors[0], k * OVERSAMPLE_FACTOR, filters);

  // ---------- R-7 Object hydration with integrity verification ----------
  const hydrated: { objectId: string; score: number; object: NonNullable<Awaited<ReturnType<VectorStore['getById']>>> }[] = [];
  for (const hit of hits) {
    const object = await context.store.getById(hit.objectId);
    if (object === null) continue;
    // Verified again here even though the store verifies on read. The duplication
    // is deliberate: this pipeline must be correct against ANY store
    // implementation, including one whose read path is less careful than the
    // reference store's.
    if (!verifyObjectIntegrity(object).ok) continue;
    hydrated.push({ objectId: hit.objectId, score: hit.score, object });
  }

  // ---------- R-8 Classification filter, applied plane-side ----------
  const ceiling = CLASSIFICATION_RANK[filters.maxClassification ?? context.config.maxClassification];
  const admitted = hydrated.filter(
    (candidate) => CLASSIFICATION_RANK[candidate.object.classification] <= ceiling
  );

  // ---------- R-9 Similarity floor ----------
  const aboveFloor = admitted.filter(
    (candidate) => candidate.score >= context.config.minSimilarity
  );

  // ---------- R-10 Ranking and citation binding ----------
  const degraded = context.degradation.level >= 1;
  const results: KnowledgeRetrievalResult[] = aboveFloor
    .sort((a, b) => b.score - a.score || a.objectId.localeCompare(b.objectId))
    .slice(0, k)
    .map((candidate, index) =>
      assembleRetrievalResult({
        object: candidate.object,
        score: candidate.score,
        rank: index + 1,
        storeId: context.store.id,
        embeddingProvider: context.embedder.provider,
        degraded,
        retrievedAt: generatedAt,
      })
    );

  // ---------- R-11 Explicit emptiness ----------
  if (results.length === 0) {
    // The reason distinguishes an empty corpus from a corpus whose candidates all
    // fell below the floor. Collapsing the two would make a tuning problem
    // indistinguishable from a data problem.
    const reason =
      admitted.length > 0 ? 'RETRIEVAL_BELOW_SIMILARITY_FLOOR' : 'RETRIEVAL_EMPTY';
    return {
      ok: false,
      results: [],
      reason,
      queryNormalised: true,
      ...base,
    };
  }

  return {
    ok: true,
    results,
    reason: null,
    queryNormalised: true,
    ...base,
  };
}
