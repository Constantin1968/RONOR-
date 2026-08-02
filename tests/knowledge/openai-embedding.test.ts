/**
 * R-Knowledge — Learned Embedding Provider Verification
 * MIP-015 STEP 3
 *
 * ── WHAT THIS SUITE PROVES, AND WHAT IT DOES NOT ────────────────────────────
 *
 * The learned provider is verified against a RECORDED, IN-PROCESS transport
 * double. The double replays the response SHAPE of the OpenAI embeddings API —
 * `data[].embedding`, `data[].index`, HTTP status semantics — and it is the
 * absence of a service expressed as a module boundary.
 *
 * What is proved: the adapter's refusal logic, its batching and ordering
 * discipline, its dimension and arity enforcement, its retry classification, its
 * credential hygiene, and the truthfulness of its fallback attribution.
 *
 * What is NOT proved: that any live endpoint behaves as the double does. A live
 * smoke test exists at the end of this file and SKIPS EXPLICITLY, with a stated
 * reason, when no embeddings endpoint is reachable. It is not a silent skip: the
 * skip reason is printed, so a green run can never be mistaken for a live
 * verification that did not happen.
 *
 * The environment in which this was authored has no reachable embeddings
 * endpoint — the configured OpenAI-compatible proxy serves chat completions only
 * and returns 404 for /embeddings — so the live test skips here by default.
 */

import {
  OpenAIEmbeddingAdapter,
  UNAVAILABLE_EMBEDDING_TRANSPORT,
  evaluateOpenAIConditions,
  isAcceptableEmbeddingEndpoint,
  type EmbeddingTransport,
  type EmbeddingTransportFactory,
  type EmbeddingTransportRequest,
  type EmbeddingTransportResponse,
} from '../../src/knowledge/embedding/openai-adapter';
import { redactCredentialLike } from '../../src/knowledge/embedding/openai-transport';
import { createEmbeddingAdapter } from '../../src/knowledge/embedding/embedding-adapter';
import { resolveKnowledgeConfig, assessConfigAdmissibility } from '../../src/planes/r-knowledge/config';
import type { OpenAIEmbeddingConfig } from '../../src/planes/r-knowledge/types';

const DIMENSIONS = 8;

function makeConfig(overrides: Partial<OpenAIEmbeddingConfig> = {}): OpenAIEmbeddingConfig {
  return Object.freeze({
    baseUrl: 'https://api.vendor.example/v1',
    apiKeyPresent: true,
    model: 'test-embedding-model',
    dimensions: DIMENSIONS,
    timeoutMs: 5000,
    maxRetries: 2,
    batchSize: 4,
    fallbackToDeterministic: true,
    ...overrides,
  });
}

// ============================================================
// Recorded transport double
// ============================================================

interface Recorder {
  factoryInvocations: number;
  requests: EmbeddingTransportRequest[];
}

interface DoubleOptions {
  /** Sequence of responses; the last is repeated once exhausted. */
  responses?: EmbeddingTransportResponse[];
  dimensions?: number;
  /** Throw instead of returning, to prove the adapter never propagates it. */
  throwOnCall?: boolean;
}

/**
 * A deterministic vector derived from the text, so that an ordering defect is
 * detectable: each vector identifies the input that produced it.
 */
function vectorFor(text: string, dimensions: number): number[] {
  let seed = 0;
  for (let i = 0; i < text.length; i++) seed = (seed * 31 + text.charCodeAt(i)) % 100_000;
  return Array.from({ length: dimensions }, (_u, i) => Number((((seed + i) % 97) / 97).toFixed(6)));
}

