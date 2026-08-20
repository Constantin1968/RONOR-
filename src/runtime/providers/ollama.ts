import { providerFailure, type CredentialState, type ProviderAdapter, type ProviderDescriptor, type ProviderInvocation, type ProviderResponse } from './types';

export const OLLAMA_MODELS = ['qwen3:4b-instruct', 'qwen2.5-coder:3b', 'deepseek-r1:1.5b', 'qwen3-embedding:0.6b'] as const;

export class OllamaAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = { id: 'ollama', displayName: 'Ollama Local', models: [...OLLAMA_MODELS], searchAugmented: false, jurisdictions: ['LOCAL', 'RO'] };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    return env.OLLAMA_ENABLED === 'true' ? 'live-local' : 'key-absent';
  }

  async invoke(invocation: ProviderInvocation, env: NodeJS.ProcessEnv = process.env): Promise<ProviderResponse> {
    const started = Date.now();
    if (this.credentialState(env) !== 'live-local') return providerFailure('ollama', invocation.model, 'local', { kind: 'credential-absent', message: 'local Ollama is disabled; set OLLAMA_ENABLED=true after health verification', retryable: false });
    if (!OLLAMA_MODELS.includes(invocation.model as typeof OLLAMA_MODELS[number]) || invocation.model.includes('embedding')) return providerFailure('ollama', invocation.model, 'local', { kind: 'model-unsupported', message: 'model is not available for chat generation', retryable: false });
    const base = env.OLLAMA_BASE_URL || 'http://127.0.0.1:11434';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), invocation.timeoutMs ?? 120_000);
    try {
      const messages = invocation.messages ?? [...(invocation.system ? [{ role: 'system' as const, content: invocation.system }] : []), { role: 'user' as const, content: invocation.prompt }];
      const response = await fetch(`${base.replace(/\/$/, '')}/api/chat`, { method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: invocation.model, messages, stream: false, options: { temperature: invocation.temperature ?? 0, num_predict: invocation.maxOutputTokens ?? 2048 } }) });
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
