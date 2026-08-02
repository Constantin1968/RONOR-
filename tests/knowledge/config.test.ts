/**
 * R-Knowledge — Configuration Resolver Tests
 * MIP-014 STEP 2 · Phase 1 · Gate G1
 *
 * The activation predicate is the most governance-sensitive expression in the
 * plane, so it is tested against the exact enumeration of values named by the
 * Order at Article 2.2: '1', 'yes', 'TRUE', empty and unset must all yield
 * DISABLED, and only the lowercase literal 'true' may enable.
 */

import {
  KNOWLEDGE_DEFAULTS,
  QDRANT_PINNED_CLIENT_VERSION,
  QDRANT_PINNED_IMAGE_DIGEST,
  QDRANT_PINNED_SERVER_VERSION,
  assessConfigAdmissibility,
  isKnowledgeEnabled,
  resolveKnowledgeConfig,
} from '../../src/planes/r-knowledge/config';
import type { EnvSource } from '../../src/planes/r-knowledge/config';

const EMPTY_ENV: EnvSource = {};

describe('R-Knowledge · activation predicate (RK-001)', () => {
  test("the exact lowercase literal 'true' enables the plane", () => {
    expect(isKnowledgeEnabled({ KNOWLEDGE_ENABLED: 'true' })).toBe(true);
  });

  test.each([
    ['1', '1'],
    ['yes', 'yes'],
    ['TRUE', 'TRUE'],
    ['True', 'True'],
    ['tRuE', 'tRuE'],
    ['on', 'on'],
    ['enabled', 'enabled'],
    ['false', 'false'],
    ['0', '0'],
    ['empty string', ''],
    ['whitespace', ' true '],
  ])('%s yields DISABLED', (_label, value) => {
    expect(isKnowledgeEnabled({ KNOWLEDGE_ENABLED: value })).toBe(false);
  });

  test('an unset variable yields DISABLED', () => {
    expect(isKnowledgeEnabled(EMPTY_ENV)).toBe(false);
    expect(isKnowledgeEnabled({ KNOWLEDGE_ENABLED: undefined })).toBe(false);
  });

  test('the resolved configuration reports the same predicate result', () => {
    expect(resolveKnowledgeConfig(EMPTY_ENV).enabled).toBe(false);
    expect(resolveKnowledgeConfig({ KNOWLEDGE_ENABLED: 'TRUE' }).enabled).toBe(false);
    expect(resolveKnowledgeConfig({ KNOWLEDGE_ENABLED: 'true' }).enabled).toBe(true);
  });

  test('the resolved configuration is frozen and therefore immutable', () => {
    const config = resolveKnowledgeConfig(EMPTY_ENV);
    expect(Object.isFrozen(config)).toBe(true);
    expect(() => {
      (config as unknown as { enabled: boolean }).enabled = true;
    }).toThrow();
  });
});

describe('R-Knowledge · vendor independence (RK-018)', () => {
  test('the default embedding provider is deterministic with a null model', () => {
    const config = resolveKnowledgeConfig(EMPTY_ENV);
    expect(config.embeddingProvider).toBe('deterministic');
    expect(config.embeddingModel).toBeNull();
  });

  test('an empty KNOWLEDGE_EMBEDDING_MODEL stays null and never becomes a vendor string', () => {
    expect(resolveKnowledgeConfig({ KNOWLEDGE_EMBEDDING_MODEL: '' }).embeddingModel).toBeNull();
    expect(resolveKnowledgeConfig({ KNOWLEDGE_EMBEDDING_MODEL: '   ' }).embeddingModel).toBeNull();
  });

  test('no default in the resolver names any vendor model', () => {
    const serialised = JSON.stringify(KNOWLEDGE_DEFAULTS);
    expect(serialised).not.toMatch(/text-embedding/i);
    expect(serialised).not.toMatch(/gpt-/i);
    expect(serialised).not.toMatch(/openai/i);
  });
});

describe('R-Knowledge · store selection', () => {
  test('the default store is sqlite', () => {
    expect(resolveKnowledgeConfig(EMPTY_ENV).vectorStore).toBe('sqlite');
  });

  test('"none" resolves to the null store', () => {
    expect(resolveKnowledgeConfig({ KNOWLEDGE_VECTOR_STORE: 'none' }).vectorStore).toBe('null');
  });

  test('qdrant is selectable as a store identifier', () => {
    expect(resolveKnowledgeConfig({ KNOWLEDGE_VECTOR_STORE: 'qdrant' }).vectorStore).toBe('qdrant');
  });

  test('chroma is excluded for the current baseline and never silently substituted', () => {
    // ADR-K02 Rev 3 § 3: excluded for this baseline. Naming it selects nothing,
    // and in particular does not fall back to sqlite.
    expect(resolveKnowledgeConfig({ KNOWLEDGE_VECTOR_STORE: 'chroma' }).vectorStore).toBe('null');
    expect(resolveKnowledgeConfig({ KNOWLEDGE_VECTOR_STORE: 'chromadb' }).vectorStore).toBe('null');
  });

  test('an unrecognised store value resolves to the null store, not to a default with storage', () => {
    expect(resolveKnowledgeConfig({ KNOWLEDGE_VECTOR_STORE: 'postgres' }).vectorStore).toBe('null');
  });
});

