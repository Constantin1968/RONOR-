/**
 * RONOR Runtime — L0 · HTTP Surface
 * ─────────────────────────────────
 * The unified request API. Mounted at `/api/runtime` alongside the existing
 * Core Active routers, which are left untouched so their contracts and their
 * tests continue to hold.
 *
 *   POST /query              submit a governed query
 *   POST /missions           open a mission
 *   GET  /missions           list missions
 *   GET  /missions/:id       mission state, findings and spend
 *   POST /agents/dispatch    run a multi-agent mission
 *   GET  /agents             agent registry and passports
 *   POST /knowledge/ingest   ingest documents through the governed pipeline
 *   GET  /providers          provider credential and health surface
 *   GET  /catalogue          model catalogue with live calibrated telemetry
 *   GET  /ledger/work        work ledger
 *   GET  /ledger/work/:id    one request with its provider attempts
 *   GET  /ledger/cost        cost-of-intelligence summary
 *   GET  /ledger/value       value summary
 *   GET  /audit              audit chain records
 *   GET  /audit/verify       chain integrity verification
 *   GET  /status             consolidated runtime status
 *   GET  /health             liveness and readiness (unauthenticated)
 *
 * `/health` is deliberately the ONLY unauthenticated route. A container
 * orchestrator cannot present a bearer token, and a health check that requires
 * one is a health check that reports the credential rather than the service.
 * Everything it discloses is non-sensitive by construction: counts, states and
 * booleans, never a key, a prompt or an answer.
 *
 * Prepared by AMB.
 */

import { Router, type Request, type Response } from 'express';
import {
  getHeadHash,
  countRecords,
  listRecords,
  verifyChain,
} from '../../audit/hash-chain';
import { getPolicyVersion } from '../../governance/mi9-gate';
import { insecureDefaultActive, listApiKeys, upsertApiKey, revokeApiKey } from './auth';
import { asyncHandler, rateLimit, requireArchitect, requireAuth } from './middleware';
import { runQueryPipeline, type QueryRequest } from './pipeline';
import { sanitiseFreeText, sanitiseIdentifier } from './sanitize';
import { providerStatuses } from '../providers/registry';
import { allTelemetry, telemetryFor } from '../router/calibrator';
import { listCatalogue } from '../router/catalogue';
import { attemptsFor, getWork, listWork } from '../ledgers/work-ledger';
import { getCostSummary, getValueSummary } from '../ledgers/cost-ledger';
import {
  appendToMission,
  appendMissionFabricEvent,
  createMission,
  getMissionFabric,
  getMission,
  listMissions,
  MissionFabricConflictError,
  MissionFabricIntegrityError,
  MissionFabricValidationError,
  setMissionStatus,
  verifyMissionFabric,
  type MissionFabricEventType,
} from '../mission/store';
import { ingestDocuments, knowledgeStatus } from '../knowledge/bridge';
import { dispatchMission, type MissionDispatchRequest } from '../agents/coordinator';
import { agentPassports } from '../agents/registry';
import { consumePendingExecution } from './approval-settlement';
import { managementAgents, getManagementAgent } from '../management/registry';
import { planExecutiveDelegation } from '../management/executive';
import { automationAdapterStatus, configuredAutomationAdapters } from '../automation/adapter-registry';
import { completedExecutionRun, executionRunId, runExecutiveMission } from '../automation/runner';
import { cancelAutomationRun, registerAutomationRun } from '../automation/run-control';
import { inspectAndValidateWorkspace } from '../automation/workspace';
import { createWorkspaceArtifactCollector } from '../automation/artifacts';
import { modelCabinet } from '../router/model-cabinet';
import { attestAutomationAdapters } from '../automation/attestation';
import { issueArchitectMandate, verifyMandateAuthority } from '../automation/mandate-issuer';
import { claimAutomationRun, getAutomationRunRecord, requestAutomationRunCancellation } from '../automation/run-lease';
import { launchAutomationRun } from '../automation/background-run';
import type { AutomationRun, ExecutionMandate } from '../automation/contracts';
import { createHttpPostExecutionVerifier } from '../automation/post-execution-verifier';
import { startAutomationRecoverySupervisor } from '../automation/recovery-supervisor';

export type RuntimeRouter = Router & { stopAutomationRecovery(): void };

/**
 * Build the runtime router.
 *
 * `env` exists so that a caller can state the credential and gateway
 * environment explicitly rather than inheriting whatever the host process
 * happens to export. Routing decisions are a function of live credential state
 * (P0_CREDENTIAL_PRESENT), so a surface that reads ambient `process.env` is a
 * surface whose behaviour changes between a developer machine and CI. It
 * defaults to `process.env`, so production wiring is unchanged.
 */
