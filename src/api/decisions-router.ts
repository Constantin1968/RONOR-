/**
 * Decisions Router — RONOR Build Week
 *
 * Exposes the governed decision loop over HTTP:
 *
 *   POST /api/v1/decisions        — run a full BESS governed decision loop
 *   GET  /api/v1/audit/head       — current audit chain head hash
 *   GET  /api/v1/audit/verify     — walk + verify the whole chain
 *   GET  /api/v1/audit/records    — list recent audit records (paginated)
 *   GET  /api/v1/audit/records/:id — fetch one record
 *   GET  /api/v1/audit/export     — export the entire chain as JSON
 *   GET  /api/v1/exposure/weights — publish the exposure module weights + version
 *
 * The routes are deliberately simple and CORS-open so a static web UI or
 * a judge with `curl` can exercise the whole stack in seconds.
 */

import { Router, type Request, type Response, type NextFunction } from 'express';
import { createLogger } from '../utils/logger';
import { runDecisionLoop, type DecisionRequest } from '../decision-loop/orchestrator';
import {
  verifyChain,
  getHeadHash,
  listRecords,
  getRecord,
  exportChain,
  countRecords,
} from '../audit/hash-chain';
import { getModuleVersion, WEIGHTS_SNAPSHOT } from '../governance/exposure-analysis';
import { getPolicyVersion, loadPolicy } from '../governance/mi9-gate';

const logger = createLogger('DecisionsAPI');

