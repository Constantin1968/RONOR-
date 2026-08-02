/**
 * R-Knowledge — Deployment Readiness
 * MIP-015 STEP 3 · Requirement 4
 *
 * What is verified here is the QUALITY OF THE DIAGNOSTIC, which is a different thing
 * from the correctness of the plane. A plane that fails correctly but reports the
 * failure uselessly costs an operator hours; the report must distinguish a dependency
 * that is broken from one that was never configured, and it must name the action that
 * resolves each failure rather than merely stating that something is wrong.
 */

import { buildDeploymentReport } from '../../src/knowledge/deployment-health';
import { resolveKnowledgeConfig } from '../../src/planes/r-knowledge/config';
import { initialDegradation } from '../../src/knowledge/degradation';
import type { StoreHealth, KnowledgeReasonCode } from '../../src/planes/r-knowledge/types';

const FIXED_NOW = () => new Date('2026-08-03T12:00:00Z');

function storeHealth(overrides: Partial<StoreHealth> = {}): StoreHealth {
  return {
    storeId: 'qdrant',
    reachable: true,
    latencyMs: 4,
    recordCount: 12,
    lastErrorCode: null,
    checkedAt: FIXED_NOW(),
    ...overrides,
  };
}

const QDRANT_ENV: Record<string, string> = {
  KNOWLEDGE_ENABLED: 'true',
  KNOWLEDGE_VECTOR_STORE: 'qdrant',
  KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED: 'true',
  QDRANT_URL: 'https://qdrant.internal.example:6333',
  QDRANT_API_KEY: 'not-a-real-credential',
  QDRANT_COLLECTION_NAME: 'ronor_knowledge',
  KNOWLEDGE_QDRANT_ENVIRONMENT_AUTHORISATION: 'MIP-015',
  KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
};

describe('Deployment readiness · the three states a boolean would collapse', () => {
  test('a DISABLED plane reports a configuration state, not a fault', () => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig({ KNOWLEDGE_ENABLED: 'false' }),
      degradation: null,
      storeHealth: null,
      embedderAvailable: false,
      embedderProvider: null,
      embedderLastError: null,
      now: FIXED_NOW,
    });

    expect(report.planeEnabled).toBe(false);
    expect(report.operational).toBe(false);
    // No dependency is listed, because none is required. Listing a store as
    // "unhealthy" here would send an operator to investigate an outage that does not
    // exist.
    expect(report.dependencies).toEqual([]);
    expect(report.summary).toMatch(/not enabled/i);
    // And the summary says the runtime is fine, which is the operative fact.
    expect(report.summary).toMatch(/serving exactly as it does without the plane/i);
  });

  test('a store that was never configured is NOT-CONFIGURED, not degraded', () => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_VECTOR_STORE: 'qdrant',
        KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
      }),
      degradation: initialDegradation(),
      storeHealth: null,
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });

    const store = report.dependencies.find((d) => d.name === 'vector-store')!;
    // THE DISTINCTION THAT MATTERS. 'degraded' would mean "it broke"; the truth is
    // "you never told me where it is", and the remedy is completely different.
    expect(store.readiness).toBe('not-configured');
    expect(store.remedy).toMatch(/QDRANT_URL/);
    expect(store.target).toBeNull();
  });

  test('a configured but unreachable store is DEGRADED and names the remedy', () => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig(QDRANT_ENV),
      degradation: initialDegradation(),
      storeHealth: storeHealth({
        reachable: false,
        lastErrorCode: 'STORE_AUTH_FAILURE' as KnowledgeReasonCode,
      }),
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });

    const store = report.dependencies.find((d) => d.name === 'vector-store')!;
    expect(store.readiness).toBe('degraded');
    // The remedy is SPECIFIC to the reason code. A generic "check your configuration"
    // would be true of every failure and therefore useful for none.
    expect(store.remedy).toMatch(/QDRANT_API_KEY/);
  });

  test.each([
    ['STORE_AUTH_FAILURE', /QDRANT_API_KEY/],
    ['STORE_TLS_FAILURE', /https/],
    ['STORE_TIMEOUT', /TIMEOUT_MS|network path/],
    ['STORE_VERSION_MISMATCH', /version/],
    ['STORE_NOT_AUTHORISED_FOR_ENVIRONMENT', /ENVIRONMENT_AUTHORISATION/],
    ['STORE_UNAUTHORISED_EGRESS', /EXTERNAL_EGRESS_AUTHORISED/],
    ['SQLITE_PROHIBITED_IN_PRODUCTION', /sqlite is prohibited/],
  ])('the remedy for %s is actionable and distinct', (code, expected) => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig(QDRANT_ENV),
      degradation: initialDegradation(),
      storeHealth: storeHealth({ reachable: false, lastErrorCode: code as KnowledgeReasonCode }),
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });
    const store = report.dependencies.find((d) => d.name === 'vector-store')!;
    expect(store.remedy).toMatch(expected);
  });

  test('a fully ready deployment is operational and says so in one sentence', () => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig(QDRANT_ENV),
      degradation: initialDegradation(),
      storeHealth: storeHealth(),
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });

    expect(report.operational).toBe(true);
    expect(report.degradationLevel).toBe(0);
    expect(report.dependencies.every((d) => d.readiness === 'ready')).toBe(true);
    expect(report.summary).toMatch(/operational at degradation level 0/);
    // A summary exists in the HEALTHY state too. A diagnostic that speaks only when
    // something is wrong leaves a reader unable to tell "all well" from "not checked".
    expect(report.summary.length).toBeGreaterThan(20);
  });
});

