import type { AdapterResult, ExecutionMandate, PlannedAssignment, VerificationVerdict } from '../contracts';

type Fetcher = typeof fetch;

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

async function postJson(params: { baseUrl: string; path: string; token?: string; body: unknown; fetcher: Fetcher; timeoutMs: number }): Promise<Record<string, unknown>> {
  const base = safeBaseUrl(params.baseUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);
  try {
    const response = await params.fetcher(new URL(base.pathname + params.path, base.origin), {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', ...(params.token ? { authorization: `Bearer ${params.token}` } : {}) },
      body: JSON.stringify(params.body),
    });
    if (!response.ok) throw new AutomationAdapterError(`adapter_http_${response.status}`);
    const value: unknown = await response.json();
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
    return body.assignments.map((raw) => {
      if (!raw || typeof raw !== 'object') throw new AutomationAdapterError('langgraph_assignment_invalid');
      const item = raw as Record<string, unknown>;
      if (typeof item.id !== 'string' || typeof item.instruction !== 'string') throw new AutomationAdapterError('langgraph_assignment_invalid');
      return { id: item.id.slice(0, 120), instruction: item.instruction.slice(0, 8000), actions: cleanStrings(item.actions, 20) as PlannedAssignment['actions'] };
    });
  }};
}

export function createOpenHandsAdapter(config: { baseUrl: string; token?: string; fetcher?: Fetcher; timeoutMs?: number }) {
  return { async execute(assignment: PlannedAssignment, mandate: ExecutionMandate): Promise<AdapterResult> {
    const body = await postJson({ baseUrl: config.baseUrl, path: '/v1/execute', token: config.token, body: { assignment, mandate }, fetcher: config.fetcher ?? fetch, timeoutMs: config.timeoutMs ?? 120_000 });
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
