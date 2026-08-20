import { providerFailure, type CredentialState, type ProviderAdapter, type ProviderDescriptor, type ProviderInvocation, type ProviderResponse } from './types';

export const OLLAMA_MODELS = ['qwen3:4b-instruct', 'qwen3.5:4b', 'qwen2.5-coder:3b', 'deepseek-r1:1.5b', 'qwen3-embedding:0.6b', 'qwen2.5:72b-instruct-q4_K_M', 'qwen3.5:35b-a3b', 'qwen3-coder:30b', 'deepseek-r1:70b-llama-distill-q4_K_M', 'llama3.1:70b-instruct-q4_K_M', 'bge-m3:latest'] as const;
const CONTABO_MODELS = new Set<string>(['qwen2.5:72b-instruct-q4_K_M', 'qwen3.5:35b-a3b', 'qwen3-coder:30b', 'deepseek-r1:70b-llama-distill-q4_K_M', 'llama3.1:70b-instruct-q4_K_M', 'bge-m3:latest']);
const EMBEDDING_ONLY_MODELS = new Set<string>(['qwen3-embedding:0.6b', 'bge-m3:latest']);

export function ollamaBaseForModel(model: string, env: NodeJS.ProcessEnv): string | null {
  const value = CONTABO_MODELS.has(model)
    ? env.OLLAMA_CONTABO_BASE_URL
    : env.OLLAMA_LOCAL_BASE_URL || env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
  if (!value) return null;
  try {
    const url = new URL(value);
    const privateHost = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname.startsWith('100.');
    return ((url.protocol === 'http:' && privateHost) || url.protocol === 'https:')
      ? value.replace(/\/$/, '')
      : null;
  } catch { return null; }
}

export class OllamaAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = { id: 'ollama', displayName: 'Ollama Local', models: [...OLLAMA_MODELS], searchAugmented: false, jurisdictions: ['LOCAL', 'RO'] };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    return env.OLLAMA_ENABLED === 'true' ? 'live-local' : 'key-absent';
  }

  async invoke(invocation: ProviderInvocation, env: NodeJS.ProcessEnv = process.env): Promise<ProviderResponse> {
    const started = Date.now();
    if (this.credentialState(env) !== 'live-local') return providerFailure('ollama', invocation.model, 'local', { kind: 'credential-absent', message: 'local Ollama is disabled; set OLLAMA_ENABLED=true after health verification', retryable: false });
    if (!OLLAMA_MODELS.includes(invocation.model as typeof OLLAMA_MODELS[number]) || EMBEDDING_ONLY_MODELS.has(invocation.model)) return providerFailure('ollama', invocation.model, 'local', { kind: 'model-unsupported', message: 'model is not available for chat generation', retryable: false });
    const base = ollamaBaseForModel(invocation.model, env);
    if (!base) return providerFailure('ollama', invocation.model, 'local', { kind: 'credential-absent', message: 'no approved local or Tailscale Ollama route for model', retryable: false });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), invocation.timeoutMs ?? 120_000);
    try {
      const messages = invocation.messages ?? [...(invocation.system ? [{ role: 'system' as const, content: invocation.system }] : []), { role: 'user' as const, content: invocation.prompt }];
      const response = await fetch(`${base}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: invocation.model, messages, stream: false, keep_alive: 0, options: { temperature: invocation.temperature ?? 0, num_predict: invocation.maxOutputTokens ?? 2048 } }) });
      if (!response.ok) return providerFailure('ollama', invocation.model, 'local', { kind: response.status === 404 ? 'model-unsupported' : 'server-error', message: `Ollama returned HTTP ${response.status}`, httpStatus: response.status, retryable: response.status >= 500 });
      const body = await response.json() as Record<string, unknown>;
      const message = body.message as Record<string, unknown> | undefined;
      if (!message || typeof message.content !== 'string') return providerFailure('ollama', invocation.model, 'local', { kind: 'bad-response', message: 'Ollama response contained no message content', retryable: true });
      return { ok: true, provider: 'ollama', model: invocation.model, transport: 'local', content: message.content, usage: { input_tokens: typeof body.prompt_eval_count === 'number' ? body.prompt_eval_count : 0, output_tokens: typeof body.eval_count === 'number' ? body.eval_count : 0, estimated: typeof body.prompt_eval_count !== 'number' }, latency_ms: Date.now() - started, citations: [], finishReason: body.done === true ? 'stop' : null, failure: null, simulated: false };
    } catch (error) {
      return providerFailure('ollama', invocation.model, 'local', { kind: error instanceof Error && error.name === 'AbortError' ? 'timeout' : 'network', message: error instanceof Error && error.name === 'AbortError' ? 'Ollama timed out' : 'Ollama local endpoint is unreachable', retryable: true });
    } finally { clearTimeout(timer); }
  }
}
