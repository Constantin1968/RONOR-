/**
 * RONOR Runtime — L2 · Knowledge Bridge
 * ─────────────────────────────────────
 * Connects the runtime request path to the existing R-Knowledge plane, which
 * already implements the parts that are hard to get right: chunking, embedding
 * with an authorised-egress gate, a Qdrant or SQLite vector store, classification
 * enforcement, injection quarantine, nonce-delimited prompt composition and
 * degradation levels. This module does NOT reimplement any of that. It provides
 * a single lifecycle-managed handle and translates between the plane's vocabulary
 * and the runtime's.
 *
 * Three properties are deliberate:
 *
 *   1. THE PLANE STAYS OPTIONAL AND STAYS GATED. `RKnowledgePlane.create()`
 *      returns null unless `KNOWLEDGE_ENABLED` is exactly `'true'`. The bridge
 *      preserves that: with knowledge disabled the runtime answers from model
 *      weights and SAYS SO in the response, rather than silently producing an
 *      ungrounded answer that looks identical to a grounded one.
 *
 *   2. A ZERO-RESULT RETRIEVAL IS AN EXPLICIT OUTCOME, NEVER A SILENT FALLBACK
 *      TO MEMORY. The plane's own contract (R-11) requires this, and the bridge
 *      propagates the reason code upward so the pipeline can record why the
 *      answer is unsourced. This is the single most important property here: an
 *      empty retrieval that quietly becomes a confident parametric answer is how
 *      a RAG system starts fabricating with citations-shaped confidence.
 *
 *   3. INITIALISATION IS LAZY AND FAILURE IS NON-FATAL. A vector store that is
 *      asleep must degrade the answer, not refuse the request. The bridge caches
 *      the failure and reports it rather than retrying on every request.
 *
 * Prepared by AMB.
 */

import { RKnowledgePlane } from '../../planes/r-knowledge';
import type {
  DegradationLevel,
  KnowledgeClassification,
  KnowledgeRetrievalResult,
} from '../../planes/r-knowledge/types';
import type { ConfidentialityLevel } from '../router/policy';

export interface RetrievalOutcome {
  /** True when retrieved evidence was actually composed into the prompt. */
  used: boolean;
  /** True when the knowledge plane exists and initialised. */
  available: boolean;
  results: KnowledgeRetrievalResult[];
  citations: Array<{ title: string; url?: string; snippet?: string }>;
  /** Nonce-delimited prompt from the plane, or null when nothing was retrieved. */
  composedPrompt: string | null;
  degradationLevel: DegradationLevel | null;
  /** The plane's reason code, or a bridge-level explanation. */
  reason: string | null;
  /** Age of the freshest retrieved evidence in ms, or null when none. */
  evidenceAgeMs: number | null;
}

let plane: RKnowledgePlane | null = null;
let initialised = false;
let initFailure: string | null = null;

/**
 * Obtain the plane handle, initialising once.
 *
 * The failure is cached. Retrying `init()` on every request would turn an
 * unreachable vector store into a per-request timeout, which is a far worse
 * outcome than a degraded answer.
 */
export async function getKnowledgePlane(
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ plane: RKnowledgePlane | null; reason: string | null }> {
  if (initialised) return { plane, reason: initFailure };
  initialised = true;

  const created = RKnowledgePlane.create(env);
  if (!created) {
    initFailure = 'KNOWLEDGE_DISABLED';
    return { plane: null, reason: initFailure };
  }
  try {
    await created.init();
    plane = created;
    initFailure = null;
  } catch (err) {
    plane = null;
    initFailure = `KNOWLEDGE_INIT_FAILED: ${err instanceof Error ? err.message : String(err)}`;
    // eslint-disable-next-line no-console
    console.error('[RONOR:L2] knowledge plane initialisation failed:', err);
  }
  return { plane, reason: initFailure };
}

/** Test and redeploy affordance. */
export async function resetKnowledgeBridge(): Promise<void> {
  if (plane) {
    try {
      await plane.shutdown();
    } catch {
      // A failed shutdown must not prevent a reset; the handle is discarded either way.
    }
  }
  plane = null;
  initialised = false;
  initFailure = null;
}

/**
 * Map runtime confidentiality to the plane's classification ceiling.
 *
 * The mapping is intentionally CONSERVATIVE in the retrieval direction: a
 * `public` request may only see public material, while a `sovereign` request may
 * see everything. Getting this backwards would leak restricted evidence into a
 * low-confidentiality answer, which is the failure the classification system
 * exists to prevent.
 */
export function classificationCeilingFor(
  confidentiality: ConfidentialityLevel,
): KnowledgeClassification {
  // The plane's classification vocabulary is UPPERCASE and is compared by
  // ordinal rank rather than string order, so the ceiling cannot be defeated by
  // alphabetisation. Returning the plane's own literals keeps that guarantee
  // intact instead of introducing a second casing convention to translate.
  switch (confidentiality) {
    case 'public':
      return 'PUBLIC';
    case 'internal':
      return 'INTERNAL';
    case 'restricted':
      return 'CONFIDENTIAL';
    case 'sovereign':
      return 'RESTRICTED';
  }
}

