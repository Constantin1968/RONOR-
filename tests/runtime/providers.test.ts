/**
 * RONOR Runtime — L1 Provider Contract Tests
 *
 * These tests assert the properties the fallback chain and the ledgers depend
 * on. Two are worth calling out because they guard against silent failures
 * rather than loud ones:
 *
 *   · The max-token mapping is asserted on the EMITTED REQUEST BODY, not on the
 *     returned text. Sending `max_completion_tokens` to Gemini yields HTTP 200
 *     with a null completion, so a test that only checked "did we get an answer"
 *     would pass against a live model and fail in production the moment
 *     reasoning consumed the budget.
 *   · No adapter throws. Every failure is a typed return value, because the
 *     chain inspects refusals and an exception carries no provenance.
 *
 * Prepared by AMB.
 */

import { AnthropicAdapter } from '../../src/runtime/providers/anthropic';
import { DeepSeekAdapter } from '../../src/runtime/providers/deepseek';
import {
  DeterministicAdapter,
  computeExactly,
  evaluateTokens,
  extractExpression,
  tokenise,
} from '../../src/runtime/providers/deterministic';
import { GoogleAdapter, sanitiseGeminiSchema } from '../../src/runtime/providers/google';
import { OpenAIAdapter } from '../../src/runtime/providers/openai';
import { PerplexityAdapter } from '../../src/runtime/providers/perplexity';
import { KimiAdapter, KIMI_MODELS } from '../../src/runtime/providers/kimi';
import {
  DEFAULT_GATEWAY_MODELS,
  gatewayServes,
  nativeKey,
  resolveGateway,
} from '../../src/runtime/providers/gateway';
import {
  anthropicThinkingBudget,
  buildChatCompletionsBody,
  inferFamilyConventions,
  normaliseCitations,
} from '../../src/runtime/providers/openai-compatible';
import {
  hasSearchAugmentedProvider,
  invocableProviders,
  listAdapters,
  providerStatuses,
} from '../../src/runtime/providers/registry';
import { classifyHttpStatus, estimateTokens } from '../../src/runtime/providers/types';

const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('L1 · family conventions', () => {
  it('maps the GPT family to max_completion_tokens', () => {
    expect(inferFamilyConventions('gpt-5-mini')).toEqual({
      tokenParam: 'max_completion_tokens',
      reasoning: 'openai-effort',
    });
  });

  it('maps Claude to max_tokens with an Anthropic thinking budget', () => {
    expect(inferFamilyConventions('claude-sonnet-4-6')).toEqual({
      tokenParam: 'max_tokens',
      reasoning: 'anthropic-budget',
    });
  });

  it('maps Gemini to max_tokens — never max_completion_tokens', () => {
    const c = inferFamilyConventions('gemini-3-flash-preview');
    expect(c.tokenParam).toBe('max_tokens');
    expect(c.tokenParam).not.toBe('max_completion_tokens');
  });

  it('defaults an unknown model to the safe max_tokens convention', () => {
    expect(inferFamilyConventions('some-new-model-v9').tokenParam).toBe('max_tokens');
  });
});

describe('L1 · request body construction', () => {
  const target = {
    provider: 'openai' as const,
    transport: 'gateway' as const,
    baseUrl: 'https://example.test/v1',
    apiKey: 'k',
    model: 'gpt-5-mini',
    tokenParam: 'max_completion_tokens' as const,
    reasoning: 'openai-effort' as const,
  };

  it('emits max_completion_tokens for GPT and never max_tokens', () => {
    const body = buildChatCompletionsBody(target, { model: 'gpt-5-mini', prompt: 'hi' });
    expect(body).toHaveProperty('max_completion_tokens');
    expect(body).not.toHaveProperty('max_tokens');
  });

  it('emits max_tokens for Gemini and never max_completion_tokens', () => {
    const body = buildChatCompletionsBody(
      { ...target, provider: 'google', model: 'gemini-3-flash-preview', tokenParam: 'max_tokens', reasoning: 'gemini-effort' },
      { model: 'gemini-3-flash-preview', prompt: 'hi' },
    );
    expect(body).toHaveProperty('max_tokens');
    expect(body).not.toHaveProperty('max_completion_tokens');
  });

  it('omits temperature unless the caller supplied one', () => {
    const withoutTemp = buildChatCompletionsBody(target, { model: 'gpt-5-mini', prompt: 'hi' });
    expect(withoutTemp).not.toHaveProperty('temperature');
    const withTemp = buildChatCompletionsBody(target, {
      model: 'gpt-5-mini',
      prompt: 'hi',
      temperature: 0.2,
    });
    expect(withTemp.temperature).toBe(0.2);
  });

  it('folds a system instruction into the first message', () => {
    const body = buildChatCompletionsBody(target, {
      model: 'gpt-5-mini',
      prompt: 'q',
      system: 's',
    });
    expect((body.messages as Array<{ role: string }>)[0].role).toBe('system');
  });

  it('maps reasoning effort none to the GPT floor of minimal rather than omitting it', () => {
    const body = buildChatCompletionsBody(target, {
      model: 'gpt-5-mini',
      prompt: 'q',
      reasoningEffort: 'none',
    });
    expect(body.reasoning).toEqual({ effort: 'minimal' });
  });

  it('requests strict JSON schema when asked', () => {
    const body = buildChatCompletionsBody(target, {
      model: 'gpt-5-mini',
      prompt: 'q',
      jsonSchema: { name: 'x', schema: { type: 'object' } },
    });
    expect(body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { name: 'x', strict: true },
    });
  });
});