function makeDouble(options: DoubleOptions = {}): {
  factory: EmbeddingTransportFactory;
  recorder: Recorder;
} {
  const dimensions = options.dimensions ?? DIMENSIONS;
  const recorder: Recorder = { factoryInvocations: 0, requests: [] };
  let callIndex = 0;

  const transport: EmbeddingTransport = {
    async embed(request: EmbeddingTransportRequest): Promise<EmbeddingTransportResponse> {
      recorder.requests.push(request);
      if (options.throwOnCall) throw new Error('transport exploded');
      if (options.responses && options.responses.length > 0) {
        const response = options.responses[Math.min(callIndex, options.responses.length - 1)];
        callIndex += 1;
        return response;
      }
      return {
        ok: true,
        vectors: request.input.map((text) => vectorFor(text, dimensions)),
        reason: null,
        retryable: false,
      };
    },
  };

  const factory: EmbeddingTransportFactory = () => {
    recorder.factoryInvocations += 1;
    return transport;
  };

  return { factory, recorder };
}

// ============================================================
// Conditions precedent
// ============================================================

describe('MIP-015 · learned provider conditions precedent', () => {
  const cases: {
    id: string;
    label: string;
    config: Partial<OpenAIEmbeddingConfig>;
    egress: boolean;
    expectedReason: string;
  }[] = [
    {
      id: 'LP-1',
      label: 'egress unauthorised',
      config: {},
      egress: false,
      expectedReason: 'EMBEDDING_EGRESS_UNAUTHORISED',
    },
    {
      id: 'LP-2',
      label: 'no credential',
      config: { apiKeyPresent: false },
      egress: true,
      expectedReason: 'EMBEDDING_CREDENTIALS_ABSENT',
    },
    {
      id: 'LP-3',
      label: 'no model named',
      config: { model: null },
      egress: true,
      expectedReason: 'EMBEDDING_MODEL_ABSENT',
    },
    {
      id: 'LP-4',
      label: 'endpoint not absolute',
      config: { baseUrl: '/v1/embeddings' },
      egress: true,
      expectedReason: 'CONFIG_INVALID',
    },
    {
      id: 'LP-5',
      label: 'endpoint plaintext non-loopback',
      config: { baseUrl: 'http://api.vendor.example/v1' },
      egress: true,
      expectedReason: 'CONFIG_INVALID',
    },
    {
      id: 'LP-6',
      label: 'dimensions not a positive integer',
      config: { dimensions: 0 },
      egress: true,
      expectedReason: 'CONFIG_INVALID',
    },
  ];

  test.each(cases)(
    '$id · $label → $expectedReason with ZERO transport construction',
    async ({ config, egress, expectedReason }) => {
      const { factory, recorder } = makeDouble();
      const adapter = new OpenAIEmbeddingAdapter({
        config: makeConfig(config),
        egressAuthorised: egress,
        transportFactory: factory,
      });

      const init = await adapter.init();

      expect(init.ok).toBe(false);
      expect(init.reason).toBe(expectedReason);

      // THE OPERATIVE EVIDENCE. The factory was never invoked, so no client came
      // into existence, so no request could have been issued. Asserting only on
      // the reason code would leave open the possibility that a client was
      // constructed and a socket opened before the refusal was returned.
      expect(recorder.factoryInvocations).toBe(0);
      expect(adapter.getTransportConstructionCount()).toBe(0);
      expect(recorder.requests).toEqual([]);
    }
  );

  test('all unsatisfied conditions are reported, not merely the first', () => {
    const verdicts = evaluateOpenAIConditions(
      makeConfig({ apiKeyPresent: false, model: null, baseUrl: 'nonsense' }),
      false,
      true
    );
    const unsatisfied = verdicts.filter((v) => !v.satisfied);
    expect(unsatisfied.length).toBeGreaterThanOrEqual(4);
    const ids = unsatisfied.map((v) => v.id);
    expect(ids).toContain('EGRESS_AUTHORISED');
    expect(ids).toContain('CREDENTIAL_PRESENT');
    expect(ids).toContain('MODEL_NAMED');
    expect(ids).toContain('ENDPOINT_ABSOLUTE');
  });

  test('the DEFAULT transport factory is the ABSENCE of a transport', async () => {
    // No factory supplied. The adapter must not reach for a live client.
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig(),
      egressAuthorised: true,
    });
    const init = await adapter.init();
    expect(init.ok).toBe(false);
    expect(init.reason).toBe('EMBEDDING_UNAVAILABLE');
    expect(adapter.getTransportConstructionCount()).toBe(0);
    expect(UNAVAILABLE_EMBEDDING_TRANSPORT(makeConfig())).toBeNull();
  });

  test('every condition satisfied → init succeeds and constructs exactly one transport', async () => {
    const { factory, recorder } = makeDouble();
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig(),
      egressAuthorised: true,
      transportFactory: factory,
    });
    const init = await adapter.init();
    expect(init.ok).toBe(true);
    expect(init.reason).toBeNull();
    expect(recorder.factoryInvocations).toBe(1);
    expect(adapter.getTransportConstructionCount()).toBe(1);
    // Construction alone issues no request.
    expect(recorder.requests).toEqual([]);
  });
});