export async function retrieveContext(params: {
  query: string;
  confidentiality: ConfidentialityLevel;
  k?: number;
  parentDocumentId?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<RetrievalOutcome> {
  const { plane: p, reason } = await getKnowledgePlane(params.env ?? process.env);

  if (!p) {
    return {
      used: false,
      available: false,
      results: [],
      citations: [],
      composedPrompt: null,
      degradationLevel: null,
      // Named explicitly so the pipeline can record that the answer is
      // parametric rather than merely uncited.
      reason: reason ?? 'KNOWLEDGE_UNAVAILABLE',
      evidenceAgeMs: null,
    };
  }

  try {
    const composition = await p.compose({
      query: params.query,
      k: params.k ?? 6,
      maxClassification: classificationCeilingFor(params.confidentiality),
      parentDocumentId: params.parentDocumentId,
    });

    const results = composition.results ?? [];
    return {
      // `used` requires BOTH a composed prompt and at least one result. A
      // composition with zero results is not grounding, and reporting it as such
      // would be the exact misrepresentation this bridge exists to prevent.
      used: Boolean(composition.composedPrompt) && results.length > 0,
      available: true,
      results,
      citations: results.map((r) => ({
        title: r.object.title ?? r.object.sourceUri,
        url: r.object.sourceUri,
        snippet: r.object.content.slice(0, 300),
      })),
      composedPrompt: composition.composedPrompt,
      degradationLevel: composition.degradationLevel,
      reason: composition.reason ?? null,
      evidenceAgeMs: freshestEvidenceAgeMs(results),
    };
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[RONOR:L2] retrieval failed:', err);
    return {
      used: false,
      available: true,
      results: [],
      citations: [],
      composedPrompt: null,
      degradationLevel: null,
      reason: `RETRIEVAL_ERROR: ${err instanceof Error ? err.message : String(err)}`,
      evidenceAgeMs: null,
    };
  }
}

/**
 * Age of the freshest retrieved object, in milliseconds.
 *
 * Feeds MI9 Gate 5. Uses `publishedAt` when the source declares one and falls
 * back to `ingestedAt`, because for staleness purposes when a document was
 * WRITTEN matters more than when this system happened to read it.
 */
export function freshestEvidenceAgeMs(results: KnowledgeRetrievalResult[]): number | null {
  if (results.length === 0) return null;
  const now = Date.now();
  let freshest = Number.POSITIVE_INFINITY;
  for (const r of results) {
    const stamp = r.object.publishedAt ?? r.object.ingestedAt;
    const t = Date.parse(stamp);
    if (Number.isNaN(t)) continue;
    freshest = Math.min(freshest, Math.max(0, now - t));
  }
  return Number.isFinite(freshest) ? freshest : null;
}

export interface IngestRequest {
  sourceUri: string;
  content: string;
  classification?: KnowledgeClassification;
  sovereigntyTier?: 1 | 2 | 3;
  sourceType?: string;
  ingestedBy?: string;
}

export interface IngestOutcome {
  ok: boolean;
  available: boolean;
  objectsWritten: number;
  documentsRefused: number;
  documentsQuarantined: number;
  reason: string | null;
  outcomes: Array<{ sourceUri: string; disposition: string; reason: string | null }>;
}

/**
 * Ingest documents through the plane's governed pipeline.
 *
 * Batch and single-document ingestion use the SAME pipeline inside the plane, so
 * there is no path by which a batch can admit a document that would have been
 * refused individually.
 */
export async function ingestDocuments(
  documents: IngestRequest[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<IngestOutcome> {
  const { plane: p, reason } = await getKnowledgePlane(env);
  if (!p) {
    return {
      ok: false,
      available: false,
      objectsWritten: 0,
      documentsRefused: documents.length,
      documentsQuarantined: 0,
      reason: reason ?? 'KNOWLEDGE_UNAVAILABLE',
      outcomes: [],
    };
  }

  const report = await p.ingestCorpusBatch(
    documents.map((d) => ({
      sourceUri: d.sourceUri,
      content: d.content,
      // Defaults to INTERNAL, not PUBLIC. An unclassified document is not
      // thereby public, and defaulting downward would silently widen the
      // audience of every document an operator forgot to label.
      classification: d.classification ?? 'INTERNAL',
      sovereigntyTier: d.sovereigntyTier ?? 2,
      sourceType: d.sourceType,
      ingestedBy: d.ingestedBy ?? 'runtime-api',
    })),
  );

  return {
    ok: report.ok,
    available: true,
    objectsWritten: report.objectsWritten,
    documentsRefused: report.documentsRefused,
    documentsQuarantined: report.documentsQuarantined,
    reason: report.ok ? null : 'one or more documents were refused or quarantined',
    outcomes: report.outcomes.map((o) => ({
      sourceUri: o.sourceUri,
      disposition: o.disposition,
      reason: o.reason,
    })),
  };
}

export interface KnowledgeStatus {
  enabled: boolean;
  initialised: boolean;
  reason: string | null;
  store: string | null;
  embeddingProvider: string | null;
  degradationLevel: DegradationLevel | null;
  objectsIngested: number | null;
  quarantined: number | null;
}

export async function knowledgeStatus(
  env: NodeJS.ProcessEnv = process.env,
): Promise<KnowledgeStatus> {
  const { plane: p, reason } = await getKnowledgePlane(env);
  if (!p) {
    return {
      enabled: false,
      initialised: false,
      reason: reason ?? 'KNOWLEDGE_UNAVAILABLE',
      store: null,
      embeddingProvider: null,
      degradationLevel: null,
      objectsIngested: null,
      quarantined: null,
    };
  }
  const diagnostics = p.getDiagnostics();
  const config = p.getConfig();
  const degradation = p.getDegradation();
  return {
    enabled: true,
    initialised: true,
    reason: null,
    store: config.vectorStore,
    embeddingProvider: config.embeddingProvider,
    degradationLevel: degradation.level,
    objectsIngested: diagnostics.objectsIngested ?? null,
    quarantined: p.getQuarantineRecords().length,
  };
}
