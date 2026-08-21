import crypto from 'crypto';
import type { AdapterResult, OpenHandsExecutionEnvelope } from '../contracts';
import type { NativeOpenHandsPort } from '../services/openhands-bridge';
import { evaluateOpenHandsEffects } from '../effect-policy';

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

export function createNativeOpenHandsClient(config: {
  baseUrl: string;
  sessionApiKey: string;
  fetcher?: Fetcher;
  pollIntervalMs?: number;
  maxPolls?: number;
  sleep?: (ms: number) => Promise<void>;
  plaintextServiceHosts?: readonly string[];
  llm?: { model: string; apiKey: string; baseUrl: string; apiMode?: 'chat' | 'responses' | 'auto' };
}): NativeOpenHandsPort & { health(): Promise<boolean> } {
  if (!config.sessionApiKey) throw new NativeOpenHandsError('openhands_session_key_required');
  const base = baseUrl(config.baseUrl, config.plaintextServiceHosts ?? []);
  const fetcher = config.fetcher ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

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
      let conversationId: string | null = null;
      const pause = async () => {
        if (!conversationId) return;
        try { await call(`/api/conversations/${conversationId}/pause`, 'POST', {}); } catch { /* cancellation remains fail-closed */ }
      };
      const waitForNextPoll = async () => {
        if (!signal) { await sleep(config.pollIntervalMs ?? 1000); return; }
        if (signal.aborted) throw new NativeOpenHandsError('openhands_cancelled');
        await new Promise<void>((resolve, reject) => {
          const cancelled = () => { cleanup(); reject(new NativeOpenHandsError('openhands_cancelled')); };
          const cleanup = () => signal.removeEventListener('abort', cancelled);
          signal.addEventListener('abort', cancelled, { once: true });
          sleep(config.pollIntervalMs ?? 1000).then(() => { cleanup(); resolve(); }, (error) => { cleanup(); reject(error); });
        });
      };
      try {
        if (signal?.aborted) throw new NativeOpenHandsError('openhands_cancelled');
        const created = await call('/api/conversations', 'POST', {
          workspace: { kind: 'LocalWorkspace', working_dir: CONTAINER_WORKSPACE },
          confirmation_policy: { kind: 'AlwaysConfirm' }, max_iterations: 100,
          ...(config.llm ? { agent_settings: {
            agent_kind: 'openhands',
            llm: { model: config.llm.model, api_key: config.llm.apiKey, base_url: config.llm.baseUrl, api_mode: config.llm.apiMode ?? 'chat' },
          } } : {}),
        }, signal);
        conversationId = typeof created.conversation_id === 'string' ? created.conversation_id : typeof created.id === 'string' ? created.id : null;
        if (!conversationId || !/^[A-Za-z0-9-]{1,120}$/.test(conversationId)) throw new NativeOpenHandsError('openhands_conversation_id_invalid');
        await call(`/api/conversations/${conversationId}/events`, 'POST', {
          role: 'user', content: [{ type: 'text', text: envelope.instruction }], run: true,
        }, signal);
        const maxPolls = config.maxPolls ?? 120;
        for (let poll = 0; poll < maxPolls; poll += 1) {
          if (signal?.aborted) throw new NativeOpenHandsError('openhands_cancelled');
          const state = await call(`/api/conversations/${conversationId}`, 'GET', undefined, signal);
        const status = String(state.execution_status ?? '').toLowerCase();
        if (status === 'waiting_for_confirmation') {
          const events = await call(`/api/conversations/${conversationId}/events/search?limit=100`, 'GET', undefined, signal);
          const decision = evaluateOpenHandsEffects(events, envelope.allowed_actions);
          await call(`/api/conversations/${conversationId}/events/respond_to_confirmation`, 'POST', {
            accept: decision.allowed, reason: decision.allowed ? 'Approved by bounded RONOR effect policy.' : 'Rejected by bounded RONOR effect policy.',
          }, signal);
          if (!decision.allowed) {
            await pause();
            return { ok: false, summary: `OpenHands action refused: ${decision.reason}.`, evidence: [`conversation:${conversationId}`], cost_usd: 0 };
          }
          continue;
        }
        if (['error', 'failed', 'stopped', 'stuck'].includes(status)) return { ok: false, summary: `OpenHands terminated: ${status}.`, evidence: [`conversation:${conversationId}`], cost_usd: 0 };
        if (['finished', 'complete', 'completed'].includes(status)) {
          const events = await call(`/api/conversations/${conversationId}/events/search?limit=100`, 'GET', undefined, signal);
          const serialized = JSON.stringify(events);
          const digest = crypto.createHash('sha256').update(serialized).digest('hex');
          const cost = typeof state.cost_usd === 'number' && Number.isFinite(state.cost_usd) && state.cost_usd >= 0 ? state.cost_usd : 0;
          return {
            ok: true, summary: 'OpenHands conversation completed.', evidence: [`conversation:${conversationId}`], cost_usd: cost,
            artifacts: [{ kind: 'event_log', sha256: digest, reference: `api/conversations/${conversationId}/events/search`, bytes: Buffer.byteLength(serialized) }],
          };
        }
          await waitForNextPoll();
        }
        await pause();
        return { ok: false, summary: 'OpenHands execution timed out and was paused.', evidence: [`conversation:${conversationId}`], cost_usd: 0 };
      } catch (error) {
        if (signal?.aborted || (error instanceof NativeOpenHandsError && error.message === 'openhands_cancelled')) await pause();
        throw error;
      }
    },
    async cancel(assignmentId: string) {
      if (!/^[A-Za-z0-9-]{1,120}$/.test(assignmentId)) throw new NativeOpenHandsError('openhands_conversation_id_invalid');
      await call(`/api/conversations/${assignmentId}/pause`, 'POST', {});
    },
  };
}
