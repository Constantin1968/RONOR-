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

  /** GET /status — plane diagnostics. */
  router.get('/status', async (_req: Request, res: Response) => {
    const health = await plane.health();
    res.json({ health, diagnostics: plane.getDiagnostics() });
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
