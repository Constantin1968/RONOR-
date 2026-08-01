/**
 * R-Sentinel — HTTP Routes
 * MIP-013
 *
 * Mounted at /api/v1/sentinel:
 *
 *   GET /status    → full resource snapshot (metrics + alerts + forecasts)
 *   GET /alerts    → active, hysteresis-confirmed alerts
 *   GET /forecast  → per-resource linear-regression forecasts
 *   GET /health    → Sentinel plane health and internal diagnostics
 *
 * Query parameters are validated with Zod (`SentinelQuerySchema`) so malformed
 * filters produce a 400 rather than silently degrading the response.
 */

import { Router, Request, Response, NextFunction } from 'express';
import { createLogger } from '../utils/logger';
import type { RSentinelPlane } from '../planes/r-sentinel';
import { SentinelQuerySchema, SEVERITY_RANK } from '../planes/r-sentinel/types';
import type { ResourceAlert } from '../planes/r-sentinel/types';

const logger = createLogger('API:Sentinel');

export function createSentinelRouter(sentinel: RSentinelPlane): Router {
  const router = Router();

  // ---------------------------------------------------------------
  // GET /status — current resource status (all metrics)
  // ---------------------------------------------------------------
  router.get('/status', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SentinelQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'invalid_query', issues: parsed.error.issues });
      }

      const status = sentinel.getStatus();
      const { resource, limit } = parsed.data;
      let metrics = status.metrics;
      if (resource) metrics = metrics.filter((m) => m.resource === resource || m.name === resource);
      if (limit) metrics = metrics.slice(0, limit);

      return res.json({
        ok: true,
        severity: status.severity,
        degradationLevel: status.degradationLevel,
        metricsCount: metrics.length,
        metrics,
        alerts: status.alerts,
        forecasts: status.forecasts,
        collectedAt: status.collectedAt,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------
  // GET /alerts — active alerts
  // ---------------------------------------------------------------
  router.get('/alerts', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SentinelQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'invalid_query', issues: parsed.error.issues });
      }

      const { resource, severity, limit } = parsed.data;
      let alerts: ResourceAlert[] = sentinel.getAlerts();
      if (resource) alerts = alerts.filter((a) => a.resource === resource);
      if (severity) {
        alerts = alerts.filter((a) => SEVERITY_RANK[a.severity] >= SEVERITY_RANK[severity]);
      }
      if (limit) alerts = alerts.slice(0, limit);

      return res.json({
        ok: true,
        aggregateSeverity: sentinel.getSeverity(),
        count: alerts.length,
        alerts,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------
  // GET /forecast — resource forecasts
  // ---------------------------------------------------------------
  router.get('/forecast', (req: Request, res: Response, next: NextFunction) => {
    try {
      const parsed = SentinelQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return res.status(400).json({ ok: false, error: 'invalid_query', issues: parsed.error.issues });
      }

      const { resource, limit } = parsed.data;
      let forecasts = sentinel.getForecasts();
      if (resource) forecasts = forecasts.filter((f) => f.resource === resource);
      if (limit) forecasts = forecasts.slice(0, limit);

      return res.json({
        ok: true,
        count: forecasts.length,
        forecasts,
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // ---------------------------------------------------------------
  // GET /health — sentinel plane health
  // ---------------------------------------------------------------
  router.get('/health', async (_req: Request, res: Response, next: NextFunction) => {
    try {
      const health = await sentinel.health();
      return res.json({
        ok: health.status !== 'offline',
        health,
        severity: sentinel.getSeverity(),
        config: sentinel.getConfig(),
        diagnostics: sentinel.getDiagnostics(),
        generated_at: new Date().toISOString(),
      });
    } catch (error) {
      next(error);
    }
  });

  // Error handler
  router.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    logger.error('Sentinel API error:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  });

  return router;
}
