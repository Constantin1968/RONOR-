import { OllamaAdapter } from '../../src/runtime/providers/ollama';
import { RUNTIME_CATALOGUE } from '../../src/runtime/router/catalogue';

describe('Ollama sovereign local provider', () => {
  it('is fail-closed until explicitly enabled', () => {
    expect(new OllamaAdapter().credentialState({})).toBe('key-absent');
    expect(new OllamaAdapter().credentialState({ OLLAMA_ENABLED: 'true' })).toBe('live-local');
  });

  it('registers zero-cost sovereign chat models', () => {
    const models = RUNTIME_CATALOGUE.filter((entry) => entry.provider === 'ollama');
    expect(models).toHaveLength(3);
    expect(models.every((entry) => entry.sovereignty_level === 3 && entry.input_cost_per_1m === 0)).toBe(true);
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
});
