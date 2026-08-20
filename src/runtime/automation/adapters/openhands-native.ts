import crypto from 'crypto';
import type { AdapterResult, OpenHandsExecutionEnvelope } from '../contracts';
import type { NativeOpenHandsPort } from '../services/openhands-bridge';
import { evaluateOpenHandsEffects } from '../effect-policy';

type Fetcher = typeof fetch;
const MAX_NATIVE_RESPONSE_BYTES = 256 * 1024;
const CONTAINER_WORKSPACE = '/workspace/project';

export class NativeOpenHandsError extends Error {}

function baseUrl(value: string): URL {
  const url = new URL(value);
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) throw new NativeOpenHandsError('openhands_url_requires_https_or_loopback');
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
}): NativeOpenHandsPort & { health(): Promise<boolean> } {
  if (!config.sessionApiKey) throw new NativeOpenHandsError('openhands_session_key_required');
  const base = baseUrl(config.baseUrl);
  const fetcher = config.fetcher ?? fetch;
  const sleep = config.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));

  const call = async (path: string, method: 'GET' | 'POST', body?: unknown): Promise<Record<string, unknown>> => {
    let response: Response;
    try {
      response = await fetcher(new URL(path, base), {
        method, redirect: 'error', headers: { 'X-Session-API-Key': config.sessionApiKey, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch { throw new NativeOpenHandsError('openhands_unreachable'); }
    if (!response.ok) throw new NativeOpenHandsError(`openhands_http_${response.status}`);
    const raw = await response.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_NATIVE_RESPONSE_BYTES) throw new NativeOpenHandsError('openhands_response_too_large');
    try { return object(JSON.parse(raw)); } catch (error) { if (error instanceof NativeOpenHandsError) throw error; throw new NativeOpenHandsError('openhands_invalid_response'); }
  };

  return {
    async health() {
      try { const ready = await call('/health', 'GET'); return ready.ready === true || ready.status === 'ready' || ready.ok === true; }
      catch { return false; }
    },
    async execute(envelope: OpenHandsExecutionEnvelope): Promise<AdapterResult> {
      const created = await call('/api/conversations', 'POST', {
        workspace: { kind: 'LocalWorkspace', working_dir: CONTAINER_WORKSPACE },
        confirmation_policy: { kind: 'AlwaysConfirm' }, max_iterations: 100,
      });
      const conversationId = typeof created.conversation_id === 'string' ? created.conversation_id : typeof created.id === 'string' ? created.id : null;
      if (!conversationId || !/^[A-Za-z0-9-]{1,120}$/.test(conversationId)) throw new NativeOpenHandsError('openhands_conversation_id_invalid');
      await call(`/api/conversations/${conversationId}/events`, 'POST', {
        role: 'user', content: [{ type: 'text', text: envelope.instruction }], run: true,
      });
      const maxPolls = config.maxPolls ?? 120;
      for (let poll = 0; poll < maxPolls; poll += 1) {
        const state = await call(`/api/conversations/${conversationId}`, 'GET');
        const status = String(state.execution_status ?? '').toLowerCase();
        if (status === 'waiting_for_confirmation') {
          const events = await call(`/api/conversations/${conversationId}/events/search?limit=100`, 'GET');
          const decision = evaluateOpenHandsEffects(events, envelope.allowed_actions);
          await call(`/api/conversations/${conversationId}/events/respond_to_confirmation`, 'POST', {
            accept: decision.allowed, reason: decision.allowed ? 'Approved by bounded RONOR effect policy.' : 'Rejected by bounded RONOR effect policy.',
          });
          if (!decision.allowed) {
            try { await call(`/api/conversations/${conversationId}/pause`, 'POST', {}); } catch { /* already rejected */ }
            return { ok: false, summary: `OpenHands action refused: ${decision.reason}.`, evidence: [`conversation:${conversationId}`], cost_usd: 0 };
          }
          continue;
        }
        if (['error', 'failed', 'stopped', 'stuck'].includes(status)) return { ok: false, summary: `OpenHands terminated: ${status}.`, evidence: [`conversation:${conversationId}`], cost_usd: 0 };
        if (['finished', 'complete', 'completed'].includes(status)) {
          const events = await call(`/api/conversations/${conversationId}/events/search?limit=100`, 'GET');
          const serialized = JSON.stringify(events);
          const digest = crypto.createHash('sha256').update(serialized).digest('hex');
          const cost = typeof state.cost_usd === 'number' && Number.isFinite(state.cost_usd) && state.cost_usd >= 0 ? state.cost_usd : 0;
          return {
            ok: true, summary: 'OpenHands conversation completed.', evidence: [`conversation:${conversationId}`], cost_usd: cost,
            artifacts: [{ kind: 'event_log', sha256: digest, reference: `api/conversations/${conversationId}/events/search`, bytes: Buffer.byteLength(serialized) }],
          };
        }
        await sleep(config.pollIntervalMs ?? 1000);
      }
      try { await call(`/api/conversations/${conversationId}/pause`, 'POST', {}); } catch { /* fail closed below */ }
      return { ok: false, summary: 'OpenHands execution timed out and was paused.', evidence: [`conversation:${conversationId}`], cost_usd: 0 };
    },
    async cancel(assignmentId: string) {
      if (!/^[A-Za-z0-9-]{1,120}$/.test(assignmentId)) throw new NativeOpenHandsError('openhands_conversation_id_invalid');
      await call(`/api/conversations/${assignmentId}/pause`, 'POST', {});
    },
  };
}
