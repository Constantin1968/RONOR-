/**
 * Deployment Health — R-Knowledge dependency readiness
 * MIP-015 STEP 3 · Requirement 4
 *
 * A readiness report an operator can act on, distinguishing three states that a
 * single boolean would collapse:
 *
 *   READY        the dependency is configured, reachable and usable
 *   DEGRADED     the dependency is configured but not currently usable
 *   NOT_CONFIGURED  the dependency was never asked for
 *
 * The third state is the one usually lost, and losing it is expensive. An unconfigured
 * store reported as "unhealthy" sends an operator hunting for an outage that does not
 * exist; reported as "healthy" it hides a deployment that will never retrieve anything.
 * Neither is true, so neither is reported.
 *
 * This module performs NO probing of its own. It reads state the plane has already
 * established, so calling it is free and cannot itself cause egress — which matters
 * because a health endpoint is typically polled by an orchestrator every few seconds,
 * and a health check that opened a connection each time would be a load generator.
 */

import type { KnowledgeConfig, DegradationState, StoreHealth } from '../planes/r-knowledge/types';

export type DependencyReadiness = 'ready' | 'degraded' | 'not-configured';

export interface DependencyReport {
  name: string;
  readiness: DependencyReadiness;
  /** What is configured, with no credential and no secret. */
  target: string | null;
  detail: string;
  /** The remedy, when there is one. Null when nothing is wrong. */
  remedy: string | null;
}

export interface KnowledgeDeploymentReport {
  /** True only when the plane can serve retrieval end to end. */
  operational: boolean;
  planeEnabled: boolean;
  degradationLevel: number;
  degradationName: string;
  environmentClass: string;
  dependencies: DependencyReport[];
  /**
   * A single sentence an operator can read without decoding the rest. Present in
   * every state, including the healthy one.
   */
  summary: string;
  checkedAt: string;
}

/**
 * Redact an endpoint for reporting.
 *
 * Scheme, host and port are retained because they are what an operator needs to
 * confirm they are pointed at the right place. Userinfo is removed: a credential
 * embedded in a URL is still a credential, and a health endpoint is frequently the
 * least protected surface in a deployment.
 */
