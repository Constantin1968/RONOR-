import crypto from 'crypto';
import { request } from 'undici';
import { isAutomationAction, type AdapterResult, type EvidenceArtifact, type ExecutionMandate, type OpenHandsExecutionEnvelope, type PlannedAssignment, type VerificationEvidence, type VerificationReceipt, type VerificationVerdict } from '../contracts';
import { signExecutionCapability } from '../capability';
import { assertAutomationOutputSafe } from '../output-safety';
import { signModelBudget, type ModelBudgetContext } from '../model-budget';

type Fetcher = typeof fetch;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ASSIGNMENTS = 25;

export class AutomationAdapterError extends Error {
  constructor(message: string, readonly cost_usd: number | null = null) { super(message); }
}

function safeBaseUrl(value: string, plaintextServiceHosts: readonly string[] = []): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const internal = plaintextServiceHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash) throw new AutomationAdapterError('adapter_url_invalid');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || internal))) {
    throw new AutomationAdapterError('adapter_url_requires_https_or_loopback');
  }
  return url;
}

function cleanStrings(value: unknown, maximum = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, maximum).map((item) => item.slice(0, 2000));
}

// OpenHands /execute returns its headers only when the assignment finishes.
// Node fetch's implicit headers timeout must not pre-empt the signed deadline.
// Use request-scoped, finite limits, never a global dispatcher or unlimited wait.
async function deadlinePost(url: URL, init: RequestInit, timeoutMs: number): Promise<Response> {
  const result = await request(url, {
    method: 'POST', headers: init.headers as Record<string, string>,
    body: init.body as string, signal: init.signal,
    headersTimeout: Math.ceil(timeoutMs), bodyTimeout: Math.ceil(timeoutMs),
    maxRedirections: 0,
  });
  try {
    if (result.statusCode >= 300 && result.statusCode < 400) throw new AutomationAdapterError('adapter_redirect_refused');
    if (Number(result.headers['content-length'] ?? 0) > DEFAULT_MAX_RESPONSE_BYTES) {
      throw new AutomationAdapterError('adapter_response_too_large');
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    for await (const chunk of result.body) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += data.length;
      if (bytes > DEFAULT_MAX_RESPONSE_BYTES) throw new AutomationAdapterError('adapter_response_too_large');
      chunks.push(data);
    }
    return new Response(Buffer.concat(chunks).toString('utf8'), { status: result.statusCode });
  } finally {
    // Also release oversized, redirected and interrupted response streams.
    if (!result.body.destroyed) {
      // A refused response may not have an iterator/error listener yet.
      // Consume only the cleanup error; the original refusal is still thrown.
      result.body.on('error', () => {});
      result.body.destroy();
    }
  }
}

async function postJson(params: { baseUrl: string; path: string; token?: string; capability?: string; body: unknown; fetcher?: Fetcher; timeoutMs: number; signal?: AbortSignal; plaintextServiceHosts?: readonly string[] }): Promise<Record<string, unknown>> {
  const base = safeBaseUrl(params.baseUrl, params.plaintextServiceHosts);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if (!loopback && !params.token) throw new AutomationAdapterError('adapter_auth_required');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, params.timeoutMs);
  const cancel = () => controller.abort();
  params.signal?.addEventListener('abort', cancel, { once: true });
  if (params.signal?.aborted) cancel();
  try {
    const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
    const init: RequestInit = {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'content-type': 'application/json', ...(params.token ? { authorization: `Bearer ${params.token}` } : {}), ...(params.capability ? { 'x-ronor-capability': params.capability } : {}) },
      body: JSON.stringify(params.body),
    };
    const url = new URL(`${prefix}${params.path}`, base.origin);
    const response = params.fetcher
      ? await params.fetcher(url, init)
      : await deadlinePost(url, init, params.timeoutMs);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > DEFAULT_MAX_RESPONSE_BYTES) throw new AutomationAdapterError('adapter_response_too_large');
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > DEFAULT_MAX_RESPONSE_BYTES) throw new AutomationAdapterError('adapter_response_too_large');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new AutomationAdapterError('adapter_invalid_json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationAdapterError('adapter_invalid_json');
    if (!response.ok) {
      // A bounded, validated failure response still carries billable usage.
      const body = value as Record<string, unknown>;
      let cost: number | null = null;
      try { cost = parseAdapterResult(body).cost_usd; } catch { /* unknown, not zero */ }
      const safeCode = typeof body.error === 'string' && /^(?:openhands|adapter|capability|nonce)_[a-z0-9_]{1,80}$/.test(body.error)
        ? body.error : `adapter_http_${response.status}`;
      throw new AutomationAdapterError(safeCode, cost);
    }
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AutomationAdapterError) throw error;
    const aborted = controller.signal.aborted || Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    const transportTimeout = code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'UND_ERR_BODY_TIMEOUT';
    throw new AutomationAdapterError(transportTimeout || timedOut ? 'adapter_timeout' : aborted ? 'adapter_cancelled' : 'adapter_unreachable');
  } finally { clearTimeout(timer); params.signal?.removeEventListener('abort', cancel); }
}