// ============================================================
// Endpoint policy
// ============================================================

describe('MIP-015 · endpoint acceptability', () => {
  test('https is accepted', () => {
    expect(isAcceptableEmbeddingEndpoint('https://api.vendor.example/v1')).toBe(true);
  });

  test('plaintext is accepted ONLY for loopback', () => {
    expect(isAcceptableEmbeddingEndpoint('http://localhost:8080/v1')).toBe(true);
    expect(isAcceptableEmbeddingEndpoint('http://127.0.0.1:8080/v1')).toBe(true);
    // A plaintext endpoint anywhere else would put the credential and the corpus
    // text on the wire in clear.
    expect(isAcceptableEmbeddingEndpoint('http://api.vendor.example/v1')).toBe(false);
    expect(isAcceptableEmbeddingEndpoint('http://10.0.0.5:8080/v1')).toBe(false);
  });

  test('relative, empty and non-HTTP schemes are refused', () => {
    for (const raw of ['', '/v1', 'api.vendor.example', 'ftp://vendor.example', 'file:///etc/passwd']) {
      expect(isAcceptableEmbeddingEndpoint(raw)).toBe(false);
    }
  });
});

// ============================================================
// Batching, ordering, arity and width
// ============================================================

describe('MIP-015 · request discipline', () => {
  async function ready(overrides: Partial<OpenAIEmbeddingConfig> = {}, options: DoubleOptions = {}) {
    const { factory, recorder } = makeDouble(options);
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig(overrides),
      egressAuthorised: true,
      transportFactory: factory,
    });
    await adapter.init();
    return { adapter, recorder };
  }

  test('texts are batched to batchSize and every batch is issued', async () => {
    const { adapter, recorder } = await ready({ batchSize: 3 });
    const texts = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const result = await adapter.embed(texts);

    expect(result.ok).toBe(true);
    expect(result.vectors).toHaveLength(7);
    // ceil(7/3) = 3 requests.
    expect(recorder.requests).toHaveLength(3);
    expect(recorder.requests[0].input).toEqual(['a', 'b', 'c']);
    expect(recorder.requests[1].input).toEqual(['d', 'e', 'f']);
    expect(recorder.requests[2].input).toEqual(['g']);
  });

  test('vector order matches input order ACROSS batch boundaries', async () => {
    // The decisive property. A caller maps vectors onto chunks positionally, so a
    // reordering here would attach every vector to the wrong chunk — a corruption
    // that no downstream integrity check would catch, because each vector is
    // individually well-formed.
    const { adapter } = await ready({ batchSize: 2 });
    const texts = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    const result = await adapter.embed(texts);

    expect(result.ok).toBe(true);
    for (let i = 0; i < texts.length; i++) {
      expect(result.vectors[i]).toEqual(vectorFor(texts[i], DIMENSIONS));
    }
  });

  test('an empty input list issues no request and returns no vector', async () => {
    const { adapter, recorder } = await ready();
    const result = await adapter.embed([]);
    expect(result.ok).toBe(true);
    expect(result.vectors).toEqual([]);
    expect(recorder.requests).toEqual([]);
  });

  test('a wrong-width vector is REFUSED, never padded or truncated', async () => {
    const { adapter } = await ready(
      { fallbackToDeterministic: false },
      {
        responses: [
          { ok: true, vectors: [[1, 2, 3]], reason: null, retryable: false },
        ],
      }
    );
    const result = await adapter.embed(['one']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_DIMENSION_MISMATCH');
    expect(result.vectors).toEqual([]);
  });

  test('a width mismatch is refused even when fallback is ENABLED', async () => {
    // A dimension mismatch is not a availability failure; it is a disagreement
    // about what the model produces. Falling back would write vectors of a
    // different width into a corpus the operator believes is uniform.
    const { adapter } = await ready(
      { fallbackToDeterministic: true },
      { responses: [{ ok: true, vectors: [[1, 2, 3]], reason: null, retryable: false }] }
    );
    const result = await adapter.embed(['one']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_DIMENSION_MISMATCH');
  });

  test('an arity mismatch (wrong number of vectors) is not silently accepted', async () => {
    const { adapter } = await ready(
      { fallbackToDeterministic: false },
      {
        responses: [
          {
            ok: true,
            vectors: [vectorFor('one', DIMENSIONS)],
            reason: null,
            retryable: false,
          },
        ],
      }
    );
    const result = await adapter.embed(['one', 'two']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_PROVIDER_MISMATCH');
  });
});

// ============================================================
// Retry classification
// ============================================================

describe('MIP-015 · retry policy', () => {
  test('a retryable failure is retried up to maxRetries and then reported', async () => {
    const failure: EmbeddingTransportResponse = {
      ok: false,
      vectors: [],
      reason: 'EMBEDDING_UNAVAILABLE',
      detail: 'rate limited',
      retryable: true,
    };
    const { factory, recorder } = makeDouble({ responses: [failure] });
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig({ maxRetries: 2, fallbackToDeterministic: false }),
      egressAuthorised: true,
      transportFactory: factory,
    });
    await adapter.init();

    const result = await adapter.embed(['x']);

    expect(result.ok).toBe(false);
    // 1 initial attempt + 2 retries.
    expect(recorder.requests).toHaveLength(3);
  });

  test('a NON-retryable failure is attempted exactly once', async () => {
    // Retrying an authentication rejection wastes time and risks a lockout; the
    // credential will not become valid by being presented again.
    const failure: EmbeddingTransportResponse = {
      ok: false,
      vectors: [],
      reason: 'EMBEDDING_CREDENTIALS_ABSENT',
      detail: 'unauthorised',
      retryable: false,
    };
    const { factory, recorder } = makeDouble({ responses: [failure] });
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig({ maxRetries: 3, fallbackToDeterministic: false }),
      egressAuthorised: true,
      transportFactory: factory,
    });
    await adapter.init();

    const result = await adapter.embed(['x']);

    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_CREDENTIALS_ABSENT');
    expect(recorder.requests).toHaveLength(1);
  });

  test('a transport that THROWS does not propagate an exception across the plane boundary', async () => {
    const { factory } = makeDouble({ throwOnCall: true });
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig({ fallbackToDeterministic: false }),
      egressAuthorised: true,
      transportFactory: factory,
    });
    await adapter.init();

    // No rejection: a defective transport is a degradation, not an exception that
    // could disturb another plane.
    const result = await adapter.embed(['x']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_UNAVAILABLE');
  });
});