describe('R-Knowledge · egress gate', () => {
  test('external egress is unauthorised by default', () => {
    expect(resolveKnowledgeConfig(EMPTY_ENV).externalEgressAuthorised).toBe(false);
  });

  test('the egress gate is as strict as the master switch', () => {
    expect(
      resolveKnowledgeConfig({ KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'TRUE' }).externalEgressAuthorised
    ).toBe(false);
    expect(
      resolveKnowledgeConfig({ KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: '1' }).externalEgressAuthorised
    ).toBe(false);
    expect(
      resolveKnowledgeConfig({ KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true' }).externalEgressAuthorised
    ).toBe(true);
  });

  test('RAG is disabled by default and requires the exact literal', () => {
    expect(resolveKnowledgeConfig(EMPTY_ENV).ragEnabled).toBe(false);
    expect(resolveKnowledgeConfig({ KNOWLEDGE_RAG_ENABLED: 'yes' }).ragEnabled).toBe(false);
    expect(resolveKnowledgeConfig({ KNOWLEDGE_RAG_ENABLED: 'true' }).ragEnabled).toBe(true);
  });
});

describe('R-Knowledge · numeric and classification resolution', () => {
  test('malformed numerics fall back to the declared default rather than to NaN', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_EMBEDDING_DIMENSIONS: 'not-a-number',
      KNOWLEDGE_CHUNK_SIZE_TOKENS: '',
      KNOWLEDGE_RETRIEVAL_TOP_K: '-4',
      KNOWLEDGE_MIN_SIMILARITY: '9.5',
    });
    expect(config.embeddingDimensions).toBe(KNOWLEDGE_DEFAULTS.embeddingDimensions);
    expect(config.chunkSizeTokens).toBe(KNOWLEDGE_DEFAULTS.chunkSizeTokens);
    expect(config.retrievalTopK).toBe(KNOWLEDGE_DEFAULTS.retrievalTopK);
    expect(config.minSimilarity).toBe(KNOWLEDGE_DEFAULTS.minSimilarity);
  });

  test('an unrecognised classification falls back to the default ceiling', () => {
    expect(resolveKnowledgeConfig({ KNOWLEDGE_MAX_CLASSIFICATION: 'SECRET' }).maxClassification).toBe(
      'INTERNAL'
    );
    expect(resolveKnowledgeConfig({ KNOWLEDGE_MAX_CLASSIFICATION: 'public' }).maxClassification).toBe(
      'PUBLIC'
    );
  });
});

describe('R-Knowledge · environment classification', () => {
  test('an explicit classification takes precedence over NODE_ENV', () => {
    expect(
      resolveKnowledgeConfig({ KNOWLEDGE_ENVIRONMENT_CLASS: 'production', NODE_ENV: 'development' })
        .environmentClass
    ).toBe('production');
  });

  test('CI is detected from the conventional variables', () => {
    expect(resolveKnowledgeConfig({ CI: 'true' }).environmentClass).toBe('ci');
    expect(resolveKnowledgeConfig({ GITHUB_ACTIONS: 'true' }).environmentClass).toBe('ci');
  });

  test('NODE_ENV production classifies the environment as production', () => {
    expect(resolveKnowledgeConfig({ NODE_ENV: 'production' }).environmentClass).toBe('production');
  });

  test('the default classification is development', () => {
    expect(resolveKnowledgeConfig(EMPTY_ENV).environmentClass).toBe('development');
  });
});