function safeEndpoint(raw: string | null | undefined): string | null {
  if (!raw || raw.length === 0) return null;
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}${url.port ? `:${url.port}` : ''}`;
  } catch {
    // Unparseable. Reporting the raw value risks echoing a malformed credential.
    return '[unparseable endpoint]';
  }
}

/**
 * Build the deployment readiness report.
 */
export function buildDeploymentReport(input: {
  config: KnowledgeConfig | null;
  degradation: DegradationState | null;
  storeHealth: StoreHealth | null;
  embedderAvailable: boolean;
  embedderProvider: string | null;
  embedderLastError: string | null;
  now?: () => Date;
}): KnowledgeDeploymentReport {
  const now = (input.now ?? (() => new Date()))();

  // The plane is absent entirely. Reported as a configuration state, not a fault:
  // this is the correct posture for every deployment that has not enabled it.
  if (input.config === null || !input.config.enabled) {
    return {
      operational: false,
      planeEnabled: false,
      degradationLevel: 0,
      degradationName: 'not-enabled',
      environmentClass: 'unknown',
      dependencies: [],
      summary:
        'R-Knowledge is not enabled. No store or embedding dependency is required, and ' +
        'the runtime is serving exactly as it does without the plane.',
      checkedAt: now.toISOString(),
    };
  }

  const config = input.config;
  const dependencies: DependencyReport[] = [];

  // ---- Vector store ----
  if (config.vectorStore === 'null' || config.vectorStore === null) {
    dependencies.push({
      name: 'vector-store',
      readiness: 'not-configured',
      target: null,
      detail: 'no vector store is selected, so nothing can be stored or retrieved',
      remedy: 'set KNOWLEDGE_VECTOR_STORE to qdrant (production) or sqlite (development)',
    });
  } else if (config.vectorStore === 'qdrant') {
    const endpoint = safeEndpoint(config.qdrant.endpoint);
    if (endpoint === null) {
      dependencies.push({
        name: 'vector-store',
        readiness: 'not-configured',
        target: null,
        detail: 'qdrant is selected but no endpoint is configured',
        remedy: 'set QDRANT_URL (or KNOWLEDGE_QDRANT_ENDPOINT) to an absolute https endpoint',
      });
    } else if (input.storeHealth?.reachable === true) {
      dependencies.push({
        name: 'vector-store',
        readiness: 'ready',
        target: `qdrant ${endpoint} collection=${config.qdrant.collection}`,
        detail: `reachable, ${input.storeHealth.recordCount} object(s) present`,
        remedy: null,
      });
    } else {
      // The reason code is surfaced verbatim, because the remedy differs sharply:
      // an auth failure is a credential problem, a TLS failure is a certificate
      // problem, and unreachability is a network problem.
      const code = input.storeHealth?.lastErrorCode ?? 'STORE_UNAVAILABLE';
      dependencies.push({
        name: 'vector-store',
        readiness: 'degraded',
        target: `qdrant ${endpoint} collection=${config.qdrant.collection}`,
        detail: `configured but not usable (${code})`,
        remedy: remedyForStoreCode(code),
      });
    }
  } else {
    // SQLite. Reported with its environment restriction attached, because a
    // deployment that believes it has a production store when it has a development
    // one is the specific misunderstanding worth preventing.
    const usable = input.storeHealth?.reachable === true;
    dependencies.push({
      name: 'vector-store',
      readiness: usable ? 'ready' : 'degraded',
      target: `sqlite ${config.sqlitePath ?? '(no path)'}`,
      detail: usable
        ? `reachable, ${input.storeHealth?.recordCount ?? 0} object(s) present ` +
          '(authorised for ci, test and development ONLY)'
        : `not usable (${input.storeHealth?.lastErrorCode ?? 'STORE_UNAVAILABLE'})`,
      remedy: usable
        ? null
        : 'confirm KNOWLEDGE_SQLITE_PATH is writable, or select qdrant for production',
    });
  }

  // ---- Embedding provider ----
  if (input.embedderProvider === 'deterministic') {
    dependencies.push({
      name: 'embedding-provider',
      readiness: input.embedderAvailable ? 'ready' : 'degraded',
      target: 'deterministic (no egress, no credential)',
      detail: input.embedderAvailable
        ? 'reproducible hashed projection; captures lexical overlap and little semantic structure'
        : `unavailable (${input.embedderLastError ?? 'unknown'})`,
      remedy: input.embedderAvailable
        ? null
        : 'the deterministic embedder requires no external resource; this indicates a defect',
    });
  } else if (input.embedderAvailable) {
    dependencies.push({
      name: 'embedding-provider',
      readiness: 'ready',
      target: `${input.embedderProvider ?? 'unknown'} model=${config.embeddingModel ?? '(unnamed)'}`,
      detail: `learned provider reachable at ${safeEndpoint(config.openai.baseUrl) ?? '(no endpoint)'}`,
      remedy: null,
    });
  } else {
    dependencies.push({
      name: 'embedding-provider',
      readiness: 'degraded',
      target: `${input.embedderProvider ?? 'unknown'} model=${config.embeddingModel ?? '(unnamed)'}`,
      detail: `configured but not usable (${input.embedderLastError ?? 'unknown'})`,
      remedy: remedyForEmbeddingCode(input.embedderLastError),
    });
  }

  const level = input.degradation?.level ?? 3;
  const operational = level === 0 && dependencies.every((d) => d.readiness === 'ready');

  return {
    operational,
    planeEnabled: true,
    degradationLevel: level,
    degradationName: input.degradation?.name ?? 'unknown',
    environmentClass: config.environmentClass,
    dependencies,
    summary: operational
      ? `R-Knowledge is operational at degradation level 0 with ${dependencies.length} ` +
        'dependency(ies) ready.'
      : `R-Knowledge is enabled but NOT fully operational (level ${level}: ` +
        `${input.degradation?.name ?? 'unknown'}). ` +
        dependencies
          .filter((d) => d.readiness !== 'ready')
          .map((d) => `${d.name} is ${d.readiness}`)
          .join('; ') +
        '.',
    checkedAt: now.toISOString(),
  };
}

/** Map a store reason code to the action that actually resolves it. */
function remedyForStoreCode(code: string): string {
  switch (code) {
    case 'STORE_AUTH_FAILURE':
      return 'the credential was rejected or is absent: check QDRANT_API_KEY';
    case 'STORE_TLS_FAILURE':
      return 'the endpoint must be absolute https, and its certificate must be trusted';
    case 'STORE_TIMEOUT':
      return 'the server did not respond in time: check network path and KNOWLEDGE_QDRANT_TIMEOUT_MS';
    case 'STORE_VERSION_MISMATCH':
      return 'the server version disagrees with the pinned version this adapter was verified against';
    case 'STORE_NOT_AUTHORISED_FOR_ENVIRONMENT':
      return 'set KNOWLEDGE_QDRANT_ENVIRONMENT_AUTHORISATION to the authorisation reference for this environment';
    case 'STORE_UNAUTHORISED_EGRESS':
      return 'set KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED=true to permit egress to the store';
    case 'STORE_CIRCUIT_OPEN':
      return 'repeated failures opened the circuit; it closes automatically once the store recovers';
    case 'SQLITE_PROHIBITED_IN_PRODUCTION':
      return 'sqlite is prohibited in production: configure qdrant';
    default:
      return 'the store is unreachable: confirm the endpoint, the network path and that the collection exists';
  }
}

function remedyForEmbeddingCode(code: string | null): string {
  switch (code) {
    case 'EMBEDDING_EGRESS_UNAUTHORISED':
      return 'set KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED=true to permit egress to the embedding provider';
    case 'EMBEDDING_CREDENTIALS_ABSENT':
      return 'set KNOWLEDGE_OPENAI_API_KEY';
    case 'EMBEDDING_MODEL_ABSENT':
      return 'set KNOWLEDGE_OPENAI_MODEL: there is deliberately no vendor default';
    case 'EMBEDDING_DIMENSION_MISMATCH':
      return 'the model returns a different width than KNOWLEDGE_EMBEDDING_DIMENSIONS declares; ' +
        'correct the declared width rather than truncating vectors';
    default:
      return 'confirm the endpoint, the credential and the named model';
  }
}