export function createDecisionsRouter(): Router {
  const router = Router();

  // Ensure policy is loaded once at boot
  try {
    loadPolicy();
  } catch (err) {
    logger.error(`Failed to load MI9 policy at boot: ${err}`);
  }

  // ------------------------------------------------------------
  // POST /api/v1/decisions
  // ------------------------------------------------------------
  router.post('/decisions', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const body: DecisionRequest = req.body || {};
      const domain = body.domain || 'energy.bess.dispatch';

      const started = Date.now();
      const response = await runDecisionLoop({ ...body, domain });
      const durationMs = Date.now() - started;

      logger.info(
        `POST /decisions session=${response.decisionSessionId} actions=${response.summary.totalActions} allowed=${response.summary.allowed} blocked=${response.summary.blocked} gain=€${response.verifiedGainEur} in ${durationMs}ms`
      );

      return res.json({
        decisionSessionId: response.decisionSessionId,
        timestamp: response.timestamp,
        durationMs,
        asset: {
          assetId: response.asset.assetId,
          location: response.asset.location,
          ratedPowerMw: response.asset.ratedPowerMw,
          ratedEnergyMwh: response.asset.ratedEnergyMwh,
          inverterMode: response.asset.inverterMode,
        },
        baseline: {
          policyName: response.baseline.policyName,
          revenueEur: response.baseline.revenueEur,
          degradationCostEur: response.baseline.degradationCostEur,
          netEur: response.baseline.netEur,
          actionsCount: response.baseline.actions.length,
        },
        proposal: {
          modelUsed: response.proposal.modelUsed,
          rationale: response.proposal.rationale,
          expectedRevenueEur: response.proposal.expectedRevenueEur,
          expectedDegradationEur: response.proposal.expectedDegradationEur,
          expectedNetEur: response.proposal.expectedNetEur,
          meanConfidence: Number(response.proposal.meanConfidence.toFixed(3)),
          latencyMs: response.proposal.latencyMs,
          tokensUsed: response.proposal.tokensUsed,
          fallbackUsed: response.proposal.fallbackUsed,
        },
        verifiedGainEur: response.verifiedGainEur,
        osaasFeeEur: response.osaasFeeEur,
        summary: response.summary,
        exposureSummary: response.exposureSummary,
        headChainHash: response.headChainHash,
        perAction: response.perAction.map((p) => ({
          type: p.action.type,
          timestamp: p.action.timestamp,
          volumeMwh: p.action.volumeMwh,
          volumeMw: p.action.volumeMw,
          priceEurPerMwh: p.action.priceEurPerMwh,
          reason: p.action.reason,
          confidence: p.action.confidence,
          mi9Verdict: p.mi9Result.verdict,
          mi9Findings: p.mi9Result.findings.map((f) => ({
            gate: f.gateName,
            verdict: f.verdict,
            reason: f.reason,
          })),
          exposure: {
            tier: p.exposure.aggregateTier,
            score: p.exposure.aggregateScore,
            residualEur: p.exposure.residualExposureEur,
            worstCaseEur: p.exposure.worstCaseEur,
            advisory: p.exposure.advisory,
            fingerprint: p.exposure.exposureFingerprint,
            narrative: p.exposure.narrative,
          },
          auditRecord: {
            seq: p.auditRecord.seq,
            recordId: p.auditRecord.recordId,
            payloadHash: p.auditRecord.payloadHash,
            prevHash: p.auditRecord.prevHash,
            chainHash: p.auditRecord.chainHash,
          },
        })),
      });
    } catch (err) {
      logger.error(`POST /decisions failed: ${err}`);
      next(err);
    }
  });

  // ------------------------------------------------------------
  // GET /api/v1/audit/head
  // ------------------------------------------------------------
  router.get('/audit/head', (_req: Request, res: Response) => {
    return res.json({
      headHash: getHeadHash(),
      totalRecords: countRecords(),
      policyVersion: getPolicyVersion(),
      exposureModuleVersion: getModuleVersion(),
      timestamp: new Date().toISOString(),
    });
  });

  // ------------------------------------------------------------
  // GET /api/v1/audit/verify
  // ------------------------------------------------------------
  router.get('/audit/verify', (_req: Request, res: Response) => {
    const result = verifyChain();
    return res.json(result);
  });

  // ------------------------------------------------------------
  // GET /api/v1/audit/records
  // ------------------------------------------------------------
  router.get('/audit/records', (req: Request, res: Response) => {
    const limit = Math.min(500, Math.max(1, parseInt(String(req.query.limit || '50'), 10)));
    const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10));
    const records = listRecords(limit, offset);
    return res.json({
      limit,
      offset,
      total: countRecords(),
      records: records.map((r) => ({
        seq: r.seq,
        recordId: r.recordId,
        timestamp: r.timestamp,
        decisionId: r.payload.decisionId,
        decisionType: r.payload.decisionType,
        verdict: r.payload.mi9Result.verdict,
        outcome: r.payload.outcome.action,
        model: r.payload.aiProposal.model,
        payloadHash: r.payloadHash,
        prevHash: r.prevHash,
        chainHash: r.chainHash,
      })),
    });
  });

  // ------------------------------------------------------------
  // GET /api/v1/audit/records/:id
  // ------------------------------------------------------------
  router.get('/audit/records/:id', (req: Request, res: Response) => {
    const rec = getRecord(req.params.id);
    if (!rec) return res.status(404).json({ error: 'not found' });
    return res.json(rec);
  });

  // ------------------------------------------------------------
  // GET /api/v1/audit/export
  // ------------------------------------------------------------
  router.get('/audit/export', (_req: Request, res: Response) => {
    const chain = exportChain();
    res.setHeader('Content-Disposition', `attachment; filename="ronor-audit-chain-${Date.now()}.json"`);
    return res.json({
      exportedAt: new Date().toISOString(),
      totalRecords: chain.length,
      headHash: chain.length ? chain[chain.length - 1].chainHash : '0'.repeat(64),
      policyVersion: getPolicyVersion(),
      exposureModuleVersion: getModuleVersion(),
      chain,
    });
  });

  // ------------------------------------------------------------
  // GET /api/v1/exposure/weights
  // ------------------------------------------------------------
  router.get('/exposure/weights', (_req: Request, res: Response) => {
    return res.json({
      moduleVersion: getModuleVersion(),
      weights: WEIGHTS_SNAPSHOT,
      timestamp: new Date().toISOString(),
    });
  });

  // ------------------------------------------------------------
  // GET /api/v1/governance/policy
  // ------------------------------------------------------------
  router.get('/governance/policy', (_req: Request, res: Response) => {
    return res.json({
      policyVersion: getPolicyVersion(),
      timestamp: new Date().toISOString(),
    });
  });

  return router;
}