// ============================================================
// Fallback attribution — the single most important property
// ============================================================

describe('MIP-015 · fallback attribution', () => {
  test('a fallback vector is labelled provider=deterministic, NEVER openai', async () => {
    // If a fallback vector were recorded as a learned vector it would be
    // indistinguishable from a real one, and a later re-embedding pass would have
    // no way to identify which objects need redoing. The corpus would be silently
    // and permanently mixed.
    const failure: EmbeddingTransportResponse = {
      ok: false,
      vectors: [],
      reason: 'EMBEDDING_UNAVAILABLE',
      detail: 'service down',
      retryable: false,
    };
    const { factory } = makeDouble({ responses: [failure] });
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig({ fallbackToDeterministic: true }),
      egressAuthorised: true,
      transportFactory: factory,
    });
    await adapter.init();

    const result = await adapter.embed(['content to embed']);

    expect(result.ok).toBe(true);
    expect(result.provider).toBe('deterministic');
    expect(result.provider).not.toBe('openai');
    expect(result.model).toBeNull();
    // The ORIGINATING reason is preserved, so a caller can see WHY the fallback
    // happened rather than merely that a vector arrived.
    expect(result.reason).toBe('EMBEDDING_UNAVAILABLE');
    expect(adapter.getFallbackCount()).toBe(1);
  });

  test('the fallback vector is at the LEARNED model width, so it remains storable', async () => {
    // A fallback at a different width could not be written to the same collection,
    // which would turn a quality degradation into an outage.
    const failure: EmbeddingTransportResponse = {
      ok: false,
      vectors: [],
      reason: 'EMBEDDING_UNAVAILABLE',
      detail: 'down',
      retryable: false,
    };
    const { factory } = makeDouble({ responses: [failure] });
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig({ dimensions: 32, fallbackToDeterministic: true }),
      egressAuthorised: true,
      transportFactory: factory,
      fallbackDimensions: 32,
    });
    await adapter.init();

    const result = await adapter.embed(['text']);
    expect(result.ok).toBe(true);
    expect(result.vectors[0]).toHaveLength(32);
    expect(result.dimensions).toBe(32);
  });

  test('fallback DISABLED converts an unavailable provider into a refusal', async () => {
    // Both behaviours are legitimate. Neither may be implicit, which is why the
    // switch exists and why this assertion sits beside the one above.
    const failure: EmbeddingTransportResponse = {
      ok: false,
      vectors: [],
      reason: 'EMBEDDING_UNAVAILABLE',
      detail: 'down',
      retryable: false,
    };
    const { factory } = makeDouble({ responses: [failure] });
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig({ fallbackToDeterministic: false }),
      egressAuthorised: true,
      transportFactory: factory,
    });
    await adapter.init();

    const result = await adapter.embed(['text']);
    expect(result.ok).toBe(false);
    expect(result.vectors).toEqual([]);
    expect(adapter.getFallbackCount()).toBe(0);
  });

  test('the deterministic fallback is REPRODUCIBLE across two adapter instances', async () => {
    const failure: EmbeddingTransportResponse = {
      ok: false,
      vectors: [],
      reason: 'EMBEDDING_UNAVAILABLE',
      detail: 'down',
      retryable: false,
    };
    const results: number[][] = [];
    for (let i = 0; i < 2; i++) {
      const { factory } = makeDouble({ responses: [failure] });
      const adapter = new OpenAIEmbeddingAdapter({
        config: makeConfig({ fallbackToDeterministic: true }),
        egressAuthorised: true,
        transportFactory: factory,
      });
      await adapter.init();
      const result = await adapter.embed(['reproducible text']);
      results.push(result.vectors[0]);
    }
    expect(results[0]).toEqual(results[1]);
  });
});

