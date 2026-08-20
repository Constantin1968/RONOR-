import crypto from 'crypto';
import { isAutomationAction, type AdapterResult, type ExecutionMandate, type PlannedAssignment, type VerificationVerdict } from '../contracts';
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
  url.pathname = url.pathname.replace(/\/$/, '');
  return url;
}

function cleanStrings(value: unknown, maximum = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string').slice(0, maximum).map((item) => item.slice(0, 2000));
}

async function postJson(params: { baseUrl: string; path: string; token?: string; capability?: string; body: unknown; fetcher: Fetcher; timeoutMs: number }): Promise<Record<string, unknown>> {
  const base = safeBaseUrl(params.baseUrl);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(base.hostname);
  if (!loopback && !params.token) throw new AutomationAdapterError('adapter_auth_required');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await params.fetcher(new URL(base.pathname + params.path, base.origin), {
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
    throw new AutomationAdapterError(error instanceof Error && error.name === 'AbortError' ? 'adapter_timeout' : 'adapter_unreachable');
  } finally { clearTimeout(timer); }
}

export function createLangGraphAdapter(config: { baseUrl: string; token?: string; fetcher?: Fetcher; timeoutMs?: number }) {
  return { async plan(objective: string): Promise<PlannedAssignment[]> {
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/plan', token: config.token, body: { objective }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 30_000 });
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
  return { async execute(assignment: PlannedAssignment, mandate: ExecutionMandate): Promise<AdapterResult> {
    if (!config.capabilityKey) throw new AutomationAdapterError('capability_key_required');
    const capability = signExecutionCapability({
      audience: 'openhands-bridge', mandate_id: mandate.mandate_id, mission_id: mandate.mission_id,
      assignment_id: assignment.id, objective_hash: mandate.objective_hash,
      allowed_actions: assignment.actions, expires_at: mandate.expires_at, nonce: crypto.randomUUID(),
    }, config.capabilityKey);
    const envelope = {
      assignment_id: assignment.id, instruction: assignment.instruction, allowed_actions: assignment.actions,
      objective_hash: mandate.objective_hash, deadline: mandate.expires_at,
    };
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/execute', token: config.token, capability, body: { envelope }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 120_000 });
    return parseAdapterResult(body);
  }};
}

export function createCodexVerifierAdapter(config: { baseUrl: string; token?: string; fetcher?: Fetcher; timeoutMs?: number }) {
  return { async verify(missionId: string, evidence: string[]): Promise<VerificationVerdict> {
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/verify', token: config.token, body: { mission_id: missionId, evidence }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 120_000 });
    const result = parseAdapterResult(body);
    if (body.verdict !== 'pass' && body.verdict !== 'fail') throw new AutomationAdapterError('codex_verdict_invalid');
    return { ...result, verdict: body.verdict };
  }};
}

function parseAdapterResult(body: Record<string, unknown>): AdapterResult {
  if (typeof body.ok !== 'boolean' || typeof body.summary !== 'string' || typeof body.cost_usd !== 'number' || !Number.isFinite(body.cost_usd) || body.cost_usd < 0) {
    throw new AutomationAdapterError('adapter_result_invalid');
  }
  return { ok: body.ok, summary: body.summary.slice(0, 4000), evidence: cleanStrings(body.evidence), cost_usd: body.cost_usd };
}