describe('Deployment readiness · credential and endpoint hygiene', () => {
  test('NO credential appears anywhere in the report', () => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig({
        ...QDRANT_ENV,
        QDRANT_API_KEY: 'super-secret-qdrant-key',
        KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
        KNOWLEDGE_OPENAI_BASE_URL: 'https://api.openai.example/v1',
        KNOWLEDGE_OPENAI_API_KEY: 'sk-super-secret-openai-key',
        KNOWLEDGE_OPENAI_MODEL: 'text-embedding-3-small',
        KNOWLEDGE_EMBEDDING_DIMENSIONS: '1536',
      }),
      degradation: initialDegradation(),
      storeHealth: storeHealth(),
      embedderAvailable: true,
      embedderProvider: 'openai',
      embedderLastError: null,
      now: FIXED_NOW,
    });

    // A health endpoint is frequently the least protected surface in a deployment,
    // and it is polled constantly, so a credential leaked here is a credential
    // leaked into every log that records the poll.
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('super-secret-qdrant-key');
    expect(serialised).not.toContain('sk-super-secret-openai-key');
  });

  test('userinfo embedded in an endpoint URL is STRIPPED', () => {
    // A credential in a URL is still a credential, and this is exactly how one
    // reaches a status payload unnoticed: nobody thinks of the endpoint as a secret.
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig({
        ...QDRANT_ENV,
        QDRANT_URL: 'https://user:hunter2@qdrant.internal.example:6333',
      }),
      degradation: initialDegradation(),
      storeHealth: storeHealth(),
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });

    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('hunter2');
    expect(serialised).not.toContain('user:');
    // The host IS retained, because an operator needs to confirm the target.
    expect(serialised).toContain('qdrant.internal.example:6333');
  });

  test('an unparseable endpoint is reported as such rather than echoed', () => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig({ ...QDRANT_ENV, QDRANT_URL: 'not a url at all' }),
      degradation: initialDegradation(),
      storeHealth: storeHealth({ reachable: false, lastErrorCode: 'STORE_UNAVAILABLE' }),
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });
    const serialised = JSON.stringify(report);
    expect(serialised).not.toContain('not a url at all');
  });
});