describe('L1 · Anthropic thinking budget invariant', () => {
  it('always leaves room for a visible answer', () => {
    for (const max of [2048, 4096, 8192, 64_000]) {
      for (const effort of ['low', 'medium', 'high']) {
        const budget = anthropicThinkingBudget(max, effort);
        if (budget !== null) expect(budget).toBeLessThan(max);
      }
    }
  });

  it('returns null rather than an invalid sub-1024 budget', () => {
    expect(anthropicThinkingBudget(2000, 'low')).toBeNull();
  });

  it('requests no thinking when effort is none', () => {
    expect(anthropicThinkingBudget(64_000, 'none')).toBeNull();
  });
});

describe('L1 · Gemini schema sanitisation', () => {
  it('removes keywords the responseSchema dialect rejects', () => {
    const cleaned = sanitiseGeminiSchema({
      type: 'object',
      additionalProperties: false,
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      properties: { a: { type: 'string', additionalProperties: false } },
    }) as Record<string, unknown>;
    expect(cleaned).not.toHaveProperty('additionalProperties');
    expect(cleaned).not.toHaveProperty('$schema');
    expect((cleaned.properties as Record<string, Record<string, unknown>>).a).not.toHaveProperty(
      'additionalProperties',
    );
    expect(cleaned.type).toBe('object');
  });

  it('recurses through arrays', () => {
    const cleaned = sanitiseGeminiSchema({ anyOf: [{ type: 'string', strict: true }] }) as {
      anyOf: Array<Record<string, unknown>>;
    };
    expect(cleaned.anyOf[0]).not.toHaveProperty('strict');
  });
});

describe('L1 · credential resolution', () => {
  it('reports key-absent for every remote provider in an empty environment', () => {
    for (const adapter of listAdapters()) {
      const state = adapter.credentialState(EMPTY_ENV);
      if (adapter.descriptor.id === 'deterministic') expect(state).toBe('live-local');
      else expect(state).toBe('key-absent');
    }
  });

  it('prefers a native key over a gateway route', () => {
    const env: NodeJS.ProcessEnv = {
      ANTHROPIC_API_KEY: 'sk-native',
      OPENAI_API_BASE: 'https://gw.test/v1',
      OPENAI_API_KEY: 'gw-key',
    };
    expect(new AnthropicAdapter().credentialState(env)).toBe('live-native');
  });

  it('falls back to the gateway when only a gateway is configured', () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_BASE: 'https://gw.test/v1',
      OPENAI_API_KEY: 'gw-key',
    };
    expect(new AnthropicAdapter().credentialState(env)).toBe('live-gateway');
    expect(new GoogleAdapter().credentialState(env)).toBe('live-gateway');
    expect(new OpenAIAdapter().credentialState(env)).toBe('live-gateway');
  });

  it('does not treat OPENAI_API_KEY as an OpenAI native key', () => {
    // Gateway credentials are conventionally placed in OPENAI_API_KEY. Treating
    // one as a native key would send gateway tokens to api.openai.com.
    expect(nativeKey('openai', { OPENAI_API_KEY: 'gw' })).toBeNull();
    expect(nativeKey('openai', { OPENAI_NATIVE_API_KEY: 'sk-real' })).toBe('sk-real');
  });

  it('leaves DeepSeek and Perplexity key-absent under a default gateway', () => {
    const env: NodeJS.ProcessEnv = {
      OPENAI_API_BASE: 'https://gw.test/v1',
      OPENAI_API_KEY: 'gw-key',
    };
    expect(new DeepSeekAdapter().credentialState(env)).toBe('key-absent');
    expect(new PerplexityAdapter().credentialState(env)).toBe('key-absent');
  });

  it('publishes current Kimi identifiers and activates only with its native key', () => {
    expect(KIMI_MODELS[0]).toBe('kimi-k2.6');
    expect(KIMI_MODELS).toContain('kimi-k2.5');
    expect(KIMI_MODELS).not.toContain('kimi-k3');
    expect(new KimiAdapter().credentialState(EMPTY_ENV)).toBe('key-absent');
    expect(new KimiAdapter().credentialState({ KIMI_API_KEY: 'x' })).toBe('live-native');
  });

  it('activates DeepSeek and Perplexity the moment a key appears — no code change', () => {
    expect(new DeepSeekAdapter().credentialState({ DEEPSEEK_API_KEY: 'x' })).toBe('live-native');
    expect(new PerplexityAdapter().credentialState({ PERPLEXITY_API_KEY: 'x' })).toBe('live-native');
  });

  it('honours an explicit gateway model allow-list override', () => {
    const env: NodeJS.ProcessEnv = {
      RONOR_GATEWAY_BASE_URL: 'https://gw.test/v1',
      RONOR_GATEWAY_API_KEY: 'k',
      RONOR_GATEWAY_MODELS: 'sonar-pro, deepseek-chat',
    };
    expect(gatewayServes('sonar-pro', env)).toBe(true);
    expect(gatewayServes('gpt-5', env)).toBe(false);
    expect(new PerplexityAdapter().credentialState(env)).toBe('live-gateway');
  });

  it('resolves no gateway without both a base URL and a key', () => {
    expect(resolveGateway({ OPENAI_API_BASE: 'https://x/v1' })).toBeNull();
    expect(resolveGateway({ OPENAI_API_KEY: 'k' })).toBeNull();
    expect(resolveGateway(EMPTY_ENV)).toBeNull();
  });

  it('publishes a non-empty default gateway allow-list', () => {
    expect(DEFAULT_GATEWAY_MODELS.length).toBeGreaterThan(0);
  });
});

