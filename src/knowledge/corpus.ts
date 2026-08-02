/**
 * Corpus Ingestion Service — Stage D
 * MIP-015 STEP 3 · Requirement 3D
 *
 * Batch ingestion of real documents through the governed single-document pipeline.
 *
 * ── The one design decision that matters here ───────────────────────────────
 *
 * This service does NOT reimplement ingestion. Every document passes through the
 * same eleven-stage pipeline as a single-document request, with the same
 * classification ceiling, the same injection screen, the same duplicate detection
 * and the same provenance construction.
 *
 * The temptation in a batch path is to optimise: skip the screen for trusted
 * sources, hash once and reuse, embed everything in one call and construct objects
 * afterwards. Each of those creates a second ingestion law, and a second law is how
 * a corpus acquires documents that could never have been admitted individually. The
 * batch path is therefore a LOOP over the governed path, and the only concessions to
 * scale are ordering and reporting.
 *
 * ── Partial failure is the normal case ──────────────────────────────────────
 *
 * A batch of a hundred documents will contain one that is over-classified, one that
 * trips the injection screen and one that is already present. Failing the whole
 * batch would make the service unusable; silently dropping the failures would make
 * it untrustworthy. Every document therefore gets an outcome, and the batch result
 * reports counts by disposition so an operator can see what happened without
 * reading a log.
 */

import { ingest } from './ingestion';
import type { IngestionContext, IngestionResult } from './ingestion';
import type { KnowledgeClassification } from '../planes/r-knowledge/types';

/** One document offered for ingestion. */
export interface CorpusDocument {
  sourceUri: string;
  content: string;
  classification: KnowledgeClassification;
  sovereigntyTier: 1 | 2 | 3;
  sourceType?: string;
  parentDocumentId?: string;
  ingestedBy?: string;
}

/** How a single document turned out. */
export type CorpusDisposition =
  | 'ingested'
  | 'duplicate'
  | 'refused'
  | 'quarantined'
  | 'degraded';

export interface CorpusDocumentOutcome {
  sourceUri: string;
  disposition: CorpusDisposition;
  objectIds: string[];
  chunkCount: number;
  reason: string | null;
  detail: string | null;
  /** Which pipeline stages were reached. Preserved for diagnosis. */
  stagesReached: string[];
}

export interface CorpusIngestionReport {
  /** True only when EVERY document was ingested or was already present. */
  ok: boolean;
  documentsOffered: number;
  documentsIngested: number;
  documentsDuplicate: number;
  documentsRefused: number;
  documentsQuarantined: number;
  documentsDegraded: number;
  objectsWritten: number;
  outcomes: CorpusDocumentOutcome[];
  startedAt: string;
  completedAt: string;
  durationMs: number;
}

export interface CorpusIngestionOptions {
  /**
   * Stop at the first refusal.
   *
   * Default false. An operator loading a directory wants to know about all the
   * problems in one pass, not to fix them one restart at a time. Set true when the
   * batch is a transaction in the operator's mind — for example a migration where a
   * partial load is worse than no load.
   */
  stopOnFirstFailure?: boolean;
  /**
   * Concurrency.
   *
   * Default 1. Deliberately serial, because the embedding provider is rate-limited
   * and duplicate detection reads the store that the previous document just wrote.
   * Ingesting two identical documents concurrently would let both pass the
   * duplicate check before either had been written, and the corpus would acquire
   * exactly the duplicate the check exists to prevent.
   */
  concurrency?: number;
}

/**
 * Classify an ingestion result into a disposition.
 *
 * Separated from the loop so the mapping is stated once and can be read against the
 * pipeline's reason codes.
 */
function dispositionOf(result: IngestionResult): CorpusDisposition {
  if (result.ok && result.duplicate) return 'duplicate';
  if (result.ok) return 'ingested';
  if (result.quarantined) return 'quarantined';
  // Enumerated explicitly against the reason-code union rather than matched by
  // prefix. A prefix match on 'STORE_' would silently reclassify
  // STORE_CLASSIFICATION_REFUSED — a governance refusal that IS the document's
  // fault — as a dependency outage, and an operator would re-offer a document that
  // must never be admitted.
  const dependencyFailures: readonly (string | null)[] = [
    'STORE_UNAVAILABLE',
    'STORE_CIRCUIT_OPEN',
    'STORE_TIMEOUT',
    'STORE_WRITE_REFUSED',
    'STORE_AUTH_FAILURE',
    'STORE_TLS_FAILURE',
    'STORE_PROTOCOL_ERROR',
    'EMBEDDING_UNAVAILABLE',
  ];
  if (dependencyFailures.includes(result.reason)) {
    // A dependency failure is NOT the document's fault. Recording it as a refusal
    // would tell an operator to fix the document, when the remedy is to fix the
    // dependency and re-offer the same document unchanged.
    return 'degraded';
  }
  return 'refused';
}

/**
 * Ingest a batch of documents through the governed pipeline.
 */
export async function ingestCorpus(
  documents: CorpusDocument[],
  context: IngestionContext,
  options: CorpusIngestionOptions = {}
): Promise<CorpusIngestionReport> {
  const startedAt = context.now();
  const started = Date.now();
  const outcomes: CorpusDocumentOutcome[] = [];
  const stopOnFirstFailure = options.stopOnFirstFailure === true;

  for (const document of documents) {
    const result = await ingest(
      {
        sourceUri: document.sourceUri,
        content: document.content,
        classification: document.classification,
        sovereigntyTier: document.sovereigntyTier,
        sourceType: document.sourceType ?? 'document',
        parentDocumentId: document.parentDocumentId,
        ingestedBy: document.ingestedBy ?? 'corpus-service',
      },
      context
    );

    const disposition = dispositionOf(result);
    outcomes.push({
      sourceUri: document.sourceUri,
      disposition,
      objectIds: result.objectIds,
      chunkCount: result.objectIds.length,
      reason: result.reason,
      detail: result.detail ?? null,
      // The stage trace, reduced to the stages actually reached. Preserved because a
      // refusal at I-3 (classification) and a refusal at I-9 (embedding) require
      // completely different operator responses, and the reason code alone does not
      // always make clear how far the document got.
      stagesReached: result.trace.map((entry) => entry.stage),
    });

    if (stopOnFirstFailure && disposition !== 'ingested' && disposition !== 'duplicate') {
      // The remaining documents are reported as unattempted rather than omitted, so
      // the report's document count always equals what was offered.
      for (const remaining of documents.slice(outcomes.length)) {
        outcomes.push({
          sourceUri: remaining.sourceUri,
          disposition: 'refused',
          objectIds: [],
          chunkCount: 0,
          reason: 'BATCH_ABORTED',
          detail:
            'not attempted: the batch was configured to stop at the first failure and an ' +
            'earlier document failed',
          stagesReached: [],
        });
      }
      break;
    }
  }

  const completedAt = context.now();
  const count = (disposition: CorpusDisposition): number =>
    outcomes.filter((o) => o.disposition === disposition).length;

  return {
    // Duplicates count as success: re-offering a document already present is a
    // no-op, not a fault, and an idempotent loader depends on it being treated so.
    ok: outcomes.every((o) => o.disposition === 'ingested' || o.disposition === 'duplicate'),
    documentsOffered: documents.length,
    documentsIngested: count('ingested'),
    documentsDuplicate: count('duplicate'),
    documentsRefused: count('refused'),
    documentsQuarantined: count('quarantined'),
    documentsDegraded: count('degraded'),
    objectsWritten: outcomes.reduce((sum, o) => sum + o.chunkCount, 0),
    outcomes,
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: Date.now() - started,
  };
}