export function createRuntimeRouter(env: NodeJS.ProcessEnv = process.env): RuntimeRouter {
  const router = Router();

  const recoveryPreflight = async (mandate: ExecutionMandate): Promise<{
    objective: string; branch: string;
  } | null> => {
    if (env.RONOR_AUTOMATION_ENABLED !== 'true' || env.RONOR_AUTOMATION_RECOVERY_ENABLED !== 'true') return null;
    if (!env.RONOR_AUTOMATION_MANDATE_SIGNING_KEY ||
        !verifyMandateAuthority(mandate, env.RONOR_AUTOMATION_MANDATE_SIGNING_KEY)) return null;
    const mission = getMission(mandate.mission_id);
    if (!mission || !env.RONOR_AUTOMATION_WORKSPACE_ROOT || !env.RONOR_AUTOMATION_ARTIFACT_ROOT ||
        !env.RONOR_AUTOMATION_EXPECTED_ORIGIN || !env.RONOR_EVIDENCE_RUNNER_URL || !env.RONOR_EVIDENCE_RUNNER_TOKEN) return null;
    const workspace = inspectAndValidateWorkspace(mandate.workspace_root, {
      approved_root: env.RONOR_AUTOMATION_WORKSPACE_ROOT,
      branch_prefix: mandate.branch_prefix,
      expected_origin: env.RONOR_AUTOMATION_EXPECTED_ORIGIN,
      require_clean: false,
    });
    if (!workspace.valid || !workspace.snapshot) return null;
    try {
      await attestAutomationAdapters(env);
      const verifier = createHttpPostExecutionVerifier({ baseUrl: env.RONOR_EVIDENCE_RUNNER_URL, token: env.RONOR_EVIDENCE_RUNNER_TOKEN });
      await verifier.attest();
      createWorkspaceArtifactCollector(env.RONOR_AUTOMATION_ARTIFACT_ROOT);
    } catch { return null; }
    return { objective: mission.objective, branch: workspace.snapshot.branch };
  };

  const recoveryOwner = sanitiseIdentifier(env.RONOR_AUTOMATION_RECOVERY_OWNER, 120);
  if (env.RONOR_AUTOMATION_RECOVERY_ENABLED === 'true' && !recoveryOwner) {
    throw new Error('automation_recovery_owner_required');
  }
  if (env.RONOR_AUTOMATION_RECOVERY_ENABLED === 'true' &&
      (!env.RONOR_AUTOMATION_MANDATE_SIGNING_KEY || Buffer.byteLength(env.RONOR_AUTOMATION_MANDATE_SIGNING_KEY, 'utf8') < 32)) {
    throw new Error('automation_recovery_mandate_authority_required');
  }
  const recoverySupervisor = startAutomationRecoverySupervisor({
    enabled: env.RONOR_AUTOMATION_ENABLED === 'true' && env.RONOR_AUTOMATION_RECOVERY_ENABLED === 'true',
    owner: recoveryOwner ?? 'automation-recovery-disabled',
    intervalMs: Number(env.RONOR_AUTOMATION_RECOVERY_INTERVAL_MS ?? 30_000),
    leaseMs: Number(env.RONOR_AUTOMATION_LEASE_MS ?? 120_000),
    batchSize: Number(env.RONOR_AUTOMATION_RECOVERY_BATCH_SIZE ?? 5),
    preflight: async (candidate) => Boolean(await recoveryPreflight(candidate.mandate)),
    execute: async (runId, mandate, signal, attempt) => {
      const prepared = await recoveryPreflight(mandate);
      const adapters = configuredAutomationAdapters(env);
      if (!prepared || !adapters || !env.RONOR_AUTOMATION_ARTIFACT_ROOT || !env.RONOR_EVIDENCE_RUNNER_URL || !env.RONOR_EVIDENCE_RUNNER_TOKEN) throw new Error('automation_recovery_preflight_lost');
      const appendRecovery = (type: 'run.status_changed' | 'failure.recorded', payload: Record<string, unknown>) => {
        const fabric = getMissionFabric(mandate.mission_id);
        if (!fabric) throw new Error('automation_recovery_fabric_missing');
        appendMissionFabricEvent({
          missionId: mandate.mission_id, expectedVersion: fabric.version, type,
          actor: { kind: 'ronor', id: 'automation-recovery' }, payload,
        });
      };
      appendRecovery('run.status_changed', {
        id: runId, run_id: runId, mission_id: mandate.mission_id, stage: 'recovery', status: 'queued',
        attempt, reason_code: 'interrupted_lease_reclaimed', updated_at: new Date().toISOString(),
      });
      try {
        const run = await runExecutiveMission({
          objective: prepared.objective,
          workspaceRoot: mandate.workspace_root,
          branch: prepared.branch,
          mandate,
          adapters,
          signal,
          artifactCollector: createWorkspaceArtifactCollector(env.RONOR_AUTOMATION_ARTIFACT_ROOT),
          postExecutionVerifier: createHttpPostExecutionVerifier({ baseUrl: env.RONOR_EVIDENCE_RUNNER_URL, token: env.RONOR_EVIDENCE_RUNNER_TOKEN }),
        });
        return run.status;
      } catch {
        appendRecovery('failure.recorded', {
          id: `${runId}-recovery-${attempt}-failed`, run_id: runId, attempt,
          reason: 'automation_recovery_execution_failed',
        });
        appendRecovery('run.status_changed', {
          id: runId, run_id: runId, mission_id: mandate.mission_id, stage: 'recovery', status: 'failed',
          attempt, reason_code: 'automation_recovery_execution_failed', updated_at: new Date().toISOString(),
        });
        throw new Error('automation_recovery_execution_failed');
      }
    },
  });
  Object.defineProperty(router, 'stopAutomationRecovery', {
    enumerable: false, configurable: false, value: () => recoverySupervisor.stop(),
  });

  // -------------------------------------------------------------------------
  // Health — unauthenticated by design
  // -------------------------------------------------------------------------
  router.get(
    '/health',
    asyncHandler(async (_req: Request, res: Response) => {
      const providers = providerStatuses();
      const invocable = providers.filter((p) => p.invocable);
      const knowledge = await knowledgeStatus();
      const insecureKey = insecureDefaultActive();

      // READY requires at least one invocable provider. The deterministic core is
      // always invocable, so this asks the sharper question: is there a
      // GENERATIVE engine available? A runtime that can only do arithmetic is
      // live but not ready, and conflating the two would let a deployment with
      // no credentials pass a readiness probe.
      const generative = invocable.filter((p) => p.provider !== 'deterministic');
      const ready = generative.length > 0;

      res.status(ready ? 200 : 503).json({
        status: ready ? 'ready' : 'degraded',
        live: true,
        runtime: 'runtime-active',
        policy_version: getPolicyVersion(),
        providers: {
          total: providers.length,
          invocable: invocable.length,
          generative_invocable: generative.length,
          detail: providers.map((p) => ({
            provider: p.provider,
            state: p.credentialState,
            transport: p.transport,
          })),
        },
        knowledge: {
          enabled: knowledge.enabled,
          degradation_level: knowledge.degradationLevel,
          reason: knowledge.reason,
        },
        audit_chain: {
          records: countRecords(),
          head_hash: getHeadHash(),
        },
        // Surfaced continuously rather than logged once at boot, so a deployment
        // left on the shipped demo credential is visibly flagged.
        security_findings: insecureKey
          ? ['insecure-default-key: a shipped default API key is active — rotate RONOR_API_KEYS']
          : [],
        checked_at: new Date().toISOString(),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Query
  // -------------------------------------------------------------------------
  router.post(
    '/query',
    requireAuth('query'),
    rateLimit,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provenance = req.provenance;
      if (!provenance) {
        res.status(500).json({ ok: false, error: 'provenance_missing' });
        return;
      }

      const request: QueryRequest = {
        query: String(body.query ?? ''),
        task_type: typeof body.task_type === 'string' ? body.task_type : undefined,
        confidentiality_level: coerceConfidentiality(body.confidentiality_level),
        jurisdiction_pin: coerceJurisdiction(body.jurisdiction_pin),
        allowed_providers: coerceStringArray(body.allowed_providers),
        denied_providers: coerceStringArray(body.denied_providers),
        max_latency_ms: coercePositiveNumber(body.max_latency_ms),
        max_cost_usd: coercePositiveNumber(body.max_cost_usd),
        required_evidence_level: coercePositiveNumber(body.required_evidence_level),
        pin_model: typeof body.pin_model === 'string' ? body.pin_model : undefined,
        require_search: body.require_search === true,
        use_knowledge: body.use_knowledge !== false,
        mission_id: sanitiseIdentifier(body.mission_id),
        operator_id: sanitiseIdentifier(body.operator_id),
        system: sanitiseFreeText(body.system) ?? undefined,
        max_output_tokens: coercePositiveNumber(body.max_output_tokens),
        dry_run: body.dry_run === true,
      };

      const result = await runQueryPipeline(request, provenance, env);
      // 200 for an answer; 422 for a refusal that the caller can fix by changing
      // the request; 502 when every provider failed, because that is an upstream
      // fault and not the caller's error to correct.
      const status = result.ok
        ? 200
        : result.status === 'all-providers-failed'
          ? 502
          : 422;
      res.status(status).json(result);
    }),
  );

  // -------------------------------------------------------------------------
  // Human co-sign settlement
  // -------------------------------------------------------------------------
  router.post(
    '/approvals/:id/settle',
    requireAuth('query'),
    rateLimit,
    asyncHandler(async (req: Request, res: Response) => {
      const approvalId = sanitiseIdentifier(req.params.id);
      const decision = (req.body as Record<string, unknown> | undefined)?.decision;
      if (!approvalId || (decision !== 'approved' && decision !== 'rejected')) {
        res.status(400).json({ ok: false, error: 'invalid_settlement' });
        return;
      }
      const key = req.apiKey;
      if (!key) {
        res.status(401).json({ ok: false, error: 'unauthorised' });
        return;
      }
      const consumed = consumePendingExecution(approvalId, key.key_id);
      if (consumed.status !== 'ready') {
        const response = consumed.status === 'key-mismatch'
          ? { status: 403, error: 'approval_key_mismatch' }
          : consumed.status === 'expired'
            ? { status: 410, error: 'approval_expired' }
            : { status: 409, error: 'approval_missing_or_already_settled' };
        res.status(response.status).json({ ok: false, error: response.error });
        return;
      }
      if (decision === 'rejected') {
        res.json({ ok: true, settlement: 'rejected', request_id: consumed.record.decisionId });
        return;
      }

      const priorApproval = {
        decisionId: consumed.record.decisionId,
        approvedBy: key.label,
        approvedAtMs: Date.now(),
      };
      const result = consumed.record.execution.kind === 'query'
        ? await runQueryPipeline(
            consumed.record.execution.request,
            consumed.record.provenance,
            consumed.record.env,
            priorApproval,
          )
        : await dispatchMission(
            consumed.record.execution.request,
            consumed.record.provenance,
            consumed.record.env,
            priorApproval,
          );
      res.status(result.ok ? 200 : 422).json(result);
    }),
  );

  // -------------------------------------------------------------------------
  // Missions
  // -------------------------------------------------------------------------
  router.post(
    '/missions',
    requireAuth('query'),
    rateLimit,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const title = sanitiseFreeText(body.title, 300);
      const objective = sanitiseFreeText(body.objective, 4000);
      if (!title || !objective) {
        res.status(400).json({
          ok: false,
          error: 'invalid_request',
          message: 'Both `title` and `objective` are required.',
        });
        return;
      }
      const mission = createMission({
        title,
        objective,
        // Attribution is an authentication fact, never caller-supplied data.
        operatorId: req.apiKey?.label ?? null,
      });
      res.status(201).json({ ok: true, mission });
    }),
  );

  router.get(
    '/missions',
    requireAuth('read'),
    asyncHandler(async (req: Request, res: Response) => {
      const limit = coercePositiveNumber(req.query.limit) ?? 50;
      res.json({ ok: true, missions: listMissions(limit) });
    }),
  );

  router.get(
    '/missions/:id',
    requireAuth('read'),
    asyncHandler(async (req: Request, res: Response) => {
      const id = sanitiseIdentifier(req.params.id);
      const mission = id ? getMission(id) : null;
      if (!mission) {
        res.status(404).json({ ok: false, error: 'not_found', message: 'No such mission.' });
        return;
      }
      res.json({ ok: true, mission });
    }),
  );

  router.patch(
    '/missions/:id',
    requireAuth('query'),
    asyncHandler(async (req: Request, res: Response) => {
      const id = sanitiseIdentifier(req.params.id);
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (!id || !getMission(id)) {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      if (typeof body.status === 'string') {
        const allowed = ['open', 'executing', 'complete', 'failed', 'abandoned'];
        if (!allowed.includes(body.status)) {
          res.status(400).json({ ok: false, error: 'invalid_status', allowed });
          return;
        }
        setMissionStatus(id, body.status as 'open');
      }
      if (typeof body.note === 'string') {
        const note = sanitiseFreeText(body.note, 8000);
        if (note) appendToMission({ missionId: id, notes: { operator: note } });
      }
      res.json({ ok: true, mission: getMission(id) });
    }),
  );

  router.get(
    '/missions/:id/fabric',
    requireAuth('read'),
    asyncHandler(async (req: Request, res: Response) => {
      const id = sanitiseIdentifier(req.params.id);
      const fabric = id ? getMissionFabric(id) : null;
      if (!fabric) {
        res.status(404).json({ ok: false, error: 'not_found', message: 'No such mission.' });
        return;
      }
      res.json({ ok: true, fabric, integrity: verifyMissionFabric(id!) });
    }),
  );

  router.post(
    '/missions/:id/fabric/events',
    requireAuth('query'),
    rateLimit,
    asyncHandler(async (req: Request, res: Response) => {
      const id = sanitiseIdentifier(req.params.id);
      if (!id || !getMission(id)) {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const actorBody = body.actor && typeof body.actor === 'object'
        ? body.actor as Record<string, unknown>
        : {};
      // Authorship is bound to the authenticated principal. Body actor fields are
      // hints only and can never impersonate Merlin or another service.
      const actorId = req.apiKey?.label ?? null;
      const claimedKind = typeof actorBody.kind === 'string' ? actorBody.kind : 'agent';
      const serviceKind = ['codex', 'langgraph', 'openhands'].find(
        (kind) => claimedKind === kind && req.apiKey?.scopes.includes(`fabric:${kind}`),
      );
      const actorKind = req.apiKey?.role === 'architect'
        ? 'human'
        : serviceKind
          ? serviceKind
          : 'agent';
      const eventType = typeof body.type === 'string' ? body.type as MissionFabricEventType : null;
      const expectedVersion = typeof body.expected_version === 'number' && Number.isInteger(body.expected_version)
        ? body.expected_version
        : null;
      const payload = body.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload as Record<string, unknown>
        : null;
      if (!actorId || !eventType || expectedVersion === null || expectedVersion < 0 || !payload) {
        res.status(400).json({
          ok: false,
          error: 'invalid_request',
          message: '`type`, non-negative integer `expected_version`, `actor` and object `payload` are required.',
        });
        return;
      }
      try {
        const fabric = appendMissionFabricEvent({
          missionId: id,
          expectedVersion,
          actor: { kind: actorKind as 'human', id: actorId },
          type: eventType,
          payload,
        });
        res.status(201).json({ ok: true, fabric, integrity: verifyMissionFabric(id) });
      } catch (error) {
        if (error instanceof MissionFabricConflictError) {
          res.status(409).json({ ok: false, error: 'version_conflict', message: error.message });
          return;
        }
        if (error instanceof MissionFabricIntegrityError) {
          res.status(409).json({ ok: false, error: 'fabric_integrity_failure', message: 'Mission history failed integrity verification.' });
          return;
        }
        if (error instanceof MissionFabricValidationError) {
          res.status(400).json({ ok: false, error: 'invalid_event', message: error.message });
          return;
        }
        throw error;
      }
    }),
  );

  // -------------------------------------------------------------------------
  // Agents
  // -------------------------------------------------------------------------
  router.get(
    '/agents',
    requireAuth('read'),
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, agents: agentPassports() });
    }),
  );

  // -------------------------------------------------------------------------
  // CONTROL · Executive Intelligence Council
  // -------------------------------------------------------------------------
  router.get('/control/session', requireArchitect, (_req, res) => {
    res.json({ ok: true, interface: 'CONTROL', identity: 'merlin', role: 'architect' });
  });

  router.get('/control/overview', requireArchitect, (_req, res) => {
    const missions = listMissions(100);
    const integrity = missions.map((mission) => verifyMissionFabric(mission.mission_id));
    res.json({
      ok: true,
      architect: 'merlin',
      runtime: 'runtime-active',
      missions: {
        total: missions.length,
        active: missions.filter((mission) => ['open', 'executing'].includes(mission.status)).length,
        recent: missions.slice(0, 8),
      },
      fabric: {
        verified: integrity.filter((item) => item?.valid === true).length,
        failed: integrity.filter((item) => item?.valid === false).length,
      },
      council: { members: managementAgents().length },
      automation: { ...automationAdapterStatus(env), recovery: recoverySupervisor.snapshot() },
    });
  });

  router.get('/control/council', requireArchitect, (_req, res) => {
    res.json({ ok: true, architect: 'merlin', management: managementAgents() });
  });

  router.get('/control/automation/readiness', requireArchitect, rateLimit, asyncHandler(async (_req, res) => {
    const configured = automationAdapterStatus(env);
    if (!configured.configured) { res.status(503).json({ ok: false, automation: configured }); return; }
    try { await attestAutomationAdapters(env); }
    catch { res.status(503).json({ ok: false, error: 'automation_attestation_failed', automation: automationAdapterStatus(env) }); return; }
    res.json({ ok: true, automation: automationAdapterStatus(env) });
  }));

  router.get('/control/models', requireArchitect, (_req, res) => {
    res.json({ ok: true, cabinet: modelCabinet(env), providers: providerStatuses(env) });
  });

  router.post('/control/automation/plan', requireArchitect, rateLimit, asyncHandler(async (req, res) => {
    const objective = sanitiseFreeText((req.body as Record<string, unknown> | undefined)?.objective, 8000);
    if (!objective) { res.status(400).json({ ok: false, error: 'invalid_objective' }); return; }
    const configured = automationAdapterStatus(env);
    if (!configured.configured) { res.status(503).json({ ok: false, error: 'automation_not_ready', automation: configured }); return; }
    try { await attestAutomationAdapters(env); }
    catch { res.status(503).json({ ok: false, error: 'automation_attestation_failed' }); return; }
    const adapters = configuredAutomationAdapters(env);
    if (!adapters) { res.status(503).json({ ok: false, error: 'automation_attestation_expired' }); return; }
    const mission = createMission({ title: `LangGraph: ${objective.slice(0, 108)}`, objective, operatorId: 'merlin' });
    try {
      const assignments = await adapters.langgraph.plan(objective);
      let version = 0;
      for (const assignment of assignments) {
        appendMissionFabricEvent({
          missionId: mission.mission_id, expectedVersion: version++, type: 'task.upserted',
          actor: { kind: 'langgraph', id: 'langgraph' },
          payload: { id: assignment.id, assignee: 'openhands', role: 'isolated-implementer', status: 'planned', objective: assignment.instruction, actions: assignment.actions },
        });
      }
      res.status(201).json({ ok: true, mission_id: mission.mission_id, target: 'langgraph', assignments });
    } catch {
      const fabric = getMissionFabric(mission.mission_id);
      if (fabric) appendMissionFabricEvent({ missionId: mission.mission_id, expectedVersion: fabric.version, type: 'failure.recorded', actor: { kind: 'langgraph', id: 'langgraph' }, payload: { id: 'langgraph-plan-failed', reason: 'planning_failed_closed' } });
      res.status(503).json({ ok: false, error: 'langgraph_planning_failed' });
    }
  }));

  router.get('/control/council/:id', requireArchitect, (req, res) => {
    const id = sanitiseIdentifier(req.params.id);
    const member = id ? getManagementAgent(id) : null;
    if (!member) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, management_agent: member });
  });

  router.get('/control/missions/:id/fabric', requireArchitect, (req, res) => {
    const id = sanitiseIdentifier(req.params.id);
    const fabric = id ? getMissionFabric(id) : null;
    if (!id || !fabric) {
      res.status(404).json({ ok: false, error: 'not_found' });
      return;
    }
    res.json({ ok: true, fabric, integrity: verifyMissionFabric(id) });
  });

  router.post(
    '/control/executive/delegate',
    requireArchitect,
    rateLimit,
    asyncHandler(async (req, res) => {
      const objective = sanitiseFreeText((req.body as Record<string, unknown> | undefined)?.objective, 8000);
      if (!objective) {
        res.status(400).json({ ok: false, error: 'invalid_request', message: '`objective` is required.' });
        return;
      }
      const delegation = planExecutiveDelegation({ objective, operatorId: 'merlin' });
      res.status(201).json({ ok: true, delegation });
    }),
  );

  router.post(
    '/control/automation/run',
    requireArchitect,
    rateLimit,
    asyncHandler(async (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.approved !== true) {
        res.status(409).json({ ok: false, error: 'mandate_approval_required' });
        return;
      }
      if ('mandate' in body || 'objective' in body || 'issued_by' in body || 'allowed_actions' in body) {
        res.status(400).json({ ok: false, error: 'client_authority_fields_forbidden' });
        return;
      }
      const missionId = sanitiseIdentifier(body.mission_id, 120);
      const idempotencyKey = sanitiseIdentifier(req.header('idempotency-key') ?? body.idempotency_key, 120);
      const workspaceRoot = env.RONOR_AUTOMATION_WORKTREE || (typeof body.workspace_root === 'string' ? body.workspace_root : '');
      const branch = sanitiseIdentifier(env.RONOR_AUTOMATION_BRANCH || body.branch, 200);
      const mission = missionId ? getMission(missionId) : null;
      if (!mission || !workspaceRoot || !branch || !idempotencyKey || !req.apiKey) {
        res.status(400).json({ ok: false, error: 'invalid_automation_request' });
        return;
      }
      const configured = automationAdapterStatus(env);
      if (!configured.configured) {
        res.status(503).json({ ok: false, error: 'automation_not_ready', automation: automationAdapterStatus(env) });
        return;
      }
      const mandateSigningKey = env.RONOR_AUTOMATION_MANDATE_SIGNING_KEY;
      if (!mandateSigningKey || Buffer.byteLength(mandateSigningKey, 'utf8') < 32) {
        res.status(503).json({ ok: false, error: 'mandate_authority_not_configured' });
        return;
      }
      let mandate;
      try {
        const optionalNumber = (value: unknown) => value === undefined ? undefined : Number(value);
        mandate = issueArchitectMandate({
          missionId: mission.mission_id, objective: mission.objective, workspaceRoot, branch,
          architectKeyId: req.apiKey.key_id, idempotencyKey,
          maxCostUsd: optionalNumber(body.max_cost_usd),
          maxRuntimeMinutes: optionalNumber(body.max_runtime_minutes),
          maxFixCycles: optionalNumber(body.max_fix_cycles),
        }, {
          maxCostUsd: Number(env.RONOR_AUTOMATION_MAX_COST_USD ?? 5),
          maxRuntimeMinutes: Number(env.RONOR_AUTOMATION_MAX_RUNTIME_MINUTES ?? 60),
          maxFixCycles: Number(env.RONOR_AUTOMATION_MAX_FIX_CYCLES ?? 3),
        }, mandateSigningKey);
      } catch {
        res.status(422).json({ ok: false, error: 'mandate_policy_refused' });
        return;
      }
      if (!env.RONOR_AUTOMATION_WORKSPACE_ROOT) {
        res.status(503).json({ ok: false, error: 'workspace_policy_not_configured' });
        return;
      }
      if (!env.RONOR_AUTOMATION_ARTIFACT_ROOT) {
        res.status(503).json({ ok: false, error: 'artifact_policy_not_configured' });
        return;
      }
      const artifactRoot = env.RONOR_AUTOMATION_ARTIFACT_ROOT;
      if (!env.RONOR_EVIDENCE_RUNNER_URL || !env.RONOR_EVIDENCE_RUNNER_TOKEN) {
        res.status(503).json({ ok: false, error: 'isolated_evidence_runner_not_configured' });
        return;
      }
      let postExecutionVerifier;
      try {
        postExecutionVerifier = createHttpPostExecutionVerifier({ baseUrl: env.RONOR_EVIDENCE_RUNNER_URL, token: env.RONOR_EVIDENCE_RUNNER_TOKEN });
        await postExecutionVerifier.attest();
      } catch { res.status(503).json({ ok: false, error: 'isolated_evidence_runner_attestation_failed' }); return; }
      const workspace = inspectAndValidateWorkspace(workspaceRoot, {
        approved_root: env.RONOR_AUTOMATION_WORKSPACE_ROOT,
        branch_prefix: mandate.branch_prefix,
        expected_origin: env.RONOR_AUTOMATION_EXPECTED_ORIGIN,
        expected_head: env.RONOR_AUTOMATION_EXPECTED_HEAD,
        require_clean: true,
      });
      if (!workspace.valid || workspace.snapshot?.branch !== branch) {
        res.status(422).json({ ok: false, error: 'workspace_policy_refused', reason: workspace.valid ? 'branch_request_mismatch' : workspace.reason });
        return;
      }
      try { await attestAutomationAdapters(env); }
      catch { res.status(503).json({ ok: false, error: 'automation_attestation_failed' }); return; }
      const adapters = configuredAutomationAdapters(env);
      if (!adapters) { res.status(503).json({ ok: false, error: 'automation_attestation_expired' }); return; }
      const runId = executionRunId(mandate.mandate_id);
      if (!verifyMandateAuthority(mandate, mandateSigningKey)) {
        res.status(422).json({ ok: false, error: 'mandate_authority_invalid' });
        return;
      }
      const claim = claimAutomationRun({
        runId, mandate, owner: `${req.apiKey.key_id}:${req.provenance?.request_id ?? 'request'}`,
        leaseMs: Number(env.RONOR_AUTOMATION_LEASE_MS ?? 120_000),
      });
      if (claim.outcome === 'busy') { res.status(409).json({ ok: false, error: 'automation_run_already_active' }); return; }
      if (claim.outcome === 'conflict') { res.status(409).json({ ok: false, error: 'automation_mandate_conflict' }); return; }
      if (claim.outcome === 'mandate_expired') { res.status(422).json({ ok: false, error: 'automation_mandate_expired' }); return; }
      if (claim.outcome === 'fix_cycle_limit_exceeded') { res.status(422).json({ ok: false, error: 'fix_cycle_limit_exceeded' }); return; }
      if (claim.outcome === 'cancelled') { res.status(409).json({ ok: false, error: 'automation_run_cancelled' }); return; }
      mandate = claim.mandate;
      if (claim.outcome === 'completed') {
        const run = completedExecutionRun(mandate);
        if (!run) { res.status(409).json({ ok: false, error: 'automation_terminal_state_inconsistent' }); return; }
        res.status(200).json({ ok: true, run });
        return;
      }
      const control = registerAutomationRun(runId, mandate.mission_id);
      if (!control) {
        claim.lease.finish('failed');
        res.status(409).json({ ok: false, error: 'automation_run_already_active' });
        return;
      }
      claim.lease.startHeartbeat(() => control.abort());
      const queued: AutomationRun = {
        run_id: runId, mission_id: mandate.mission_id, status: 'queued', cost_usd: 0,
        completed_assignments: 0, total_assignments: 0, reason: null,
      };
      const fabric = getMissionFabric(mandate.mission_id)!;
      appendMissionFabricEvent({
        missionId: mandate.mission_id, expectedVersion: fabric.version, type: 'run.status_changed',
        actor: { kind: 'langgraph', id: 'langgraph' },
        payload: {
          id: runId, run_id: runId, mission_id: mandate.mission_id, stage: 'queue', status: 'queued',
          completed_assignments: 0, total_assignments: 0, cost_usd: 0, reason_code: null,
          updated_at: new Date().toISOString(),
        },
      });
      launchAutomationRun({
        lease: claim.lease,
        control,
        execute: async () => {
          const artifactCollector = createWorkspaceArtifactCollector(artifactRoot);
          return runExecutiveMission({ objective: mission.objective, workspaceRoot, branch, mandate, adapters, signal: control.signal, artifactCollector, postExecutionVerifier });
        },
        onUnhandledFailure: () => {
          const current = getMissionFabric(mandate.mission_id);
          if (!current) return;
          appendMissionFabricEvent({
            missionId: mandate.mission_id, expectedVersion: current.version, type: 'failure.recorded',
            actor: { kind: 'ronor', id: 'automation-supervisor' },
            payload: { id: `${runId}-unhandled`, run_id: runId, reason: 'automation_run_unhandled_failure' },
          });
          const failed = getMissionFabric(mandate.mission_id);
          if (!failed) return;
          appendMissionFabricEvent({
            missionId: mandate.mission_id, expectedVersion: failed.version, type: 'run.status_changed',
            actor: { kind: 'ronor', id: 'automation-supervisor' },
            payload: {
              id: runId, run_id: runId, mission_id: mandate.mission_id, stage: 'supervisor', status: 'failed',
              completed_assignments: 0, total_assignments: 0, cost_usd: 0,
              reason_code: 'automation_run_unhandled_failure', updated_at: new Date().toISOString(),
            },
          });
        },
      });
      res.status(202).json({ ok: true, accepted: true, run: queued });
    }),
  );

  router.get('/control/automation/runs/:runId', requireArchitect, rateLimit, (req, res) => {
    const runId = sanitiseIdentifier(req.params.runId, 120);
    const missionId = sanitiseIdentifier(req.query.mission_id, 120);
    if (!runId || !missionId) { res.status(400).json({ ok: false, error: 'invalid_run_status_request' }); return; }
    const record = getAutomationRunRecord(runId, missionId);
    const fabric = getMissionFabric(missionId);
    if (!record || !fabric) { res.status(404).json({ ok: false, error: 'automation_run_not_found' }); return; }
    res.json({ ok: true, run: record, fabric_run: fabric.runs[runId] ?? null });
  });

  router.post('/control/automation/runs/:runId/cancel', requireArchitect, rateLimit, (req, res) => {
    const runId = sanitiseIdentifier(req.params.runId, 120);
    const missionId = sanitiseIdentifier((req.body as Record<string, unknown> | undefined)?.mission_id, 120);
    if (!runId || !missionId) { res.status(400).json({ ok: false, error: 'invalid_cancel_request' }); return; }
    const durable = requestAutomationRunCancellation(runId, missionId);
    if (durable === 'not_found' || durable === 'mission_mismatch') { res.status(404).json({ ok: false, error: 'automation_run_not_found' }); return; }
    if (durable === 'not_active') { res.status(409).json({ ok: false, error: 'automation_run_not_active' }); return; }
    cancelAutomationRun(runId, missionId);
    const fabric = getMissionFabric(missionId);
    if (fabric) appendMissionFabricEvent({
      missionId, expectedVersion: fabric.version, type: 'run.cancel_requested',
      actor: { kind: 'human', id: 'merlin' },
      payload: { id: runId, run_id: runId, mission_id: missionId, status: 'cancel_requested', rollback: false },
    });
    res.status(202).json({ ok: true, status: 'cancellation_requested', rollback: false });
  });

  router.get(
    '/management',
    requireArchitect,
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, architect: 'merlin', management: managementAgents() });
    }),
  );

  router.get(
    '/management/:id',
    requireArchitect,
    asyncHandler(async (req: Request, res: Response) => {
      const id = sanitiseIdentifier(req.params.id);
      const member = id ? getManagementAgent(id) : null;
      if (!member) {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      res.json({ ok: true, management_agent: member });
    }),
  );

  router.post(
    '/management/executive/delegate',
    requireArchitect,
    rateLimit,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const objective = sanitiseFreeText(body.objective, 8000);
      if (!objective) {
        res.status(400).json({ ok: false, error: 'invalid_request', message: '`objective` is required.' });
        return;
      }
      const delegation = planExecutiveDelegation({
        objective,
        operatorId: req.apiKey?.label ?? 'merlin',
      });
      res.status(201).json({ ok: true, delegation });
    }),
  );

  router.post(
    '/agents/dispatch',
    requireAuth('agent'),
    rateLimit,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const provenance = req.provenance;
      if (!provenance) {
        res.status(500).json({ ok: false, error: 'provenance_missing' });
        return;
      }
      const objective = sanitiseFreeText(body.objective, 8000);
      if (!objective) {
        res.status(400).json({
          ok: false,
          error: 'invalid_request',
          message: '`objective` is required and must be a non-empty string.',
        });
        return;
      }

      const request: MissionDispatchRequest = {
        objective,
        mission_id: sanitiseIdentifier(body.mission_id),
        title: sanitiseFreeText(body.title, 300) ?? objective.slice(0, 120),
        confidentiality_level: coerceConfidentiality(body.confidentiality_level) ?? 'internal',
        jurisdiction_pin: coerceJurisdiction(body.jurisdiction_pin),
        max_cost_usd: coercePositiveNumber(body.max_cost_usd),
        max_tasks: coercePositiveNumber(body.max_tasks),
        operator_id: sanitiseIdentifier(body.operator_id) ?? req.apiKey?.label ?? null,
        use_knowledge: body.use_knowledge !== false,
        require_evidence: body.require_evidence !== false,
      };

      const result = await dispatchMission(request, provenance);
      res.status(result.ok ? 200 : 422).json(result);
    }),
  );

  // -------------------------------------------------------------------------
  // Knowledge ingestion
  // -------------------------------------------------------------------------
  router.post(
    '/knowledge/ingest',
    requireAuth('ingest'),
    rateLimit,
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = Array.isArray(body.documents) ? body.documents : null;
      if (!raw || raw.length === 0) {
        res.status(400).json({
          ok: false,
          error: 'invalid_request',
          message: '`documents` must be a non-empty array of { sourceUri, content }.',
        });
        return;
      }
      if (raw.length > 200) {
        res.status(413).json({
          ok: false,
          error: 'batch_too_large',
          message: 'A single ingestion batch is limited to 200 documents.',
        });
        return;
      }

      const documents = [];
      for (const item of raw as Array<Record<string, unknown>>) {
        const sourceUri = sanitiseFreeText(item.sourceUri, 2000);
        const content = typeof item.content === 'string' ? item.content : null;
        if (!sourceUri || !content) {
          res.status(400).json({
            ok: false,
            error: 'invalid_document',
            message: 'Every document requires a `sourceUri` and a string `content`.',
          });
          return;
        }
        documents.push({
          sourceUri,
          content,
          classification: coerceClassification(item.classification),
          sovereigntyTier: coerceTier(item.sovereigntyTier),
          sourceType: sanitiseFreeText(item.sourceType, 64) ?? undefined,
          ingestedBy: req.apiKey?.label ?? 'runtime-api',
        });
      }

      const outcome = await ingestDocuments(documents);
      // 207 when the batch was partially admitted: some documents ingested and
      // others refused or quarantined. Reporting that as 200 would hide a
      // quarantine, and as 400 would discard the documents that succeeded.
      res.status(outcome.available ? (outcome.ok ? 200 : 207) : 503).json({
        ...outcome,
        request_id: req.provenance?.request_id,
      });
    }),
  );

  router.get(
    '/knowledge/status',
    requireAuth('read'),
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, knowledge: await knowledgeStatus() });
    }),
  );

  // -------------------------------------------------------------------------
  // Providers and catalogue
  // -------------------------------------------------------------------------
  router.get(
    '/providers',
    requireAuth('read'),
    asyncHandler(async (_req: Request, res: Response) => {
      const statuses = providerStatuses();
      res.json({
        ok: true,
        providers: statuses.map((s) => ({
          ...s,
          // Per-model telemetry lets an operator see WHICH model of a provider is
          // degraded, which a provider-level roll-up would hide.
          telemetry: listCatalogue()
            .filter((c) => c.provider === s.provider)
            .map((c) => telemetryFor(c.id)),
        })),
      });
    }),
  );

  router.get(
    '/catalogue',
    requireAuth('read'),
    asyncHandler(async (_req: Request, res: Response) => {
      const statuses = new Map(providerStatuses().map((s) => [s.provider, s]));
      res.json({
        ok: true,
        models: listCatalogue().map((c) => {
          const t = telemetryFor(c.id);
          return {
            ...c,
            credential_state: statuses.get(c.provider)?.credentialState ?? 'key-absent',
            invocable: statuses.get(c.provider)?.invocable ?? false,
            observed_latency_ms: t.latencyMs,
            latency_observed: t.latencyObserved,
            success_rate: t.successRate,
            samples: t.samples,
          };
        }),
      });
    }),
  );

  router.get(
    '/telemetry',
    requireAuth('read'),
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, telemetry: allTelemetry() });
    }),
  );

  // -------------------------------------------------------------------------
  // Ledgers
  // -------------------------------------------------------------------------
  router.get(
    '/ledger/work',
    requireAuth('read'),
    asyncHandler(async (req: Request, res: Response) => {
      const limit = coercePositiveNumber(req.query.limit) ?? 50;
      const offset = coercePositiveNumber(req.query.offset) ?? 0;
      res.json({ ok: true, work: listWork(limit, offset) });
    }),
  );

  router.get(
    '/ledger/work/:id',
    requireAuth('read'),
    asyncHandler(async (req: Request, res: Response) => {
      const id = sanitiseIdentifier(req.params.id);
      const work = id ? getWork(id) : null;
      if (!work) {
        res.status(404).json({ ok: false, error: 'not_found' });
        return;
      }
      res.json({ ok: true, work, attempts: attemptsFor(work.request_id) });
    }),
  );

  router.get(
    '/ledger/cost',
    requireAuth('read'),
    asyncHandler(async (req: Request, res: Response) => {
      const since = typeof req.query.since === 'string' ? req.query.since : undefined;
      res.json({ ok: true, cost: getCostSummary(since) });
    }),
  );

  router.get(
    '/ledger/value',
    requireAuth('read'),
    asyncHandler(async (_req: Request, res: Response) => {
      res.json({ ok: true, value: getValueSummary() });
    }),
  );

  // -------------------------------------------------------------------------
  // Audit
  // -------------------------------------------------------------------------
  router.get(
    '/audit',
    requireAuth('read'),
    asyncHandler(async (req: Request, res: Response) => {
      const limit = coercePositiveNumber(req.query.limit) ?? 50;
      const offset = coercePositiveNumber(req.query.offset) ?? 0;
      res.json({
        ok: true,
        head_hash: getHeadHash(),
        total: countRecords(),
        records: listRecords(limit, offset),
      });
    }),
  );

  router.get(
    '/audit/verify',
    requireAuth('read'),
    asyncHandler(async (_req: Request, res: Response) => {
      const result = verifyChain();
      // 409 on a broken chain. A tampered audit chain is not a successful
      // request that happens to report bad news; it is a conflict between what
      // the chain claims and what it contains, and it should be impossible to
      // miss in a status dashboard.
      res.status(result.ok ? 200 : 409).json({ ok: result.ok, verification: result });
    }),
  );

  // -------------------------------------------------------------------------
  // Consolidated status
  // -------------------------------------------------------------------------
  router.get(
    '/status',
    requireAuth('read'),
    asyncHandler(async (_req: Request, res: Response) => {
      const providers = providerStatuses();
      const cost = getCostSummary();
      res.json({
        ok: true,
        runtime: 'runtime-active',
        policy_version: getPolicyVersion(),
        providers: {
          total: providers.length,
          invocable: providers.filter((p) => p.invocable).length,
          key_absent: providers.filter((p) => !p.invocable).map((p) => p.provider),
        },
        knowledge: await knowledgeStatus(),
        agents: agentPassports().map((a) => ({ id: a.agent_id, name: a.name, status: a.status })),
        economics: {
          total_requests: cost.total_requests,
          total_cost_usd: cost.total_cost_usd,
          wasted_cost_usd: cost.wasted_cost_usd,
          fallback_rate: cost.fallback_rate,
        },
        audit_chain: {
          records: countRecords(),
          head_hash: getHeadHash(),
        },
        value: getValueSummary(),
        security_findings: insecureDefaultActive()
          ? ['insecure-default-key: a shipped default API key is active']
          : [],
        generated_at: new Date().toISOString(),
      });
    }),
  );

  // -------------------------------------------------------------------------
  // Key administration — admin scope only
  // -------------------------------------------------------------------------
  router.get(
    '/admin/keys',
    requireAuth('admin'),
    asyncHandler(async (_req: Request, res: Response) => {
      // Returns metadata only. The secrets are not stored, so they cannot be
      // returned even by a caller entitled to see them.
      res.json({ ok: true, keys: listApiKeys() });
    }),
  );

  router.post(
    '/admin/keys',
    requireAuth('admin'),
    asyncHandler(async (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const secret = typeof body.secret === 'string' ? body.secret : null;
      const label = sanitiseFreeText(body.label, 120);
      if (!secret || secret.length < 24 || !label) {
        res.status(400).json({
          ok: false,
          error: 'invalid_request',
          message: '`label` and a `secret` of at least 24 characters are required.',
        });
        return;
      }
      const record = upsertApiKey({
        secret,
        label,
        role: body.role === 'admin' || body.role === 'readonly' ? body.role : 'operator',
        scopes: coerceStringArray(body.scopes),
        rateLimitRpm: coercePositiveNumber(body.rate_limit_rpm),
      });
      res.status(201).json({ ok: true, key: record });
    }),
  );

  router.delete(
    '/admin/keys/:keyId',
    requireAuth('admin'),
    asyncHandler(async (req: Request, res: Response) => {
      const keyId = sanitiseIdentifier(req.params.keyId);
      const revoked = keyId ? revokeApiKey(keyId) : false;
      res.status(revoked ? 200 : 404).json({ ok: revoked });
    }),
  );

  return router as RuntimeRouter;
}