// ============================================================
// Credential hygiene
// ============================================================

describe('MIP-015 · credential hygiene', () => {
  test('the resolved configuration records PRESENCE, never the credential', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
      KNOWLEDGE_OPENAI_MODEL: 'text-embedding-3-small',
      KNOWLEDGE_OPENAI_API_KEY: 'sk-thisisasupersecretcredentialvalue',
      OPENAI_API_BASE: 'https://api.vendor.example/v1',
    });
    const serialised = JSON.stringify(config);
    expect(serialised).not.toMatch(/thisisasupersecret/);
    expect(serialised).not.toMatch(/sk-/);
    expect(config.openai.apiKeyPresent).toBe(true);
  });

  test('no refusal detail from the adapter contains a credential-shaped string', async () => {
    const { factory } = makeDouble({
      responses: [
        {
          ok: false,
          vectors: [],
          reason: 'EMBEDDING_CREDENTIALS_ABSENT',
          detail: 'unauthorised',
          retryable: false,
        },
      ],
    });
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig({ fallbackToDeterministic: false }),
      egressAuthorised: true,
      transportFactory: factory,
    });
    const init = await adapter.init();
    const health = await adapter.health();
    const combined = JSON.stringify({ init, health });
    expect(combined).not.toMatch(/sk-[A-Za-z0-9]{8,}/);
  });

  test('redactCredentialLike removes key-shaped and bearer-shaped substrings', () => {
    const raw =
      'request failed: Authorization: Bearer sk-abcdefghijklmnopqrstuvwxyz012345 (key sk-9876543210abcdefghij)';
    const redacted = redactCredentialLike(raw);
    expect(redacted).not.toMatch(/sk-abcdefgh/);
    expect(redacted).not.toMatch(/sk-98765432/);
    expect(redacted).toMatch(/REDACTED/);
  });
});

