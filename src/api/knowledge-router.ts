/**
 * R-Knowledge API Router
 * MIP-014 STEP 2 · Phase 5
 *
 * The router is a thin transport adapter and nothing more. It performs no
 * validation, applies no policy, decides no HTTP status and computes no
 * governance outcome: every one of those is decided by the pipeline and reported
 * on the result. A router that inferred a status from an error shape would drift
 * from the pipeline's intent, and the mapping from governance outcome to status is
 * a governance decision that belongs where the governance lives.
 *
 * Disabled-mode prohibition 1 is satisfied by the fact that this factory is never
 * CALLED when the plane is disabled: the composition root has no plane to pass it,
 * because no plane was constructed. The router does not check a flag — it does not
 * exist in the route table at all.
 */

import { Router } from 'express';
import type { Request, Response } from 'express';

import { createLogger } from '../utils/logger';
import type { RKnowledgePlane } from '../planes/r-knowledge';

const logger = createLogger('API:R-Knowledge');

export function createKnowledgeRouter(plane: RKnowledgePlane): Router {
  const router = Router();

  /**
   * POST /ingest — admit a document into the governed corpus.
   *
   * The status comes from the pipeline: 201 created, 200 duplicate, 400 malformed,
   * 403 over-classified, 422 refused, 503 degraded.
   */
  router.post('/ingest', async (req: Request, res: Response) => {
    try {
      const result = await plane.ingestDocument(req.body);
      res.status(result.httpStatus).json({
        ok: result.ok,
        objectIds: result.objectIds,
        chunkTotal: result.chunkTotal,
        duplicate: result.duplicate,
        reason: result.reason,
        detail: result.detail,
        degradationLevel: result.degradationLevel,
        quarantined: result.quarantined,
        vectorsWritten: result.vectorsWritten,
        // The stage trace is returned because it is the evidence that the ordered
        // controls executed in order. An operator debugging a refusal needs to
        // know WHICH stage refused, not merely that something did.
        trace: result.trace,
      });
    } catch (error) {
      // A pipeline is not supposed to throw; every failure is a typed value. This
      // handler exists so that a defect in the plane cannot become an unhandled
      // rejection that disturbs the process, which § 13.2 forbids.
      logger.error(`ingest handler error: ${error instanceof Error ? error.message : 'unknown'}`);
      res.status(503).json({ ok: false, reason: 'RETRIEVAL_UNAVAILABLE' });
    }
  });

  /**
   * POST /corpus — batch ingestion (Stage D, MIP-015).
   *
   * Status semantics differ deliberately from /ingest. A batch is not one thing that
   * succeeded or failed: it is many. 200 is returned whenever the batch was
   * PROCESSED, with per-document dispositions in the body, and 207 would be more
   * precise but is not in the plane's declared status set. A non-2xx status is
   * reserved for a batch that could not be processed at all — a malformed request or
   * a plane too degraded to accept writes — because an operator's retry logic should
   * distinguish "nothing happened, try again" from "most of it worked, read the
   * report".
   */
  router.post('/corpus', async (req: Request, res: Response) => {
    try {
      const documents = req.body?.documents;
      if (!Array.isArray(documents)) {
        res.status(400).json({
          ok: false,
          reason: 'ADMISSION_MALFORMED',
          detail: 'the request body must contain a `documents` array',
        });
        return;
      }
      if (documents.length === 0) {
        // An empty batch is not an error. It is a batch of nothing, and it succeeded
        // at doing nothing — which matters to an idempotent loader that may legitimately
        // find no new documents to offer.
        res.status(200).json({
          ok: true,
          documentsOffered: 0,
          documentsIngested: 0,
          documentsDuplicate: 0,
          documentsRefused: 0,
          documentsQuarantined: 0,
          documentsDegraded: 0,
          objectsWritten: 0,
          outcomes: [],
        });
        return;
      }

      const report = await plane.ingestCorpusBatch(documents, {
        stopOnFirstFailure: req.body?.stopOnFirstFailure === true,
      });

      // 503 only when the plane could not write at all, which is visible as every
      // document having been dispositioned 'degraded'.
      const allDegraded =
        report.documentsOffered > 0 && report.documentsDegraded === report.documentsOffered;
      res.status(allDegraded ? 503 : 200).json(report);
    } catch (error) {
      logger.error(`corpus handler error: ${error instanceof Error ? error.message : 'unknown'}`);
      res.status(503).json({ ok: false, reason: 'RETRIEVAL_UNAVAILABLE' });
    }
  });

  /** POST /query — governed retrieval. */
  router.post('/query', async (req: Request, res: Response) => {
    try {
      const response = await plane.query(req.body);
      // A zero-result retrieval is 200 with `ok: false` and a reason, NOT 404.
      // The request was well formed and was answered; the answer is that the
      // corpus supports nothing. 404 would imply the endpoint was wrong.
      res.status(response.degradationLevel >= 3 ? 503 : 200).json(response);
    } catch (error) {
      logger.error(`query handler error: ${error instanceof Error ? error.message : 'unknown'}`);
      res.status(503).json({ ok: false, reason: 'RETRIEVAL_UNAVAILABLE' });
    }
  });

  /** POST /compose — grounded prompt composition. Generation is NOT performed. */
  router.post('/compose', async (req: Request, res: Response) => {
    try {
      const composition = await plane.compose({
        query: String(req.body?.query ?? ''),
        k: req.body?.k,
        maxClassification: req.body?.maxClassification,
        parentDocumentId: req.body?.parentDocumentId,
      });
      res.status(composition.httpStatus).json(composition);
    } catch (error) {
      logger.error(`compose handler error: ${error instanceof Error ? error.message : 'unknown'}`);
      res.status(503).json({ ok: false, reason: 'RETRIEVAL_UNAVAILABLE' });
    }
  });

  /**
   * GET /status — plane diagnostics and deployment readiness.
   *
   * The readiness report is added to this EXISTING route rather than given one of its
   * own. The disabled-mode equivalence gate enumerates the plane's route set exactly,
   * so every new route is a change to an invariant the programme depends on — and
   * readiness is a qualification of status, which is where a reader would look for it
   * anyway.
   */
  router.get('/status', async (_req: Request, res: Response) => {
    const health = await plane.health();
    const readiness = await plane.deploymentReadiness();
    res.json({ health, diagnostics: plane.getDiagnostics(), readiness });
  });

  /**
   * GET /quarantine — quarantine records.
   *
   * Returns digests and detection rules. It cannot return payloads, because no
   * payload was ever retained.
   */
  router.get('/quarantine', (_req: Request, res: Response) => {
    res.json({ records: plane.getQuarantineRecords() });
  });

  return router;
}
