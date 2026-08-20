import crypto from 'crypto';
import { isAutomationAction, type AdapterResult, type EvidenceArtifact, type ExecutionMandate, type OpenHandsExecutionEnvelope, type PlannedAssignment, type VerificationEvidence, type VerificationVerdict } from '../contracts';
import { signExecutionCapability } from '../capability';

type Fetcher = typeof fetch;
const DEFAULT_MAX_RESPONSE_BYTES = 256 * 1024;
const MAX_ASSIGNMENTS = 25;

export class AutomationAdapterError extends Error {}

function safeBaseUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new AutomationAdapterError('adapter_url_requires_https_or_loopback');
  }
  return url;
}

function cleanStrings(value: unknown, maximum = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, maximum).map((item) => item.slice(0, 2000));
}

async function postJson(params: { baseUrl: string; path: string; token?: string; capability?: string; body: unknown; fetcher: Fetcher; timeoutMs: number; signal?: AbortSignal }): Promise<Record<string, unknown>> {
  const base = safeBaseUrl(params.baseUrl);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if (!loopback && !params.token) throw new AutomationAdapterError('adapter_auth_required');
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, params.timeoutMs);
  const cancel = () => controller.abort();
  params.signal?.addEventListener('abort', cancel, { once: true });
  try {
    const prefix = base.pathname === '/' ? '' : base.pathname.replace(/\/$/, '');
    const response = await params.fetcher(new URL(`${prefix}${params.path}`, base.origin), {
      method: 'POST', signal: controller.signal, redirect: 'error',
      headers: { 'content-type': 'application/json', ...(params.token ? { authorization: `Bearer ${params.token}` } : {}), ...(params.capability ? { 'x-ronor-capability': params.capability } : {}) },
      body: JSON.stringify(params.body),
    });
    if (!response.ok) throw new AutomationAdapterError(`adapter_http_${response.status}`);
    const contentLength = Number(response.headers.get('content-length') ?? 0);
    if (contentLength > DEFAULT_MAX_RESPONSE_BYTES) throw new AutomationAdapterError('adapter_response_too_large');
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > DEFAULT_MAX_RESPONSE_BYTES) throw new AutomationAdapterError('adapter_response_too_large');
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new AutomationAdapterError('adapter_invalid_json'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AutomationAdapterError('adapter_invalid_json');
    return value as Record<string, unknown>;
  } catch (error) {
    if (error instanceof AutomationAdapterError) throw error;
    const aborted = Boolean(error && typeof error === 'object' && 'name' in error && error.name === 'AbortError');
    throw new AutomationAdapterError(aborted ? (timedOut ? 'adapter_timeout' : 'adapter_cancelled') : 'adapter_unreachable');
  } finally { clearTimeout(timer); params.signal?.removeEventListener('abort', cancel); }
}

export function createLangGraphAdapter(config: { baseUrl: string; token?: string; fetcher?: Fetcher; timeoutMs?: number }) {
  return { async plan(objective: string, signal?: AbortSignal): Promise<PlannedAssignment[]> {
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/plan', token: config.token, body: { objective }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 30_000, signal });
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

export function createOpenHandsAdapter(config: { baseUrl: string; token?: string; capabilityKey?: string; fetcher?: Fetcher; timeoutMs?: number }) {
  return { async execute(assignment: PlannedAssignment, mandate: ExecutionMandate, signal?: AbortSignal): Promise<AdapterResult> {
    if (!config.capabilityKey) throw new AutomationAdapterError('capability_key_required');
    const capability = signExecutionCapability({
      audience: 'openhands-bridge', mandate_id: mandate.mandate_id, mission_id: mandate.mission_id,
      assignment_id: assignment.id, objective_hash: mandate.objective_hash,
      allowed_actions: assignment.actions, expires_at: mandate.expires_at, nonce: crypto.randomUUID(),
    }, config.capabilityKey);
    const envelope: OpenHandsExecutionEnvelope = {
      assignment_id: assignment.id, instruction: assignment.instruction, allowed_actions: assignment.actions,
      objective_hash: mandate.objective_hash, deadline: mandate.expires_at,
    };
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/execute', token: config.token, capability, body: { envelope }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 120_000, signal });
    return parseAdapterResult(body);
  }};
}

export function createCodexVerifierAdapter(config: { baseUrl: string; token?: string; fetcher?: Fetcher; timeoutMs?: number }) {
  return { async verify(missionId: string, evidence: VerificationEvidence, signal?: AbortSignal): Promise<VerificationVerdict> {
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/verify', token: config.token, body: { mission_id: missionId, evidence }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 120_000, signal });
    const result = parseAdapterResult(body);
    if (body.verdict !== 'pass' && body.verdict !== 'fail') throw new AutomationAdapterError('codex_verdict_invalid');
    return { ...result, verdict: body.verdict };
  }};
}

export function createAssuranceAdapter(config: { baseUrl: string; token?: string; fetcher?: Fetcher; timeoutMs?: number }) {
  return { async accept(missionId: string, verdict: VerificationVerdict, evidence: VerificationEvidence, signal?: AbortSignal): Promise<VerificationVerdict> {
    const body = await postJson({
      baseUrl: config.baseUrl, path: '/v1/assure', token: config.token,
      body: { mission_id: missionId, verification: { verdict: verdict.verdict, summary: verdict.summary, evidence: verdict.evidence }, evidence },
      fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 120_000, signal,
    });
    const result = parseAdapterResult(body);
    if (body.verdict !== 'pass' && body.verdict !== 'fail') throw new AutomationAdapterError('assurance_verdict_invalid');
    return { ...result, verdict: body.verdict };
  }};
}

function parseAdapterResult(body: Record<string, unknown>): AdapterResult {
  if (typeof body.ok !== 'boolean' || typeof body.summary !== 'string' || typeof body.cost_usd !== 'number' || !Number.isFinite(body.cost_usd) || body.cost_usd < 0) {
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