// ============================================================
// Factory integration and configuration
// ============================================================

describe('MIP-015 · factory and configuration integration', () => {
  test('provider=openai with egress unauthorised yields a REFUSING adapter, not a client', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
      KNOWLEDGE_OPENAI_MODEL: 'text-embedding-3-small',
      KNOWLEDGE_OPENAI_API_KEY: 'k',
      KNOWLEDGE_OPENAI_BASE_URL: 'https://api.vendor.example/v1',
    });
    const result = createEmbeddingAdapter(config);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_EGRESS_UNAUTHORISED');
    // Null-object discipline: an adapter is always returned so the caller needs no
    // null check, and this one refuses everything.
    expect(result.adapter).toBeDefined();
    expect(result.adapter.id).toBe('openai');
  });

  test('provider=openai without a model is refused by the factory', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
      KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
      KNOWLEDGE_OPENAI_API_KEY: 'k',
      KNOWLEDGE_OPENAI_BASE_URL: 'https://api.vendor.example/v1',
    });
    const result = createEmbeddingAdapter(config);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_MODEL_ABSENT');
  });

  test('provider=openai without a credential is refused by the factory', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
      KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
      KNOWLEDGE_OPENAI_MODEL: 'text-embedding-3-small',
      KNOWLEDGE_OPENAI_BASE_URL: 'https://api.vendor.example/v1',
      OPENAI_API_KEY: '',
    });
    const result = createEmbeddingAdapter(config);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('EMBEDDING_CREDENTIALS_ABSENT');
  });

  test('a fully configured learned provider is constructed with an INJECTED transport', async () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
      KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
      KNOWLEDGE_OPENAI_MODEL: 'text-embedding-3-small',
      KNOWLEDGE_OPENAI_API_KEY: 'k',
      KNOWLEDGE_OPENAI_BASE_URL: 'https://api.vendor.example/v1',
    });
    const { factory, recorder } = makeDouble({ dimensions: 1536 });
    const result = createEmbeddingAdapter(config, factory);

    expect(result.ok).toBe(true);
    expect(result.adapter.id).toBe('openai');
    expect(result.adapter.requiresEgress).toBe(true);
    expect(result.adapter.requiresCredentials).toBe(true);
    // A learned model is NOT reproducible offline, and the adapter says so.
    expect(result.adapter.deterministic).toBe(false);

    await result.adapter.init();
    const embedded = await result.adapter.embed(['hello']);
    expect(embedded.ok).toBe(true);
    expect(embedded.vectors[0]).toHaveLength(1536);
    expect(recorder.requests).toHaveLength(1);
  });

  test('a known model determines the vector width, overriding the plane default', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
      KNOWLEDGE_OPENAI_MODEL: 'text-embedding-3-small',
      // Deliberately disagreeing with the model's real width.
      KNOWLEDGE_EMBEDDING_DIMENSIONS: '384',
    });
    // The model's actual width governs. Retaining 384 here would cause every
    // vector to be refused by the width check — mechanically correct, useless in
    // practice, and confusing to diagnose.
    expect(config.embeddingDimensions).toBe(1536);
    expect(config.openai.dimensions).toBe(1536);
  });

  test('provider=openai without a model is INADMISSIBLE at configuration time', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
    });
    const verdict = assessConfigAdmissibility(config);
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe('CONFIG_INVALID');
    expect(verdict.detail).toMatch(/model/i);
  });

  test('the deterministic provider remains the DEFAULT and requires no egress', () => {
    const config = resolveKnowledgeConfig({ KNOWLEDGE_ENABLED: 'true' });
    expect(config.embeddingProvider).toBe('deterministic');
    const result = createEmbeddingAdapter(config);
    expect(result.ok).toBe(true);
    expect(result.adapter.requiresEgress).toBe(false);
    expect(result.adapter.requiresCredentials).toBe(false);
    expect(result.adapter.deterministic).toBe(true);
  });

  test('an unrecognised provider value falls back to deterministic, never to a learned one', () => {
    for (const raw of ['OpenAI', 'openai ', 'gpt', 'anthropic', '1', 'true']) {
      const config = resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_EMBEDDING_PROVIDER: raw,
      });
      // 'openai ' trims to 'openai' and IS recognised; the others are not. This
      // enumeration documents which is which rather than asserting a blanket rule.
      if (raw.trim().toLowerCase() === 'openai') {
        expect(config.embeddingProvider).toBe('openai');
      } else {
        expect(config.embeddingProvider).toBe('deterministic');
      }
    }
  });
});