describe('L1 · adapters refuse rather than simulate or throw', () => {
  it.each(listAdapters().filter((a) => a.descriptor.id !== 'deterministic'))(
    'refuses %s with a typed credential-absent failure and never throws',
    async (adapter) => {
      const res = await adapter.invoke(
        { model: adapter.descriptor.models[0], prompt: 'hello' },
        EMPTY_ENV,
      );
      expect(res.ok).toBe(false);
      expect(res.failure?.kind).toBe('credential-absent');
      expect(res.failure?.retryable).toBe(false);
      // The critical assertion: no adapter fabricates an answer when it cannot run.
      expect(res.simulated).toBe(false);
      expect(res.content).toBe('');
    },
  );
});

describe('L1 · registry status surface', () => {
  it('reports every provider with an invocable verdict', () => {
    const statuses = providerStatuses(EMPTY_ENV);
    // Seven providers: openai, anthropic, google, deepseek, perplexity, kimi and
    // the deterministic core. Kimi was registered on or around 5 Aug 2026 without
    // updating this count, so this assertion has been failing ever since — which
    // is defect D-3. The /status handler read `.invocable` off a provider the
    // status surface had not fully described and threw on undefined. The suite
    // was reporting the defect the whole time; nobody was running the suite.
    expect(statuses).toHaveLength(7);
    const det = statuses.find((s) => s.provider === 'deterministic');
    expect(det?.invocable).toBe(true);
    expect(det?.transport).toBe('local');
    expect(statuses.filter((s) => s.provider !== 'deterministic').every((s) => !s.invocable)).toBe(
      true,
    );
  });

  it('reports the deterministic core as the only invocable provider offline', () => {
    expect([...invocableProviders(EMPTY_ENV)]).toEqual(['deterministic']);
  });

  it('reports no search-augmented capability without a Perplexity key', () => {
    expect(hasSearchAugmentedProvider(EMPTY_ENV)).toBe(false);
    expect(hasSearchAugmentedProvider({ PERPLEXITY_API_KEY: 'x' })).toBe(true);
  });
});