// ---------------------------------------------------------------------------
// Coercion helpers
// ---------------------------------------------------------------------------

function coerceConfidentiality(v: unknown): QueryRequest['confidentiality_level'] {
  if (v === 'public' || v === 'internal' || v === 'restricted' || v === 'sovereign') return v;
  return undefined;
}

function coerceJurisdiction(v: unknown): QueryRequest['jurisdiction_pin'] {
  if (v === 'EU' || v === 'US' || v === 'sovereign' || v === 'any') return v;
  return undefined;
}

function coerceStringArray(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length < 128);
  return out.length ? out : undefined;
}

function coercePositiveNumber(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return undefined;
  return n;
}

function coerceClassification(
  v: unknown,
): 'PUBLIC' | 'INTERNAL' | 'CONFIDENTIAL' | 'RESTRICTED' | undefined {
  if (typeof v !== 'string') return undefined;
  const upper = v.toUpperCase();
  if (upper === 'PUBLIC' || upper === 'INTERNAL' || upper === 'CONFIDENTIAL' || upper === 'RESTRICTED') {
    return upper;
  }
  return undefined;
}

function coerceTier(v: unknown): 1 | 2 | 3 | undefined {
  if (v === 1 || v === 2 || v === 3) return v;
  if (v === '1') return 1;
  if (v === '2') return 2;
  if (v === '3') return 3;
  return undefined;
}