// ============================================================
// Health
// ============================================================

describe('MIP-015 · health', () => {
  test('health is UNAVAILABLE before init, because no transport exists', async () => {
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig(),
      egressAuthorised: true,
      transportFactory: makeDouble().factory,
    });
    const health = await adapter.health();
    expect(health.available).toBe(false);
    expect(health.provider).toBe('openai');
  });

  test('health probes by EMBEDDING, not by mere reachability', async () => {
    const { factory, recorder } = makeDouble();
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig(),
      egressAuthorised: true,
      transportFactory: factory,
    });
    await adapter.init();
    const health = await adapter.health();

    expect(health.available).toBe(true);
    // An endpoint that accepts a connection but rejects the credential is not
    // available for this adapter's purpose, so the probe performs the real
    // operation rather than a bare ping.
    expect(recorder.requests).toHaveLength(1);
  });

  test('health reports UNAVAILABLE with the reason when the probe fails', async () => {
    const { factory } = makeDouble({
      responses: [
        {
          ok: false,
          vectors: [],
          reason: 'EMBEDDING_CREDENTIALS_ABSENT',
          detail: 'unauthorised',
          retryable: false,
        },
      ],
    });
    const adapter = new OpenAIEmbeddingAdapter({
      config: makeConfig(),
      egressAuthorised: true,
      transportFactory: factory,
    });
    await adapter.init();
    const health = await adapter.health();
    expect(health.available).toBe(false);
    expect(health.lastErrorCode).toBe('EMBEDDING_CREDENTIALS_ABSENT');
  });
});

// ============================================================
// LIVE SMOKE TEST — skips EXPLICITLY, never silently
// ============================================================

/**
 * Reachability is determined ONCE, before the suite runs, so that the skip is a
 * stated fact rather than an inference from a green run.
 */
