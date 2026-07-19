/**
 * RONOR v1.0 — Sovereign Generative Intelligence Runtime
 * Main Entry Point
 *
 * Ma11AI · Mayleven Ecosystem
 * Mayleven Ltd, Company No. 17000500, England & Wales
 *
 * Architecture: 7 Operational Planes
 *   1. R-Gateway       — Ingress, auth, rate-limiting
 *   2. R-Context       — Context management & compression
 *   3. R-Model Fabric  — Intelligent model routing (GPT-5.6 core)
 *   4. R-Agent Runtime — Multi-agent orchestration
 *   5. R-Execution     — Sandboxed tool & code execution
 *   6. R-Assurance     — Quality, evidence & audit
 *   7. R-Economics     — EMS scoring & cost optimisation
 */

import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { createLogger } from './utils/logger';
import { createRouter } from './api/router';
import { RGatewayPlane } from './planes/r-gateway';
import { RContextPlane } from './planes/r-context';
import { RModelFabricPlane } from './planes/r-model-fabric';
import { RAgentRuntimePlane } from './planes/r-agent-runtime';
import { RExecutionPlane } from './planes/r-execution';
import { RAssurancePlane } from './planes/r-assurance';
import { REconomicsPlane } from './planes/r-economics';
import { RONOROrchestrator } from './orchestrator';

const logger = createLogger('RONOR:Main');
const PORT = parseInt(process.env.PORT || '3000', 10);

async function bootstrap(): Promise<void> {
  logger.info('╔══════════════════════════════════════════════════╗');
  logger.info('║  RONOR v1.0 — Sovereign Generative Intelligence  ║');
  logger.info('║  Runtime — Ma11AI · Mayleven Ecosystem            ║');
  logger.info('╚══════════════════════════════════════════════════╝');

  // Validate required environment
  if (!process.env.OPENAI_API_KEY) {
    logger.error('OPENAI_API_KEY is required. Set it in your .env file.');
    process.exit(1);
  }

  // Initialise all 7 operational planes
  logger.info('Initialising 7 operational planes...');

  const gateway = new RGatewayPlane();
  const context = new RContextPlane();
  const modelFabric = new RModelFabricPlane();
  const agentRuntime = new RAgentRuntimePlane();
  const execution = new RExecutionPlane();
  const assurance = new RAssurancePlane();
  const economics = new REconomicsPlane();

  await Promise.all([
    gateway.init(),
    context.init(),
    modelFabric.init(),
    agentRuntime.init(),
    execution.init(),
    assurance.init(),
    economics.init(),
  ]);

  logger.info('All 7 planes operational ✓');

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

  // Health endpoint
  app.get('/health', async (_req, res) => {
    const health = await orchestrator.getSystemHealth();
    res.json({
      status: 'ok',
      version: '1.0.0',
      planes: health,
      models: modelFabric.getAvailableModels().length,
      uptime: process.uptime(),
    });
  });

  app.listen(PORT, () => {
    logger.info(`RONOR Runtime listening on http://localhost:${PORT}`);
    logger.info(`API: http://localhost:${PORT}/api/v1`);
    logger.info(`Health: http://localhost:${PORT}/health`);
    logger.info(`Models active: ${modelFabric.getAvailableModels().length}`);
    logger.info('Ready to process requests ✓');
  });
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