export function createLangGraphAdapter(config: { baseUrl: string; token?: string; fetcher?: Fetcher; timeoutMs?: number; plaintextServiceHosts?: readonly string[] }) {
  return { async plan(objective: string, signal?: AbortSignal): Promise<PlannedAssignment[]> {
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/plan', token: config.token, body: { objective }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 30_000, signal, plaintextServiceHosts: config.plaintextServiceHosts });
    if (!Array.isArray(body.assignments)) throw new AutomationAdapterError('langgraph_assignments_missing');
    if (body.assignments.length === 0 || body.assignments.length > MAX_ASSIGNMENTS) throw new AutomationAdapterError('langgraph_assignment_count_invalid');
    const seen = new Set<string>();
    return body.assignments.map((raw) => {
      if (!raw || typeof raw !== 'object') throw new AutomationAdapterError('langgraph_assignment_invalid');
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(item.id) || seen.has(item.id) || typeof item.instruction !== 'string' || item.instruction.length === 0) throw new AutomationAdapterError('langgraph_assignment_invalid');
      seen.add(item.id);
      const actions = cleanStrings(item.actions, 20);
      if (actions.length === 0 || !actions.every(isAutomationAction)) throw new AutomationAdapterError('langgraph_action_invalid');
      return { id: item.id, instruction: item.instruction.slice(0, 8000), actions };
    });
  }};
}

export function createOpenHandsAdapter(config: { baseUrl: string; token?: string; capabilityKey?: string; fetcher?: Fetcher; timeoutMs?: number; plaintextServiceHosts?: readonly string[] }) {
  return { async execute(assignment: PlannedAssignment, mandate: ExecutionMandate, signal?: AbortSignal, budget?: ModelBudgetContext): Promise<AdapterResult> {
    if (!config.capabilityKey) throw new AutomationAdapterError('capability_key_required');
    const resume=mandate.recovery?.openhands_assignment_id===assignment.id ? {
      conversation_id:mandate.recovery.openhands_conversation_id,
      accounted_cost_usd:mandate.recovery.accounted_cost_usd,
    } : undefined;
    const capability = signExecutionCapability({
      audience: 'openhands-bridge', mandate_id: mandate.mandate_id, mission_id: mandate.mission_id,
      assignment_id: assignment.id, objective_hash: mandate.objective_hash,
      allowed_actions: assignment.actions, expires_at: mandate.expires_at, nonce: crypto.randomUUID(),
      ...(resume?{resume}:{}),
    }, config.capabilityKey);
    const envelope: OpenHandsExecutionEnvelope = {
      assignment_id: assignment.id, instruction: assignment.instruction, allowed_actions: assignment.actions,
      objective_hash: mandate.objective_hash, deadline: mandate.expires_at,
      ...(budget ? {budget_token: signModelBudget(mandate, budget, 'author', config.capabilityKey)} : {}),
      ...(resume?{resume}:{}),
    };
    try {
      // Transport grace only: the native client must stop work at the signed deadline.
      const remainingMs = Date.parse(envelope.deadline) - Date.now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) throw new AutomationAdapterError('openhands_deadline_expired', 0);
      const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/execute', token: config.token, capability, body: { envelope }, fetcher: config.fetcher, timeoutMs: Math.min(config.timeoutMs ?? Infinity, remainingMs + 10_000), signal, plaintextServiceHosts: config.plaintextServiceHosts });
      return parseAdapterResult(body);
    } catch (error) {
      if (error instanceof AutomationAdapterError && ['adapter_cancelled', 'adapter_timeout', 'adapter_unreachable'].includes(error.message)) {
        try {
          await postJson({
            baseUrl: config.baseUrl, path: '/v1/cancel', token: config.token, capability,
            body: { assignment_id: assignment.id }, fetcher: config.fetcher ?? fetch, timeoutMs: 5_000, plaintextServiceHosts: config.plaintextServiceHosts,
          });
        } catch { /* cancellation is best-effort at this boundary and still fails closed */ }
      }
      throw error;
    }
  }};
}