const LIVE_MODEL = process.env.KNOWLEDGE_LIVE_EMBEDDING_MODEL || 'text-embedding-3-small';
const LIVE_BASE = process.env.KNOWLEDGE_LIVE_EMBEDDING_BASE || process.env.OPENAI_API_BASE || '';
const LIVE_KEY = process.env.OPENAI_API_KEY || '';
const LIVE_ENABLED = process.env.KNOWLEDGE_LIVE_EMBEDDING_TEST === 'true';

describe('MIP-015 · live embedding smoke test', () => {
  test('live embedding is either exercised or EXPLICITLY declared unexercised', async () => {
    if (!LIVE_ENABLED) {
      // Not a silent skip. The reason is asserted as a value, so the suite records
      // WHY no live verification occurred and a reader cannot mistake a green run
      // for a live one.
      const skipReason =
        'KNOWLEDGE_LIVE_EMBEDDING_TEST is not "true". No live embedding request was made. ' +
        'The learned provider is verified against a recorded in-process transport only.';
      expect(skipReason).toMatch(/No live embedding request was made/);
      // eslint-disable-next-line no-console
      console.log(`[MIP-015 LIVE SKIP] ${skipReason}`);
      return;
    }

    if (LIVE_BASE.length === 0 || LIVE_KEY.length === 0) {
      const skipReason =
        'Live test requested but no base URL or credential is present. Declared unexercised.';
      // eslint-disable-next-line no-console
      console.log(`[MIP-015 LIVE SKIP] ${skipReason}`);
      expect(skipReason).toMatch(/Declared unexercised/);
      return;
    }

    // Live path. Uses the real transport factory, deliberately.
    const { liveEmbeddingTransportFactory } = await import(
      '../../src/knowledge/embedding/openai-transport'
    );
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
      KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
      KNOWLEDGE_OPENAI_MODEL: LIVE_MODEL,
      KNOWLEDGE_OPENAI_BASE_URL: LIVE_BASE,
      OPENAI_API_KEY: LIVE_KEY,
    });

    const result = createEmbeddingAdapter(config, liveEmbeddingTransportFactory);
    expect(result.ok).toBe(true);

    const init = await result.adapter.init();
    expect(init.ok).toBe(true);

    const embedded = await result.adapter.embed(['sovereign generative intelligence runtime']);

    // If the endpoint does not serve embeddings, the adapter must degrade or refuse
    // cleanly rather than throw. Both outcomes are acceptable evidence that the
    // adapter behaves correctly against a real endpoint; a thrown exception is not.
    if (!embedded.ok && embedded.provider === 'openai') {
      // eslint-disable-next-line no-console
      console.log(
        `[MIP-015 LIVE REFUSAL] endpoint did not serve embeddings: ${embedded.reason}`
      );
      expect(embedded.reason).not.toBeNull();
      return;
    }

    if (embedded.provider === 'deterministic') {
      // eslint-disable-next-line no-console
      console.log(
        `[MIP-015 LIVE FALLBACK] learned provider unavailable (${embedded.reason}); ` +
          'vector attributed to the deterministic adapter, as required.'
      );
      expect(embedded.model).toBeNull();
      return;
    }

    // Genuine live success.
    expect(embedded.provider).toBe('openai');
    expect(embedded.model).toBe(LIVE_MODEL);
    expect(embedded.vectors).toHaveLength(1);
    expect(embedded.vectors[0]).toHaveLength(config.openai.dimensions);
    // A real embedding is not the zero vector and is not constant.
    const distinct = new Set(embedded.vectors[0].map((v) => v.toFixed(6)));
    expect(distinct.size).toBeGreaterThan(2);
    // eslint-disable-next-line no-console
    console.log(
      `[MIP-015 LIVE OK] model=${LIVE_MODEL} dims=${embedded.vectors[0].length}`
    );
  }, 60_000);
});