describe('Deployment readiness · graceful degradation', () => {
  test('SQLite readiness carries its ENVIRONMENT RESTRICTION in the detail', () => {
    // The specific misunderstanding worth preventing: a deployment believing it has a
    // production store when it has a development one. The restriction travels with
    // the report rather than living only in documentation.
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig({
        KNOWLEDGE_ENABLED: 'true',
        KNOWLEDGE_VECTOR_STORE: 'sqlite',
        KNOWLEDGE_SQLITE_PATH: '/tmp/k.db',
        KNOWLEDGE_ENVIRONMENT_CLASS: 'development',
      }),
      degradation: initialDegradation(),
      storeHealth: storeHealth({ storeId: 'sqlite', recordCount: 3 }),
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });

    const store = report.dependencies.find((d) => d.name === 'vector-store')!;
    expect(store.readiness).toBe('ready');
    expect(store.detail).toMatch(/ci, test and development ONLY/);
  });

  test('the deterministic embedder is reported with its LIMITATION, not just as ready', () => {
    // 'ready' alone would let a reader assume semantic retrieval. It is a hashed
    // projection, and a deployment relying on it for semantic search will be
    // disappointed in a way no status colour would have warned them about.
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig(QDRANT_ENV),
      degradation: initialDegradation(),
      storeHealth: storeHealth(),
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });
    const embedder = report.dependencies.find((d) => d.name === 'embedding-provider')!;
    expect(embedder.readiness).toBe('ready');
    expect(embedder.detail).toMatch(/little semantic structure/);
    expect(embedder.target).toMatch(/no egress, no credential/);
  });

  test.each([
    ['EMBEDDING_EGRESS_UNAUTHORISED', /EXTERNAL_EGRESS_AUTHORISED/],
    ['EMBEDDING_CREDENTIALS_ABSENT', /OPENAI_API_KEY/],
    ['EMBEDDING_MODEL_ABSENT', /no vendor default/i],
    ['EMBEDDING_DIMENSION_MISMATCH', /rather than truncating/],
  ])('a learned-provider failure %s names its own remedy', (code, expected) => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig({
        ...QDRANT_ENV,
        KNOWLEDGE_EMBEDDING_PROVIDER: 'openai',
        KNOWLEDGE_EMBEDDING_DIMENSIONS: '1536',
      }),
      degradation: initialDegradation(),
      storeHealth: storeHealth(),
      embedderAvailable: false,
      embedderProvider: 'openai',
      embedderLastError: code,
      now: FIXED_NOW,
    });
    const embedder = report.dependencies.find((d) => d.name === 'embedding-provider')!;
    expect(embedder.readiness).toBe('degraded');
    expect(embedder.remedy).toMatch(expected);
  });

  test('a report is produced on EVERY path and never throws', () => {
    // A health check that raises is worse than one that reports a problem: the
    // orchestrator polling it sees a crashed endpoint rather than a degraded
    // dependency, and the actual fault is hidden behind the reporting fault.
    const pathologicalInputs = [
      { vectorStore: 'qdrant', endpoint: undefined },
      { vectorStore: 'sqlite', endpoint: undefined },
      { vectorStore: 'none', endpoint: undefined },
    ];
    for (const input of pathologicalInputs) {
      expect(() =>
        buildDeploymentReport({
          config: resolveKnowledgeConfig({
            KNOWLEDGE_ENABLED: 'true',
            KNOWLEDGE_VECTOR_STORE: input.vectorStore,
            KNOWLEDGE_ENVIRONMENT_CLASS: 'production',
          }),
          degradation: null,
          storeHealth: null,
          embedderAvailable: false,
          embedderProvider: null,
          embedderLastError: null,
          now: FIXED_NOW,
        })
      ).not.toThrow();
    }
  });

  test('an unknown degradation level still yields a readable summary', () => {
    const report = buildDeploymentReport({
      config: resolveKnowledgeConfig(QDRANT_ENV),
      degradation: null,
      storeHealth: storeHealth({ reachable: false, lastErrorCode: 'STORE_UNAVAILABLE' }),
      embedderAvailable: true,
      embedderProvider: 'deterministic',
      embedderLastError: null,
      now: FIXED_NOW,
    });
    // Defaults to the most pessimistic level rather than the most optimistic: an
    // unknown state reported as healthy is the dangerous direction to fail.
    expect(report.degradationLevel).toBe(3);
    expect(report.operational).toBe(false);
    expect(report.summary).toMatch(/NOT fully operational/);
  });
});
