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
import { RKnowledgePlane } from './planes/r-knowledge';
import { createKnowledgeRouter } from './api/knowledge-router';
import { RONOROrchestrator } from './orchestrator';
// ── Runtime Active (L0–L7) ──────────────────────────────────────────────────
import { createRuntimeRouter } from './runtime/api/routes';
import {
  errorHandler as runtimeErrorHandler,
  provenanceMiddleware,
} from './runtime/api/middleware';
import { bootstrapApiKeys } from './runtime/api/auth';
import { providerStatuses } from './runtime/providers/registry';
import { seedFromLedger } from './runtime/router/calibrator';
import { recentAttemptSamples } from './runtime/ledgers/work-ledger';
import { ensureRuntimeLedgerSchema } from './runtime/ledgers/schema';

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

  // ── Runtime Active boot (L0/L1/L7) ────────────────────────────────────────
  //
  // Three steps, in this order, before the first request can land.
  ensureRuntimeLedgerSchema();

  // 1. Credentials. The result is LOGGED rather than swallowed: a deployment
  //    running on the shipped demo key must be visible in the boot log as well as
  //    on /health, because an operator reading one is not necessarily reading the
  //    other.
  const keyBootstrap = bootstrapApiKeys(process.env);
  if (keyBootstrap.keysSeeded === 0) {
    logger.warn(
      'No runtime API keys configured (RONOR_API_KEYS / RONOR_ADMIN_API_KEY) — ' +
        'the runtime API will refuse every request. Set at least one key.',
    );
  } else {
    logger.info(`Runtime API keys loaded: ${keyBootstrap.keysSeeded} ✓`);
  }
  if (keyBootstrap.insecureDefaultActive) {
    logger.error(
      'SECURITY: a shipped default API key is active. Rotate RONOR_API_KEYS before ' +
        'exposing this instance to any network.',
    );
  }

  // 2. Router telemetry. Seeding from persisted attempts means a restart does not
  //    discard what the router learned about provider latency and reliability. An
  //    unseeded router silently reverts to catalogue estimates and re-learns the
  //    same degradation from scratch, sending real traffic to a known-bad engine
  //    in the process.
  const samples = recentAttemptSamples(50);
  const seeded = seedFromLedger(samples);
  logger.info(
    `Router calibrator seeded from ledger: ${seeded} sample(s) across persisted attempts ✓`,
  );

  // 3. Provider inventory. Reported honestly, including which providers are
  //    present in code but lack a credential, so nobody mistakes an adapter for a
  //    connection.
  const providers = providerStatuses();
  const live = providers.filter((p) => p.invocable);
  const generative = live.filter((p) => p.provider !== 'deterministic');
  logger.info(
    `Providers: ${live.length}/${providers.length} invocable (${generative.length} generative) — ` +
      live.map((p) => `${p.provider}:${p.transport}`).join(', '),
  );
  const absent = providers.filter((p) => !p.invocable);
  if (absent.length) {
    logger.warn(
      `Providers present but not invocable (no credential): ${absent
        .map((p) => p.provider)
        .join(', ')} — adapters are implemented and will activate when a key is set.`,
    );
  }
  if (generative.length === 0) {
    logger.warn(
      'No generative provider is invocable. The runtime will serve only the ' +
        'deterministic core and /api/runtime/health will report status=degraded.',
    );
  }

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

  // ── R-Knowledge (MIP-014) — plane 9, fail-closed ────────────────────────────
  //
  // THE ABSOLUTE GATE. `create()` returns null unless KNOWLEDGE_ENABLED is
  // exactly "true", and a null result means NO INSTANCE EXISTS. Every statement
  // below that touches the plane is therefore inside a null check, and when the
  // flag is absent the runtime's observable behaviour is byte-for-byte what it was
  // at the baseline commit: the same route table, the same eight plane health
  // entries, the same files on disk, the same open handles.
  //
  // The plane is deliberately NOT added to the `planes` array and NOT passed to
  // the orchestrator. It is not in the inference pipeline: `GET /health` continues
  // to report exactly eight planes, and R-Knowledge reports separately. Adding it
  // to that array would change a baseline-equivalence invariant (BE-3) for no
  // functional gain, since nothing in the orchestrator consumes retrieval.
  const knowledge = RKnowledgePlane.create();
  if (knowledge !== null) {
    await knowledge.init();

    // ---- Stage F: knowledge grounding (MIP-015 STEP 3) ----
    //
    // R-Knowledge supplies grounded context to the inference pipeline through a
    // narrow provider interface attached to R-Context. Three properties are
    // preserved, and each is load-bearing:
    //
    //   - The orchestrator's plane composition is UNCHANGED. R-Knowledge is still
    //     not a member of the eight, `GET /health` still reports exactly eight
    //     planes, and invariant BE-3 is untouched.
    //   - The attachment happens ONLY inside this null check. When the plane is
    //     disabled no provider is attached, R-Context's `knowledgeProvider` stays
    //     null, and the system prompt it produces is byte-identical to the
    //     baseline's.
    //   - A knowledge failure degrades the answer rather than denying it. The
    //     provider returns a value on every path and raises nothing.
    const { createKnowledgeContextProvider } = await import('./knowledge/context-provider');
    context.attachKnowledgeProvider(createKnowledgeContextProvider(knowledge));

    logger.info('R-Knowledge (plane 9) enabled ✓ — Stage F grounding attached to R-Context');
  }

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

  // ── Runtime Active surface ────────────────────────────────────────────────
  //
  // Mounted on its own prefix with its OWN middleware chain, ahead of the Core
  // Active routers. The isolation is deliberate: provenance capture, per-key rate
  // limiting and the runtime error handler apply to /api/runtime only, so the
  // existing /api/v1 contracts and their 594 tests are untouched. A shared
  // middleware stack would have coupled the two surfaces and made every future
  // runtime change a regression risk for Core Active.
  const runtimeRouter = createRuntimeRouter();
  app.use('/api/runtime', provenanceMiddleware, runtimeRouter, runtimeErrorHandler);

  // Mount API routes
  app.use('/api/v1', createRouter(orchestrator));
  app.use('/api/v1', createDecisionsRouter());
  app.use('/api/v1/model-exchange', modelExchangeRouter);
  app.use('/api/v1/sentinel', createSentinelRouter(sentinel));
  if (knowledge !== null) {
    // Registered only when the plane exists. In disabled mode this mount does not
    // occur, so the route table is identical to the baseline's (invariant BE-1).
    app.use('/api/v1/knowledge', createKnowledgeRouter(knowledge));
  }

  // Operator Console (Runtime Active) and the existing static web UI.
  // The console is mounted on an explicit path so the baseline root-served UI
  // keeps its exact behaviour.
  app.use('/console', express.static('web/console'));
  app.use('/control', express.static('web/control'));
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
      // Present ONLY when the plane is enabled. The key is absent in disabled
      // mode, so the health payload is structurally identical to the baseline's —
      // not merely similar with a null field, which would still be a diff.
      ...(knowledge !== null
        ? { knowledge: { degradationLevel: knowledge.getDegradation().level } }
        : {}),
    });
  });

  if (knowledge !== null) {
    logger.info(`Knowledge: http://localhost:${PORT}/api/v1/knowledge/status`);
  }

  const server = app.listen(PORT, () => {
    logger.info(`RONOR Runtime listening on http://localhost:${PORT}`);
    logger.info(`API: http://localhost:${PORT}/api/v1`);
    logger.info(`Health: http://localhost:${PORT}/health`);
    logger.info(`Models active: ${modelFabric.getAvailableModels().length}`);
    logger.info(`Sentinel: http://localhost:${PORT}/api/v1/sentinel/status`);
    logger.info('──────────────────────────────────────────────');
    logger.info(`Runtime API:      http://localhost:${PORT}/api/runtime`);
    logger.info(`Runtime health:   http://localhost:${PORT}/api/runtime/health`);
    logger.info(`Operator Console: http://localhost:${PORT}/console`);
    logger.info('──────────────────────────────────────────────');
    logger.info('Ready to process requests ✓');
  });

  // Graceful shutdown. Without this, a container stop severs in-flight requests
  // after their provider spend has been committed but before their ledger row is
  // written — producing exactly the silent gap between money spent and work
  // recorded that the ledger exists to prevent.
  const shutdown = (signal: string) => {
    logger.info(`${signal} received — draining connections before exit.`);
    runtimeRouter.stopAutomationRecovery();
    server.close(() => {
      logger.info('HTTP server closed. Exiting.');
      process.exit(0);
    });
    // A bounded wait: a connection that will not drain must not hold the process
    // open indefinitely.
    setTimeout(() => {
      logger.warn('Drain timeout reached — forcing exit.');
      process.exit(0);
    }, 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

bootstrap().catch((err) => {
  console.error('Fatal bootstrap error:', err);
  process.exit(1);
});
