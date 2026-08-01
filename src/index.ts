/**
 * RONOR — Governed Intelligence for Energy Operations
 * Main Entry Point (Build Week 2026)
 *
 * Ma11AI · Mayleven Ecosystem
 * Mayleven Ltd, Company No. 17000500, England & Wales
 *
 * Architecture: 8 Operational Planes + Governance & Audit Spine
 *   Planes:
 *     1. R-Gateway       — Ingress, auth, rate-limiting
 *     2. R-Context       — Context management & compression
 *     3. R-Model Fabric  — Intelligent model routing (GPT-5.6 core)
 *     4. R-Agent Runtime — Multi-agent orchestration
 *     5. R-Execution     — Sandboxed tool & code execution
 *     6. R-Assurance     — Quality, evidence & audit
 *     7. R-Economics     — EMS scoring & cost optimisation
 *     8. R-Sentinel      — Operational resource intelligence (MIP-013)
 *   Governance & Audit Spine (Build Week 2026):
 *     · MI9 Gate               — 9-gate policy engine (sovereignty, risk, impact,
 *                                confidence, evidence, reversibility, policy,
 *                                rate-limit, fallback)
 *     · Exposure Analysis      — 8-dimension risk register, SHA-256 fingerprinted
 *     · SHA-256 Hash-Chain     — bankable audit chain (SQLite-persisted)
 *     · Decision Loop          — end-to-end BESS governed dispatch scenario
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createLogger } from './utils/logger';
import { createRouter } from './api/router';
import { createDecisionsRouter } from './api/decisions-router';
import { modelExchangeRouter } from './api/model-exchange-router';
import { createSentinelRouter } from './api/sentinel-router';
import { initModelExchange } from './model-exchange/orchestrator';
import { loadPolicy } from './governance/mi9-gate';
import { getDb } from './audit/hash-chain';
import { RGatewayPlane } from './planes/r-gateway';
import { RContextPlane } from './planes/r-context';
import { RModelFabricPlane } from './planes/r-model-fabric';
import { RAgentRuntimePlane } from './planes/r-agent-runtime';
import { RExecutionPlane } from './planes/r-execution';
import { RAssurancePlane } from './planes/r-assurance';
import { REconomicsPlane } from './planes/r-economics';
import { RSentinelPlane } from './planes/r-sentinel';
import { RONOROrchestrator } from './orchestrator';

const logger = createLogger('RONOR:Main');
const PORT = parseInt(process.env.PORT || '3000', 10);

async function bootstrap(): Promise<void> {
  logger.info('╔══════════════════════════════════════════════════╗');
  logger.info('║  RONOR — Model Exchange & Governance Spine       ║');
  logger.info('║  for Energy Operations · Ma11AI Mayleven         ║');
  logger.info('╚══════════════════════════════════════════════════╝');

  // OPENAI_API_KEY is recommended but not required — the decision loop
  // falls back to a deterministic proposer when it is absent, so judges can
  // still exercise MI9 Gate + Exposure Analysis + audit chain end-to-end.
  if (!process.env.OPENAI_API_KEY) {
    logger.warn('OPENAI_API_KEY not set — frontier-model proposer will fall back to deterministic policy.');
  }

  // Boot governance + audit primitives first so they are ready before the
  // first decision request lands.
  loadPolicy();
  getDb();
  initModelExchange();
  logger.info('Governance policy loaded + audit chain DB ready + Model Exchange work-ledger initialised ✓');

  // Initialise all 8 operational planes
  logger.info('Initialising 8 operational planes...');

  const gateway = new RGatewayPlane();
  const context = new RContextPlane();
  const modelFabric = new RModelFabricPlane();
  const agentRuntime = new RAgentRuntimePlane();
  const execution = new RExecutionPlane();
  const assurance = new RAssurancePlane();
  const economics = new REconomicsPlane();
  const sentinel = new RSentinelPlane();

  const planes = [
    gateway,
    context,
    modelFabric,
    agentRuntime,
    execution,
    assurance,
    economics,
    sentinel,
  ];

  await Promise.all([
    gateway.init(),
    context.init(),
    modelFabric.init(),
    agentRuntime.init(),
    execution.init(),
    assurance.init(),
    economics.init(),
    sentinel.init(),
  ]);

  logger.info(`All ${planes.length} planes operational ✓`);

  // Build orchestrator
  const orchestrator = new RONOROrchestrator({
    gateway,
    context,
    modelFabric,
    agentRuntime,
    execution,
    assurance,
    economics,
  });

  // Express application
  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
  app.use(express.urlencoded({ extended: true }));

  // Mount API routes
  app.use('/api/v1', createRouter(orchestrator));
  app.use('/api/v1', createDecisionsRouter());
  app.use('/api/v1/model-exchange', modelExchangeRouter);
  app.use('/api/v1/sentinel', createSentinelRouter(sentinel));

  // Static web UI (decision timeline + audit verifier)
  app.use('/', express.static('web'));

  // Health endpoint
  app.get('/health', async (_req, res) => {
    const health = await orchestrator.getSystemHealth();
    const sentinelHealth = await sentinel.health();
    res.json({
      status: 'ok',
      version: '1.0.0',
      planes: [...health, sentinelHealth],
      sentinel: {
        severity: sentinel.getSeverity(),
        degradationLevel: sentinel.getResponseController().level,
      },
      models: modelFabric.getAvailableModels().length,
      uptime: process.uptime(),
    });
  });

  app.listen(PORT, () => {
    logger.info(`RONOR Runtime listening on http://localhost:${PORT}`);
    logger.info(`API: http://localhost:${PORT}/api/v1`);
    logger.info(`Health: http://localhost:${PORT}/health`);
    logger.info(`Models active: ${modelFabric.getAvailableModels().length}`);
    logger.info(`Sentinel: http://localhost:${PORT}/api/v1/sentinel/status`);
    logger.info('Ready to process requests ✓');
  });
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
