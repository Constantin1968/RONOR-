import crypto from 'crypto';
import type { AdapterResult, OpenHandsExecutionEnvelope } from '../contracts';
import type { NativeOpenHandsPort } from '../services/openhands-bridge';
import { evaluateOpenHandsEffects } from '../effect-policy';
import { MODEL_RATE_CARD } from '../model-budget';

type Fetcher = typeof fetch;
const MAX_NATIVE_RESPONSE_BYTES = 256 * 1024;
const CONTAINER_WORKSPACE = '/workspace/project';

export class NativeOpenHandsError extends Error {}

function baseUrl(value: string, plaintextServiceHosts: readonly string[]): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  const internal = plaintextServiceHosts.some((host) => host.toLowerCase() === url.hostname.toLowerCase());
  if (url.username || url.password || url.search || url.hash || (url.pathname !== '/' && url.pathname !== '')) throw new NativeOpenHandsError('openhands_url_invalid');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (loopback || internal))) throw new NativeOpenHandsError('openhands_url_requires_https_or_trusted_service');
  return url;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new NativeOpenHandsError('openhands_invalid_response');
  return value as Record<string, unknown>;
}

/** Agent Server reports costs under usage_to_metrics, not state.cost_usd.
 * Unpriced non-empty token usage is UNKNOWN, not a zero-dollar execution.
 */
export function nativeOpenHandsCost(state: Record<string, unknown>): number | null {
  const number = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
  const stats = state.stats as { usage_to_metrics?: Record<string, {
    accumulated_cost?: unknown; costs?: unknown[];
    accumulated_token_usage?: { prompt_tokens?: unknown; completion_tokens?: unknown };
  }> } | undefined;
  const metrics = stats?.usage_to_metrics;
  if (metrics && typeof metrics === 'object' && Object.keys(metrics).length) {
    let total = 0;
    for (const metric of Object.values(metrics)) {
      if (!metric || !number(metric.accumulated_cost)) return null;
      const usage = metric.accumulated_token_usage;
      if (!usage || !number(usage.prompt_tokens) || !number(usage.completion_tokens)) return null;
      if (usage.prompt_tokens + usage.completion_tokens > 0 &&
          (metric.accumulated_cost === 0 || !Array.isArray(metric.costs) || metric.costs.length === 0)) return null;
      total += metric.accumulated_cost;
    }
    return Number.isFinite(total) ? total : null;
  }
  // Compatibility with older explicit-cost servers; no missing-field fallback.
  return number(state.cost_usd) ? state.cost_usd : null;
}

export function nativeOpenHandsCatalogCost(state: Record<string, unknown>): number | null {
  const stats = state.stats as {usage_to_metrics?: Record<string,{
    model_name?: string; accumulated_token_usage?: {prompt_tokens?: unknown;completion_tokens?: unknown};
  }>} | undefined;
  if (!stats?.usage_to_metrics || !Object.keys(stats.usage_to_metrics).length) return null;
  let microUsd = 0;
  for (const metric of Object.values(stats.usage_to_metrics)) {
    const input = metric.accumulated_token_usage?.prompt_tokens;
    const output = metric.accumulated_token_usage?.completion_tokens;
    if (metric.model_name !== `openai/${MODEL_RATE_CARD.model}` || typeof input !== 'number' ||
        typeof output !== 'number' || !Number.isSafeInteger(input) || input < 0 || !Number.isSafeInteger(output) || output < 0) return null;
    microUsd += input * MODEL_RATE_CARD.inputMicroUsd + output * MODEL_RATE_CARD.outputMicroUsd;
  }
  return Number.isSafeInteger(microUsd) ? microUsd / 1e6 : null;
}