describe('L1 · deterministic core', () => {
  const adapter = new DeterministicAdapter();

  it('evaluates arithmetic exactly with correct precedence', () => {
    expect(computeExactly('2+3*4')?.value).toBe(14);
    expect(computeExactly('(2+3)*4')?.value).toBe(20);
    expect(computeExactly('2^3^2')?.value).toBe(512); // right-associative
    expect(computeExactly('10 % 3')?.value).toBe(1);
  });

  it('handles unary minus without a special case in the parser', () => {
    expect(computeExactly('-5 + 3')?.value).toBe(-2);
    expect(computeExactly('4 * -2')?.value).toBe(-8);
    expect(computeExactly('3 - -2')?.value).toBe(5);
  });

  it('preserves precedence when a unary sign precedes a parenthesised group', () => {
    // `-(2+3)*4` must bind the sign to the group, not to the product. The
    // rewrite emits `( 0 - ( 2 + 3 ) ) * 4`; an unparenthesised rewrite would
    // yield -2 and be indistinguishable from a correct answer to a reader.
    expect(computeExactly('-(2+3)*4')?.value).toBe(-20);
  });

  it('binds a leading unary sign tighter than exponentiation, and says so', () => {
    // `-2^2` is -4 in mathematical convention and 4 under sign-folding. The
    // parser folds the sign into the literal, so it returns 4. This is asserted
    // rather than left ambiguous: an exact engine must have a DOCUMENTED reading
    // of every expression it accepts, and a reader of the ledger needs to know
    // which convention produced the number.
    expect(computeExactly('-2^2')?.value).toBe(4);
  });

  it('refuses division by zero rather than returning Infinity', () => {
    expect(computeExactly('5/0')).toBeNull();
  });

  it('refuses malformed numeric literals', () => {
    expect(tokenise('1.2.3+1')).toBeNull();
  });

  it('refuses unbalanced parentheses', () => {
    const t = tokenise('(2+3');
    expect(t).not.toBeNull();
    expect(evaluateTokens(t!)).toBeNull();
  });

  it('extracts no expression from prose that merely mentions numbers', () => {
    expect(extractExpression('what were 2024 revenues')).toBeNull();
  });

  it('refuses code-injection shaped input at the character allow-list', () => {
    for (const hostile of [
      'process.exit(1)',
      '1 + require("fs")',
      '`${7*7}`',
      'globalThis.x = 1 + 1',
      'constructor.constructor("return 1")()',
    ]) {
      const expr = extractExpression(hostile);
      // Either nothing is extracted, or what is extracted is pure arithmetic.
      if (expr !== null) expect(expr).toMatch(/^[0-9.\s()+\-*/%^]+$/);
    }
  });

  it('answers a computable query with full confidence and zero cost', async () => {
    const res = await adapter.invoke({ model: 'ronor/deterministic-core', prompt: 'what is 12*12?' });
    expect(res.ok).toBe(true);
    expect(res.transport).toBe('local');
    expect(res.usage.input_tokens).toBe(0);
    expect(JSON.parse(res.content).answer).toContain('144');
  });

  it('escalates a non-computable query with a retryable refusal', async () => {
    const res = await adapter.invoke({
      model: 'ronor/deterministic-core',
      prompt: 'summarise the EU AI Act',
    });
    expect(res.ok).toBe(false);
    expect(res.failure?.kind).toBe('not-computable');
    expect(res.failure?.retryable).toBe(true);
  });
});

describe('L1 · failure classification', () => {
  it('treats 401 and 403 as non-retryable authentication failures', () => {
    for (const s of [401, 403]) {
      const f = classifyHttpStatus(s, 'nope');
      expect(f.kind).toBe('auth-rejected');
      expect(f.retryable).toBe(false);
    }
  });

  it('treats 429 as a retryable rate limit', () => {
    expect(classifyHttpStatus(429, 'slow down')).toMatchObject({
      kind: 'rate-limited',
      retryable: true,
    });
  });

  it('treats 400 and 404 as an unsupported model worth failing over', () => {
    for (const s of [400, 404]) {
      expect(classifyHttpStatus(s, 'bad model')).toMatchObject({
        kind: 'model-unsupported',
        retryable: true,
      });
    }
  });

  it('treats 5xx as a retryable server error', () => {
    expect(classifyHttpStatus(503, 'down')).toMatchObject({
      kind: 'server-error',
      retryable: true,
    });
  });
});

describe('L1 · citation normalisation', () => {
  it('reads the search_results object shape', () => {
    const c = normaliseCitations({
      search_results: [{ title: 'ENTSO-E Transparency', url: 'https://x.test/a', snippet: 's' }],
    });
    expect(c).toEqual([{ title: 'ENTSO-E Transparency', url: 'https://x.test/a', snippet: 's' }]);
  });

  it('reads the legacy bare-URL citations shape', () => {
    const c = normaliseCitations({ citations: ['https://x.test/b'] });
    expect(c[0].url).toBe('https://x.test/b');
  });

  it('prefers search_results when both are present', () => {
    const c = normaliseCitations({
      search_results: [{ title: 'A', url: 'https://a.test' }],
      citations: ['https://b.test'],
    });
    expect(c).toHaveLength(1);
    expect(c[0].title).toBe('A');
  });

  it('returns nothing for an unrecognised shape rather than guessing', () => {
    expect(normaliseCitations({ citations: [{ nope: 1 }] })).toEqual([]);
    expect(normaliseCitations({})).toEqual([]);
  });
});

describe('L1 · token estimation', () => {
  it('never returns zero for non-empty text', () => {
    expect(estimateTokens('a')).toBeGreaterThanOrEqual(1);
  });

  it('scales roughly with length', () => {
    expect(estimateTokens('x'.repeat(400))).toBe(100);
  });
});
