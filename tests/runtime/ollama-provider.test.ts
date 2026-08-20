import { OllamaAdapter, ollamaBaseForModel } from '../../src/runtime/providers/ollama';
import { modelCabinet, selectModelRoutes } from '../../src/runtime/router/model-cabinet';
import { RUNTIME_CATALOGUE } from '../../src/runtime/router/catalogue';

describe('Ollama sovereign local provider', () => {
  it('is fail-closed until explicitly enabled', () => {
    expect(new OllamaAdapter().credentialState({})).toBe('key-absent');
    expect(new OllamaAdapter().credentialState({ OLLAMA_ENABLED: 'true' })).toBe('live-local');
  });

  it('registers zero-cost sovereign chat models', () => {
    const models = RUNTIME_CATALOGUE.filter((entry) => entry.provider === 'ollama');
    expect(models).toHaveLength(9);
    expect(models.every((entry) => entry.sovereignty_level === 3 && entry.input_cost_per_1m === 0)).toBe(true);
  });

  it('routes small models locally and 70B models only through an approved Tailscale endpoint', () => {
    const env = { OLLAMA_CONTABO_BASE_URL: 'http://100.87.14.42:11434' };
    expect(ollamaBaseForModel('qwen3:4b-instruct', env)).toBe('http://127.0.0.1:11434');
    expect(ollamaBaseForModel('qwen2.5:72b-instruct-q4_K_M', env)).toBe('http://100.87.14.42:11434');
    expect(ollamaBaseForModel('qwen2.5:72b-instruct-q4_K_M', { OLLAMA_CONTABO_BASE_URL: 'http://public.invalid' })).toBeNull();
  });

  it('publishes explicit interactive, batch, memory and cloud roles', () => {
    const cabinet = modelCabinet({ OLLAMA_ENABLED: 'true', OLLAMA_CONTABO_BASE_URL: 'http://100.87.14.42:11434' });
    expect(cabinet.find((route) => route.role === 'analysis-baseline')?.status).toBe('available');
    expect(cabinet.find((route) => route.role === 'frontier-escalation')?.status).toBe('credential-gated');
    expect(cabinet.find((route) => route.role === 'frontier-escalation')?.model).toContain('Grok 4.5');
    expect(modelCabinet({ OLLAMA_ENABLED: 'true', OLLAMA_CONTABO_BASE_URL: 'http://public.invalid' })
      .find((route) => route.role === 'analysis-baseline')?.status).toBe('install-required');
  });

  it('selects only available routes inside privacy, modality and budget constraints', () => {
    const routes = modelCabinet({ OLLAMA_ENABLED: 'true', OLLAMA_CONTABO_BASE_URL: 'http://100.64.0.1:11434' });
    const selected = selectModelRoutes(routes, { modality: 'text', max_budget_class: 0, require_sovereign: true });
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.every((route) => route.status === 'available' && route.privacy === 'sovereign' && route.budget_class === 0)).toBe(true);
    expect(selected.some((route) => route.model === 'qwen3.8-max')).toBe(false);
  });

  it('normalises a local chat response without credentials', async () => {
    const original = global.fetch;
    global.fetch = jest.fn(async () => new Response(JSON.stringify({ message: { content: 'local-pass' }, done: true, prompt_eval_count: 5, eval_count: 2 }), { status: 200 })) as typeof fetch;
    try {
      const result = await new OllamaAdapter().invoke({ model: 'qwen3:4b-instruct', prompt: 'test' }, { OLLAMA_ENABLED: 'true' });
      expect(result).toMatchObject({ ok: true, provider: 'ollama', transport: 'local', content: 'local-pass', simulated: false });
      expect(result.usage.estimated).toBe(false);
    } finally { global.fetch = original; }
  });

  it('never sends embedding-only models to the chat endpoint', async () => {
    const original = global.fetch;
    global.fetch = jest.fn() as typeof fetch;
    try {
      const result = await new OllamaAdapter().invoke(
        { model: 'bge-m3:latest', prompt: 'test' },
        { OLLAMA_ENABLED: 'true', OLLAMA_CONTABO_BASE_URL: 'http://100.64.0.1:11434' }
      );
      expect(result).toMatchObject({ ok: false, failure: { kind: 'model-unsupported' } });
      expect(global.fetch).not.toHaveBeenCalled();
    } finally { global.fetch = original; }
  });
});