describe('R-Knowledge · configuration admissibility (RK-016a, RK-016b)', () => {
  test('production with sqlite is refused with SQLITE_PROHIBITED_IN_PRODUCTION', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
      KNOWLEDGE_VECTOR_STORE: 'sqlite',
    });
    const verdict = assessConfigAdmissibility(config);
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe('SQLITE_PROHIBITED_IN_PRODUCTION');
  });

  /**
   * SUPERSESSION NOTICE — MIP-015 STEP 3.
   *
   * Under MIP-014 no vector store held written production authorisation, and this
   * suite asserted that BOTH `qdrant` and `none` were refused in production with
   * NO_AUTHORISED_PRODUCTION_STORE (ADR-K02 Revision 3 recorded Qdrant as a
   * validation candidate expressly NOT production-certified).
   *
   * Chairman Executive Order MIP-015 authorises Qdrant as the production store.
   * The assertions below therefore state the NEW policy. The previous assertion is
   * not deleted silently: it is recorded here as superseded, together with the
   * authority that superseded it, so that a reader can see the policy changed by
   * decision rather than by drift.
   *
   * What did NOT change, and is asserted immediately below:
   *   - SQLite remains prohibited in production.
   *   - An authorised store still requires a configured endpoint; authorisation is
   *     not the same thing as configuration.
   */
  test('production with qdrant and a configured endpoint is admissible (MIP-015 supersession)', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
      KNOWLEDGE_VECTOR_STORE: 'qdrant',
      QDRANT_URL: 'https://qdrant.internal.example:6333',
    });
    const verdict = assessConfigAdmissibility(config);
    expect(verdict.admissible).toBe(true);
    expect(verdict.reason).toBeNull();
  });

  test('production with qdrant but NO endpoint is refused — authorisation is not configuration', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
      KNOWLEDGE_VECTOR_STORE: 'qdrant',
    });
    const verdict = assessConfigAdmissibility(config);
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe('CONFIG_INVALID');
    expect(verdict.detail).toMatch(/endpoint/i);
  });

  test('production with the null store is admissible as an explicit choice', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
      KNOWLEDGE_VECTOR_STORE: 'none',
    });
    const verdict = assessConfigAdmissibility(config);
    expect(verdict.admissible).toBe(true);
  });

  test('SQLite remains prohibited in production after the MIP-015 supersession', () => {
    // The supersession authorised ONE store. It did not relax the SQLite
    // prohibition, and this assertion exists so that a future edit widening the
    // production policy cannot take SQLite with it unnoticed.
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_ENABLED: 'true',
      KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
      KNOWLEDGE_VECTOR_STORE: 'sqlite',
      QDRANT_URL: 'https://qdrant.internal.example:6333',
    });
    const verdict = assessConfigAdmissibility(config);
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe('SQLITE_PROHIBITED_IN_PRODUCTION');
  });

  test('sqlite is admissible in ci, test and development', () => {
    for (const environmentClass of ['ci', 'test', 'development']) {
      const config = resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_ENVIRONMENT_CLASS: environmentClass,
        KNOWLEDGE_VECTOR_STORE: 'sqlite',
      });
      expect(assessConfigAdmissibility(config).admissible).toBe(true);
    }
  });

  test('an overlap not smaller than the chunk size is refused as invalid configuration', () => {
    const config = resolveKnowledgeConfig({
      KNOWLEDGE_CHUNK_SIZE_TOKENS: '128',
      KNOWLEDGE_CHUNK_OVERLAP_TOKENS: '128',
    });
    const verdict = assessConfigAdmissibility(config);
    expect(verdict.admissible).toBe(false);
    expect(verdict.reason).toBe('CONFIG_INVALID');
  });
});

describe('R-Knowledge · Qdrant reference configuration (dossier 9a, 9c, 9d, 9e)', () => {
  test('the pinned versions are exactly those recorded by the dossier', () => {
    expect(QDRANT_PINNED_SERVER_VERSION).toBe('v1.18.3');
    expect(QDRANT_PINNED_CLIENT_VERSION).toBe('1.18.0');
    expect(QDRANT_PINNED_IMAGE_DIGEST).toBe(
      'sha256:0bd98fa7977f1e75694779359ca4e212822e5a71334e28421182f72f209d5286'
    );
  });

  test('the endpoint is empty by default — no endpoint is authorised', () => {
    const config = resolveKnowledgeConfig(EMPTY_ENV);
    expect(config.qdrant.endpoint).toBe('');
    expect(config.qdrant.environmentAuthorisationRef).toBe('');
  });

  test('TLS is required and is not configurable', () => {
    const config = resolveKnowledgeConfig({ KNOWLEDGE_QDRANT_TLS: 'false' });
    expect(config.qdrant.tlsRequired).toBe(true);
  });

  test('only the presence of a credential is recorded, never the material', () => {
    const config = resolveKnowledgeConfig({ KNOWLEDGE_QDRANT_API_KEY: 'super-secret-token' });
    expect(config.qdrant.apiKeyPresent).toBe(true);
    expect(JSON.stringify(config)).not.toContain('super-secret-token');
  });

  test('the collection name is the access-control unit and has a governed default', () => {
    expect(resolveKnowledgeConfig(EMPTY_ENV).qdrant.collection).toBe('ronor_knowledge');
    expect(
      resolveKnowledgeConfig({ KNOWLEDGE_QDRANT_COLLECTION: 'ronor_corpus_ro' }).qdrant.collection
    ).toBe('ronor_corpus_ro');
  });

  test('telemetry-disabled is recorded from the documented control key', () => {
    expect(resolveKnowledgeConfig(EMPTY_ENV).qdrant.telemetryDisabled).toBe(false);
    expect(
      resolveKnowledgeConfig({ QDRANT__TELEMETRY_DISABLED: 'true' }).qdrant.telemetryDisabled
    ).toBe(true);
  });
});
