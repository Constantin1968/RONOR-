/**
 * RONOR API Router
 * RESTful API surface for the RONOR runtime.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';
import type { RONOROrchestrator } from '../orchestrator';
import type { RONORRequest } from '../types';
import * as auditChain from '../audit/hash-chain';
import * as cosign from '../governance/cosign-store';

const logger = createLogger('RONOR:API');

export function createRouter(orchestrator: RONOROrchestrator): Router {
  const router = Router();

  // POST /api/v1/inference — Main inference endpoint
  router.post('/inference', async (req: Request, res: Response, next: NextFunction) => {
    try {
      const { prompt, sessionId, userId, context, modelPreferences, agentConfig } = req.body;

      if (!prompt) {
        return res.status(400).json({ error: 'prompt is required' });
      }

      const request: RONORRequest = {
        id: uuidv4(),
        sessionId: sessionId || uuidv4(),
        userId,
        prompt,
        context,
        modelPreferences,
        agentConfig,
        createdAt: new Date(),
      };

      const response = await orchestrator.process(request);

      // Codul de stare urmeaza verdictul: refuzat, retinut, sau permis.
      const enforcement = response.governance?.enforcement;
      const status =
        enforcement === 'blocked' ? 403 : enforcement === 'held-for-cosign' ? 202 : 200;

      return res.status(status).json({
        id: response.id,
        requestId: response.requestId,
        content: response.content,
        modelUsed: response.modelUsed,
        ems: response.ems,
        tokensUsed: response.tokensUsed,
        latencyMs: response.latencyMs,
        sovereigntyVerified: response.sovereigntyVerified,
        evidenceCount: response.evidenceChain.length,
        independentEvidenceCount: response.independentEvidenceCount,
        governance: response.governance,
        auditRecordId: response.auditRecordId,
        auditSeq: response.auditSeq,
        auditChainHash: response.auditChainHash,
        auditError: response.auditError,
        planeTrace: response.planeTrace.map((t) => ({
          plane: t.planeId,
          durationMs: t.durationMs,
          status: t.status,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  // GET /api/v1/cosign/pending — deciziile retinute, in asteptarea unui om
  router.get('/cosign/pending', (_req: Request, res: Response) => {
    const open = cosign.listOpen();
    res.json({
      count: open.length,
      pending: open.map((d) => ({
        recordId: d.recordId,
        requestId: d.requestId,
        sessionId: d.sessionId,
        verdict: d.verdict,
        modelUsed: d.modelUsed,
        createdAt: d.createdAt,
      })),
    });
  });

  // POST /api/v1/cosign — un om elibereaza o decizie retinuta.
  // Suprafata nu are autentificare proprie: e legata pe interfata locala, iar
  // `operator` e o identitate declarata, nu o dovada criptografica. Cosemnarea
  // se depune in lantul de audit ca act separat, legat de cel retinut.
  router.post('/cosign', (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { recordId?: string; operator?: string; note?: string };
    if (!body.recordId || !body.operator) {
      return res.status(400).json({ error: 'recordId si operator sunt obligatorii' });
    }
    const held = cosign.get(body.recordId);
    if (!held) {
      return res.status(404).json({ error: 'nicio decizie retinuta cu acest identificator' });
    }
    if (held.releasedAt) {
      return res.status(409).json({
        error: 'deja cosemnata',
        releasedAt: held.releasedAt,
        releasedBy: held.releasedBy,
      });
    }

    const ctx = JSON.parse(held.contextJson);
    ctx.metadata = {
      ...(ctx.metadata ?? {}),
      cosignedBy: body.operator,
      cosignNote: body.note,
      heldRecordId: held.recordId,
    };

    const rec = auditChain.append({
      decisionId: held.requestId,
      decisionType: 'cosign.release',
      timestamp: new Date().toISOString(),
      context: ctx,
      mi9Result: JSON.parse(held.mi9Json),
      aiProposal: {
        model: held.modelUsed,
        rationale: 'eliberare prin cosemnare umana a unei decizii retinute',
      },
      outcome: { action: 'executed' },
      operatorSignature: {
        operatorId: body.operator,
        signedAt: new Date().toISOString(),
        role: 'human-cosigner',
      },
    });

    const ok = cosign.markReleased(held.recordId, body.operator);
    if (!ok) {
      return res.status(409).json({ error: 'cosemnare concurenta; decizia era deja eliberata' });
    }
    logger.info(`Decizie eliberata prin cosemnare: ${held.recordId} de ${body.operator}`);

    return res.json({
      recordId: held.recordId,
      requestId: held.requestId,
      verdict: held.verdict,
      content: held.content,
      modelUsed: held.modelUsed,
      cosignedBy: body.operator,
      cosignAuditRecordId: rec.recordId,
      cosignAuditSeq: Number(rec.seq),
      cosignAuditChainHash: rec.chainHash,
    });
  });

  // GET /api/v1/health — System health
  router.get('/health', async (_req: Request, res: Response) => {
    const health = await orchestrator.getSystemHealth();
    res.json({ planes: health, timestamp: new Date() });
  });

  // GET /api/v1/models — Available models
  router.get('/models', (_req: Request, res: Response) => {
    res.json({
      message: 'Model registry available via /health endpoint',
      timestamp: new Date(),
    });
  });

  // Error handler
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('API error:', err.message);
    res.status(500).json({ error: err.message });
  });

  return router;
}