export function createNativeOpenHandsClient(config: {
  baseUrl: string;
  sessionApiKey: string;
  fetcher?: Fetcher;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  plaintextServiceHosts?: readonly string[];
  now?: () => number;
  llm?: { model: string; apiKey: string; baseUrl: string; apiMode?: 'chat' | 'responses' | 'auto';
    inputCostPerToken?: number; outputCostPerToken?: number };
  catalogAccounting?: boolean;
}): NativeOpenHandsPort & { health(): Promise<boolean> } {
  if (!config.sessionApiKey) throw new NativeOpenHandsError('openhands_session_key_required');
  const base = baseUrl(config.baseUrl, config.plaintextServiceHosts ?? []);
  const fetcher = config.fetcher ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const readCost = config.catalogAccounting ? nativeOpenHandsCatalogCost : nativeOpenHandsCost;

  const call = async (path: string, method: 'GET' | 'POST', body?: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, signal, redirect: 'error', headers: { 'X-Session-API-Key': config.sessionApiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      if (signal?.aborted) throw new NativeOpenHandsError('openhands_cancelled');
      throw new NativeOpenHandsError('openhands_unreachable');
    }
    if (!response.ok) throw new NativeOpenHandsError(`openhands_http_${response.status}`);
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_NATIVE_RESPONSE_BYTES) throw new NativeOpenHandsError('openhands_response_too_large');
    try { return object(JSON.parse(raw)); } catch (error) { if (error instanceof NativeOpenHandsError) throw error; throw new NativeOpenHandsError('openhands_invalid_response'); }
  };

  return {
    async health() {
      try { const ready = await call('/health', 'GET'); return ready.ready === true || ready.status === 'ready' || ready.status === 'ok' || ready.ok === true; }
      catch { return false; }
    },
    async execute(envelope: OpenHandsExecutionEnvelope, signal?: AbortSignal): Promise<AdapterResult> {
      const now = config.now ?? Date.now;
      const remainingMs = Date.parse(envelope.deadline) - now();
      if (!Number.isFinite(remainingMs) || remainingMs <= 0) {
        return { ok: false, summary: 'openhands_deadline_expired', evidence: [], cost_usd: 0 };
      }
      const deadlineSignal = AbortSignal.timeout(Math.min(remainingMs, 2_147_483_647));
      const executionSignal = signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal;
      let conversationId: string | null = null;
      let cost: number | null = 0;
      const finish = (ok: boolean, summary: string): AdapterResult => ({
        ok: ok && cost !== null, summary: cost === null && ok ? 'openhands_cost_unknown' : summary,
        evidence: conversationId ? [`conversation:${conversationId}`] : [], cost_usd: cost,
      });
      const pauseAndAccount = async (): Promise<boolean> => {
        if (!conversationId) return false;
        try {
          await call(`/api/conversations/${conversationId}/pause`, 'POST', {}, AbortSignal.timeout(4_000));
          const final = await call(`/api/conversations/${conversationId}`, 'GET', undefined, AbortSignal.timeout(4_000));
          cost = readCost(final);
          return ['paused', 'finished', 'complete', 'completed', 'error', 'failed', 'stopped', 'stuck'].includes(String(final.execution_status).toLowerCase());
        } catch { cost = null; return false; }
      };
      const waitForNextPoll = async () => {
        if (executionSignal.aborted) throw new NativeOpenHandsError('openhands_cancelled');
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => { cleanup(); reject(new NativeOpenHandsError('openhands_cancelled')); };
          const cleanup = () => executionSignal.removeEventListener('abort', cancelled);
          executionSignal.addEventListener('abort', cancelled, { once: true });
          sleep(config.pollIntervalMs ?? 1000).then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
        });
      };
      try {
        if (executionSignal.aborted) return finish(false, 'openhands_cancelled');
        // A failed create response may still have created a billable conversation.
        cost = null;
        const created = await call('/api/conversations', 'POST', {
          workspace: { kind: 'LocalWorkspace', working_dir: CONTAINER_WORKSPACE },
          confirmation_policy: { kind: 'AlwaysConfirm' }, max_iterations: 100,
          ...(config.llm ? { agent_settings: {
            agent_kind: 'openhands',
            llm: { model: config.llm.model, api_key: config.llm.apiKey, base_url: config.llm.baseUrl, api_mode: config.llm.apiMode ?? 'chat',
              ...(envelope.budget_token ? {extra_headers:{'x-ronor-budget':envelope.budget_token},max_output_tokens:4096} : {}),
              ...(config.llm.inputCostPerToken !== undefined ? {input_cost_per_token:config.llm.inputCostPerToken,
                output_cost_per_token:config.llm.outputCostPerToken} : {}) },
          } } : {}),
        }, executionSignal);
        conversationId = typeof created.conversation_id === 'string' ? created.conversation_id : typeof created.id === 'string' ? created.id : null;
        if (!conversationId || !/^[A-Za-z0-9-]{1,120}$/.test(conversationId)) throw new NativeOpenHandsError('openhands_conversation_id_invalid');
        await call(`/api/conversations/${conversationId}/events`, 'POST', {
          role: 'user', content: [{ type: 'text', text: envelope.instruction }], run: true,
        }, executionSignal);
        const maxPolls = config.maxPolls ?? Infinity;
        for (let poll = 0; poll < maxPolls; poll += 1) {
          if (executionSignal.aborted) throw new NativeOpenHandsError('openhands_cancelled');
          const state = await call(`/api/conversations/${conversationId}`, 'GET', undefined, executionSignal);
          cost = readCost(state);
        const status = String(state.execution_status ?? '').toLowerCase();
        if (cost === null && !['finished', 'complete', 'completed', 'error', 'failed', 'stopped', 'stuck', 'paused'].includes(status)) {
          const paused = await pauseAndAccount();
          return finish(false, paused ? 'openhands_cost_unknown' : 'openhands_pause_unconfirmed');
        }
        if (status === 'waiting_for_confirmation') {
          const events = await call(`/api/conversations/${conversationId}/events/search?limit=100`, 'GET', undefined, executionSignal);
          const decision = evaluateOpenHandsEffects(events, envelope.allowed_actions);
          await call(`/api/conversations/${conversationId}/events/respond_to_confirmation`, 'POST', {
            accept: decision.allowed, reason: decision.allowed ? 'Approved by bounded RONOR effect policy.' : 'Rejected by bounded RONOR effect policy.',
          }, executionSignal);
          if (!decision.allowed) {
            const paused = await pauseAndAccount();
            return finish(false, paused ? `openhands_action_refused_${decision.reason}` : 'openhands_pause_unconfirmed');
          }
          continue;
        }
        if (['error', 'failed', 'stopped', 'stuck', 'paused'].includes(status)) return finish(false, `openhands_terminated_${status}`);
        if (['finished', 'complete', 'completed'].includes(status)) {
          const events = await call(`/api/conversations/${conversationId}/events/search?limit=100`, 'GET', undefined, executionSignal);
          const serialized = JSON.stringify(events);
          const digest = crypto.createHash('sha256').update(serialized).digest('hex');
          return {
            ...finish(true, 'openhands_completed'),
            artifacts: [{ kind: 'event_log', sha256: digest, reference: `api/conversations/${conversationId}/events/search`, bytes: Buffer.byteLength(serialized) }],
          };
        }
          await waitForNextPoll();
        }
        const paused = await pauseAndAccount();
        return finish(false, paused ? 'openhands_poll_limit_paused' : 'openhands_pause_unconfirmed');
      } catch (error) {
        const paused = await pauseAndAccount();
        const reason = deadlineSignal.aborted ? 'openhands_deadline_expired' : signal?.aborted ? 'openhands_cancelled'
          : error instanceof NativeOpenHandsError && /^openhands_[a-z0-9_]{1,80}$/.test(error.message) ? error.message : 'openhands_failed';
        return finish(false, conversationId && !paused ? 'openhands_pause_unconfirmed' : reason);
      }
    },
    async cancel(assignmentId: string) {
      if (!/^[A-Za-z0-9-]{1,120}$/.test(assignmentId)) throw new NativeOpenHandsError('openhands_conversation_id_invalid');
      await call(`/api/conversations/${assignmentId}/pause`, 'POST', {});
    },
  };
}
