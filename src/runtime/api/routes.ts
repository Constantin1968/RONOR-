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
import { asyncHandler, rateLimit, requireAuth } from './middleware';
import { runQueryPipeline, type QueryRequest } from './pipeline';
import { sanitiseFreeText, sanitiseIdentifier } from './sanitize';
import { providerStatuses } from '../providers/registry';
import { allTelemetry, telemetryFor } from '../router/calibrator';
import { listCatalogue } from '../router/catalogue';
import { attemptsFor, getWork, listWork } from '../ledgers/work-ledger';
import { getCostSummary, getValueSummary } from '../ledgers/cost-ledger';
import {
  appendToMission,
  createMission,
  getMission,
  listMissions,
  setMissionStatus,
} from '../mission/store';
import { ingestDocuments, knowledgeStatus } from '../knowledge/bridge';
import { dispatchMission, type MissionDispatchRequest } from '../agents/coordinator';
import { agentPassports } from '../agents/registry';

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
export function createRuntimeRouter(env: NodeJS.ProcessEnv = process.env): Router {
  const router = Router();

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
        operatorId: sanitiseIdentifier(body.operator_id) ?? req.apiKey?.label ?? null,
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

  return router;
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