export function createCodexVerifierAdapter(config: { baseUrl: string; token?: string; capabilityKey?: string; fetcher?: Fetcher; timeoutMs?: number; plaintextServiceHosts?: readonly string[] }) {
  return { async verify(missionId: string, evidence: VerificationEvidence, signal?: AbortSignal, authorization?: {mandate: ExecutionMandate; budget: ModelBudgetContext}): Promise<VerificationVerdict> {
    if (authorization && (!config.capabilityKey || authorization.mandate.mission_id !== missionId)) throw new AutomationAdapterError('budget_authority_required', 0);
    const budget_token = authorization ? signModelBudget(authorization.mandate, authorization.budget, 'verifier', config.capabilityKey!) : undefined;
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/verify', token: config.token, body: { mission_id: missionId, evidence, budget_token }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 120_000, signal, plaintextServiceHosts: config.plaintextServiceHosts });
    const result = parseAdapterResult(body);
    if (body.verdict !== 'pass' && body.verdict !== 'fail') throw new AutomationAdapterError('codex_verdict_invalid', result.cost_usd);
    const receipt = parseVerificationReceipt(body.receipt);
    if (!receipt) throw new AutomationAdapterError('codex_receipt_invalid', result.cost_usd);
    return { ...result, verdict: body.verdict, receipt };
  }};
}

export function createAssuranceAdapter(config: { baseUrl: string; token?: string; fetcher?: Fetcher; timeoutMs?: number; plaintextServiceHosts?: readonly string[] }) {
  return { async accept(missionId: string, verdict: VerificationVerdict, evidence: VerificationEvidence, signal?: AbortSignal): Promise<VerificationVerdict> {
    const body = await postJson({
      baseUrl: config.baseUrl, path: '/v1/assure', token: config.token,
      body: { mission_id: missionId, verification: { verdict: verdict.verdict, summary: verdict.summary, evidence: verdict.evidence, receipt: verdict.receipt }, evidence },
      fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 120_000, signal, plaintextServiceHosts: config.plaintextServiceHosts,
    });
    const result = parseAdapterResult(body);
    if (body.verdict !== 'pass' && body.verdict !== 'fail') throw new AutomationAdapterError('assurance_verdict_invalid');
    return { ...result, verdict: body.verdict };
  }};
}

function parseVerificationReceipt(value: unknown): VerificationReceipt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  if (item.version !== 'ronor-codex-receipt/v1' || item.issuer !== 'codex-verifier' ||
      typeof item.mission_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(item.mission_id) ||
      (item.verdict !== 'pass' && item.verdict !== 'fail') ||
      typeof item.evidence_digest !== 'string' || !/^[a-f0-9]{64}$/.test(item.evidence_digest) ||
      typeof item.issued_at !== 'string' || !Number.isFinite(Date.parse(item.issued_at)) ||
      typeof item.signature !== 'string' || !/^[A-Za-z0-9_-]{80,120}$/.test(item.signature)) return null;
  return item as unknown as VerificationReceipt;
}

function parseAdapterResult(body: Record<string, unknown>): AdapterResult {
  try { assertAutomationOutputSafe(body); }
  catch { throw new AutomationAdapterError('adapter_sensitive_output_refused'); }
  if (typeof body.ok !== 'boolean' || typeof body.summary !== 'string' ||
      (body.cost_usd !== null && (typeof body.cost_usd !== 'number' || !Number.isFinite(body.cost_usd) || body.cost_usd < 0))) {
    throw new AutomationAdapterError('adapter_result_invalid');
  }
  const artifacts: EvidenceArtifact[] = [];
  if (body.artifacts !== undefined) {
    if (!Array.isArray(body.artifacts) || body.artifacts.length > 50) throw new AutomationAdapterError('adapter_artifacts_invalid');
    for (const raw of body.artifacts) {
      if (!raw || typeof raw !== 'object') throw new AutomationAdapterError('adapter_artifacts_invalid');
      const item = raw as Record<string, unknown>;
      if (!['git_diff', 'git_status', 'test_report', 'event_log'].includes(String(item.kind)) ||
          typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256) ||
          typeof item.reference !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/.test(item.reference) || item.reference.includes('..') ||
          typeof item.bytes !== 'number' || !Number.isSafeInteger(item.bytes) || item.bytes < 0) {
        throw new AutomationAdapterError('adapter_artifacts_invalid');
      }
      artifacts.push({ kind: item.kind as EvidenceArtifact['kind'], sha256: item.sha256, reference: item.reference, bytes: item.bytes });
    }
  }
  return { ok: body.ok, summary: body.summary.slice(0, 4000), evidence: cleanStrings(body.evidence), artifacts, cost_usd: body.cost_usd };
}
