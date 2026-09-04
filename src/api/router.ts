/**
 * RONOR API Router
 * RESTful API surface for the RONOR runtime.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { createLogger } from '../utils/logger';
import type { RONOROrchestrator } from '../orchestrator';
import type { RONORRequest } from '../types';

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

      return res.json({
        id: response.id,
        requestId: response.requestId,
        content: response.content,
        modelUsed: response.modelUsed,
        ems: response.ems,
        tokensUsed: response.tokensUsed,
        latencyMs: response.latencyMs,
        sovereigntyVerified: response.sovereigntyVerified,
        evidenceCount: response.evidenceChain.length,
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
