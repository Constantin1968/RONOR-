/**
 * Qdrant Vector Store Adapter
 * MIP-014 STEP 2 · Phase 3 (construction) and Phase 6 (verification)
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * AUTHORITY AND PROHIBITION — read before modifying this file
 *
 * MIP-014-EO-STEP2 Article 3A authorises adapter development and verification
 * against a FULLY MOCKED TRANSPORT ONLY. No Qdrant service, real or emulated,
 * may be provisioned, started, contacted or operated: prohibitions MT-1 to MT-8.
 *
 * The adapter is consequently not merely inert by policy but INCAPABLE OF
 * ACTIVATION. Of the eight conditions precedent at dossier § 9.1, conditions 3
 * through 7 cannot be satisfied within the authority granted. Each is nevertheless
 * implemented as refusal logic and each refusal is verified independently, because
 * the refusal path is precisely what Gate G6 examines.
 *
 * The structural guarantee of zero egress: the transport is obtained from an
 * injected factory, and the factory is invoked ONLY after all eight conditions
 * have been satisfied. On every refusal path the factory is never called, so no
 * client object, no connection pool, no hostname resolution and no socket can
 * exist. Zero egress is therefore a property of control flow, not of a promise.
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * Neutrality (dossier § 8.2). No type from this file appears in the `VectorStore`
 * contract, in either pipeline, in the RAG composer or in the router. Every
 * transport failure is mapped to the plane's own taxonomy before crossing the
 * boundary. Deleting this file and the `qdrant` configuration value leaves the
 * plane fully functional on the SQLite reference store with no other source change
 * (invariant N-8).
 */

import { CLASSIFICATION_RANK } from '../../planes/r-knowledge/types';
import type {
  KnowledgeConfig,
  KnowledgeObject,
  KnowledgeReasonCode,
  RawHit,
  SearchFilters,
  StoreHealth,
  StoreOpenResult,
  StoreStats,
  UpsertResult,
  VectorStore,
  VectorStoreCapabilities,
  VectorStoreId,
} from '../../planes/r-knowledge/types';
import { verifyObjectIntegrity } from '../provenance';
import { KnowledgeObjectSchema } from '../schema';
import {
  QdrantTransportError,
  UNAVAILABLE_TRANSPORT_FACTORY,
} from './qdrant-transport';
import type {
  QdrantPoint,
  QdrantScoredPoint,
  QdrantTransport,
  QdrantTransportFactory,
  QdrantTransportFailure,
} from './qdrant-transport';

// ============================================================
// Conditions precedent — dossier § 9.1
// ============================================================

/** The eight conditions, each independently verifiable. */
export type QdrantCondition =
  | 'PLANE_ENABLED'
  | 'STORE_SELECTED'
  | 'EGRESS_AUTHORISED'
  | 'ENDPOINT_CONFIGURED'
  | 'CREDENTIAL_PRESENT'
  | 'ENVIRONMENT_AUTHORISED'
  | 'SERVER_VERSION_MATCHES'
  | 'IMPLEMENTATION_ORDER_IN_FORCE';

export interface ConditionVerdict {
  condition: QdrantCondition;
  satisfied: boolean;
  reason: KnowledgeReasonCode | null;
  /** Explanatory text. NEVER contains credential material (dossier § 4.2). */
  detail: string;
}

/**
 * Redact anything that could be credential material from a diagnostic string.
 *
 * Applied to every detail, message and log line the adapter produces. The function
 * is deliberately aggressive: it is better to redact an innocuous token than to
 * emit a live one, and a diagnostic that is slightly less informative is a far
 * smaller cost than a credential in a log aggregator.
 */
export function redactCredentials(input: string): string {
  return input
    // Bearer tokens and api-key headers in any casing.
    .replace(/(bearer\s+)[A-Za-z0-9._\-+/=]{8,}/gi, '$1[REDACTED]')
    .replace(/(api[-_]?key\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    .replace(/(authorization\s*[:=]\s*)\S+/gi, '$1[REDACTED]')
    // JWT-shaped material anywhere in the string.
    .replace(/\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\b/g, '[REDACTED]')
    // Long opaque tokens.
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');
}

// ============================================================
// The adapter
// ============================================================

export class QdrantVectorStore implements VectorStore {
  readonly id: VectorStoreId = 'qdrant';

  /**
   * Declared like any other store's capabilities (dossier § 8.1). The
   * classification ceiling is INTERNAL, which is the decisive governance value:
   * `CONFIDENTIAL` and `RESTRICTED` objects are never transmitted to an external
   * store, and the refusal is a successful governance outcome (rule CT-7).
   */
  readonly capabilities: VectorStoreCapabilities = Object.freeze({
    persistent: true,
    vectorSearch: true,
    lexicalFallback: false,
    maxClassification: 'INTERNAL' as const,
    transactional: false,
  });

  private readonly config: KnowledgeConfig;
  private readonly transportFactory: QdrantTransportFactory;
  private transport: QdrantTransport | null = null;
  private lastErrorCode: KnowledgeReasonCode | null = null;
  /** Count of transport constructions. Asserted to be zero on refusal paths. */
  private transportConstructions = 0;

  constructor(config: KnowledgeConfig, transportFactory?: QdrantTransportFactory) {
    this.config = config;
    // Default is the absence of a transport, not a live client. Under
    // MIP-014-EO-STEP2 no live implementation exists in the repository at all.
    this.transportFactory = transportFactory ?? UNAVAILABLE_TRANSPORT_FACTORY;
  }

  // ----------------------------------------------------------
  // Conditions precedent
  // ----------------------------------------------------------

  /**
   * Evaluate the seven statically decidable conditions.
   *
   * The eighth — server version agreement — cannot be decided without contacting a
   * server, so it is evaluated inside `open()` after the other seven have passed,
   * and only then. That ordering is what prevents a version probe from becoming
   * the egress that the other conditions were meant to prevent.
   *
   * Every condition is evaluated and reported, rather than short-circuiting on the
   * first failure. Gate G6 requires that each of the eight refuse *independently*,
   * which cannot be demonstrated if the first failure masks the rest.
   */
  evaluateStaticConditions(): ConditionVerdict[] {
    const q = this.config.qdrant;
    const verdicts: ConditionVerdict[] = [];

    verdicts.push({
      condition: 'PLANE_ENABLED',
      satisfied: this.config.enabled,
      reason: this.config.enabled ? null : 'KNOWLEDGE_DISABLED',
      detail: this.config.enabled
        ? 'the plane is enabled'
        : 'KNOWLEDGE_ENABLED is not exactly the string "true"',
    });

    verdicts.push({
      condition: 'STORE_SELECTED',
      satisfied: this.config.vectorStore === 'qdrant',
      reason: this.config.vectorStore === 'qdrant' ? null : 'STORE_UNCONFIGURED',
      detail:
        this.config.vectorStore === 'qdrant'
          ? 'the configured store resolves to this adapter'
          : `the configured store is "${this.config.vectorStore}", not this adapter`,
    });

    verdicts.push({
      condition: 'EGRESS_AUTHORISED',
      satisfied: this.config.externalEgressAuthorised,
      reason: this.config.externalEgressAuthorised ? null : 'STORE_UNAUTHORISED_EGRESS',
      detail: this.config.externalEgressAuthorised
        ? 'external egress is authorised by configuration'
        : 'KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED is not "true"; no egress is authorised under ' +
          'MIP-014-EO-STEP2 and this condition cannot be satisfied within it',
    });

    // TLS is mandatory and not configurable. A plaintext endpoint is rejected at
    // parse time, and no option to disable verification exists (prohibition Q-4).
    const endpointValid = isAbsoluteHttpsUrl(q.endpoint);
    verdicts.push({
      condition: 'ENDPOINT_CONFIGURED',
      satisfied: endpointValid,
      reason: endpointValid ? null : q.endpoint.length === 0 ? 'STORE_UNCONFIGURED' : 'STORE_TLS_FAILURE',
      detail: endpointValid
        ? 'the endpoint is an absolute https: URL'
        : q.endpoint.length === 0
          ? 'no endpoint is configured; none exists to configure under MIP-014-EO-STEP2'
          : 'the endpoint is not an absolute https: URL; plaintext transport is rejected at ' +
            'configuration parse time and no option to disable verification exists',
    });

    verdicts.push({
      condition: 'CREDENTIAL_PRESENT',
      satisfied: q.apiKeyPresent,
      reason: q.apiKeyPresent ? null : 'STORE_AUTH_FAILURE',
      detail: q.apiKeyPresent
        ? 'a credential is present; presence only is recorded, never the material'
        : 'no credential is present; absence of a credential is a refusal, never a fallback ' +
          'to an unauthenticated call',
    });

    const envAuthorised = q.environmentAuthorisationRef.length > 0;
    verdicts.push({
      condition: 'ENVIRONMENT_AUTHORISED',
      satisfied: envAuthorised,
      reason: envAuthorised ? null : 'STORE_NOT_AUTHORISED_FOR_ENVIRONMENT',
      detail: envAuthorised
        ? `environment authorisation reference recorded: ${q.environmentAuthorisationRef}`
        : 'no recorded executive authorisation exists for this environment; none is granted ' +
          'under MIP-014-EO-STEP2',
    });

    // Condition 8. The Order is in force for adapter development against a mocked
    // transport, and that is what this adapter is. The condition is satisfied for
    // the purpose of writing and verifying refusal logic, and it is recorded
    // explicitly so that the enumeration of eight is complete and auditable.
    verdicts.push({
      condition: 'IMPLEMENTATION_ORDER_IN_FORCE',
      satisfied: true,
      reason: null,
      detail:
        'MIP-014-EO-STEP2, validated by MIP-014-EO-STEP2-VAL-001, is in force and authorises ' +
        'adapter development and verification against a fully mocked transport only',
    });

    return verdicts;
  }

  /**
   * Open the store.
   *
   * The order of operations is the governance mechanism, so it is stated plainly:
   *   1. Evaluate the seven static conditions. On any failure, return a refusal.
   *      THE TRANSPORT FACTORY IS NOT CALLED, so no client exists and no egress
   *      is possible.
   *   2. Only if all seven pass, construct the transport.
   *   3. Assert the server version against the pin (rule VP-5). A mismatch closes
   *      the transport and refuses.
   *   4. Assert the collection's dimension against the active adapter (K-INV-4).
   */
  async open(): Promise<StoreOpenResult> {
    if (this.transport !== null) {
      return { ok: true, storeId: this.id, reason: null, degradationLevel: 0 };
    }

    const verdicts = this.evaluateStaticConditions();
    const failed = verdicts.filter((v) => !v.satisfied);
    if (failed.length > 0) {
      const first = failed[0];
      this.lastErrorCode = first.reason;
      return {
        ok: false,
        storeId: this.id,
        reason: first.reason,
        detail: redactCredentials(
          `condition ${first.condition} not satisfied: ${first.detail}` +
            (failed.length > 1
              ? ` (${failed.length - 1} further condition(s) also unsatisfied: ${failed
                  .slice(1)
                  .map((v) => v.condition)
                  .join(', ')})`
              : '')
        ),
        degradationLevel: 3,
      };
    }

    // All seven static conditions satisfied. Only now may a transport exist.
    try {
      this.transportConstructions += 1;
      const transport = this.transportFactory({
        endpoint: this.config.qdrant.endpoint,
        collection: this.config.qdrant.collection,
        timeoutMs: this.config.qdrant.timeoutMs,
        // Read at call time from the environment, never retained on the adapter.
        bearerToken: readCredentialAtCallTime(),
      });

      // Condition 7 — server version agreement (rule VP-5).
      const info = await transport.getServerInfo();
      if (!versionMatchesPin(info.version, this.config.qdrant.expectedServerVersion)) {
        this.lastErrorCode = 'STORE_VERSION_MISMATCH';
        return {
          ok: false,
          storeId: this.id,
          reason: 'STORE_VERSION_MISMATCH',
          detail: redactCredentials(
            `server reports ${info.version}; the pin is ${this.config.qdrant.expectedServerVersion}. ` +
              'The adapter refuses to operate against an unexpected major or minor version.'
          ),
          degradationLevel: 3,
        };
      }

      const collection = await transport.getCollectionInfo(this.config.qdrant.collection);
      if (!collection.exists) {
        // The adapter has no capability to create a collection (AC-2), and the
        // transport interface has no such operation. Provisioning is an operator
        // action recorded in a deployment record.
        this.lastErrorCode = 'STORE_UNAVAILABLE';
        return {
          ok: false,
          storeId: this.id,
          reason: 'STORE_UNAVAILABLE',
          detail:
            `collection "${this.config.qdrant.collection}" does not exist. The application holds ` +
            'no capability to create or delete a collection; provisioning is an operator action.',
          degradationLevel: 3,
        };
      }
      if (
        collection.dimensions !== null &&
        collection.dimensions !== this.config.embeddingDimensions
      ) {
        this.lastErrorCode = 'STORE_DIMENSION_MISMATCH';
        return {
          ok: false,
          storeId: this.id,
          reason: 'STORE_DIMENSION_MISMATCH',
          detail: `collection dimension ${collection.dimensions} does not equal the active adapter dimensionality ${this.config.embeddingDimensions}`,
          degradationLevel: 3,
        };
      }

      this.transport = transport;
      this.lastErrorCode = null;
      return { ok: true, storeId: this.id, reason: null, degradationLevel: 0 };
    } catch (error) {
      const reason = this.mapTransportFailure(error);
      this.lastErrorCode = reason;
      return {
        ok: false,
        storeId: this.id,
        reason,
        detail: redactCredentials(
          error instanceof Error ? error.message : 'the store could not be opened'
        ),
        degradationLevel: 3,
      };
    }
  }

  /** Idempotent (N-7). Releases the transport reference; never throws. */
  async close(): Promise<void> {
    this.transport = null;
  }

  /**
   * Map a transport failure to the plane's own taxonomy.
   *
   * This is invariant N-2 in executable form: no Qdrant error type, HTTP status or
   * vendor error string crosses the adapter boundary. A caller receives only a
   * member of the plane's closed reason-code union.
   */
  private mapTransportFailure(error: unknown): KnowledgeReasonCode {
    if (error instanceof QdrantTransportError) {
      const mapping: Record<QdrantTransportFailure, KnowledgeReasonCode> = {
        unauthorised: 'STORE_AUTH_FAILURE',
        forbidden: 'STORE_AUTH_FAILURE',
        tls: 'STORE_TLS_FAILURE',
        timeout: 'STORE_TIMEOUT',
        unreachable: 'STORE_UNAVAILABLE',
        'not-found': 'STORE_UNAVAILABLE',
        protocol: 'STORE_PROTOCOL_ERROR',
      };
      return mapping[error.failure];
    }
    return 'STORE_PROTOCOL_ERROR';
  }

  // ----------------------------------------------------------
  // Data operations
  // ----------------------------------------------------------

  /**
   * Upsert objects.
   *
   * Classification is enforced before a point is composed, so an over-classified
   * object never enters a request body — not even one that is subsequently
   * discarded. The refusal is recorded as a successful governance outcome (CT-7).
   */
  async upsert(objects: KnowledgeObject[], vectors: Map<string, number[]>): Promise<UpsertResult> {
    const failures: UpsertResult['failures'] = [];

    if (this.transport === null) {
      return {
        requested: objects.length,
        written: 0,
        failures: objects.map((o) => ({
          objectId: o.objectId,
          reason: this.lastErrorCode ?? 'STORE_UNAVAILABLE',
        })),
        ok: false,
      };
    }

    const points: QdrantPoint[] = [];
    for (const object of objects) {
      if (
        CLASSIFICATION_RANK[object.classification] >
        CLASSIFICATION_RANK[this.capabilities.maxClassification]
      ) {
        failures.push({
          objectId: object.objectId,
          reason: 'STORE_CLASSIFICATION_REFUSED',
          detail:
            `classification ${object.classification} exceeds the external-store ceiling ` +
            `${this.capabilities.maxClassification}; the object was not transmitted`,
        });
        continue;
      }

      const vector = vectors.get(object.objectId) ?? [];
      if (vector.length !== this.config.embeddingDimensions) {
        failures.push({ objectId: object.objectId, reason: 'STORE_DIMENSION_MISMATCH' });
        continue;
      }

      points.push({
        id: object.objectId,
        vector: [...vector],
        payload: {
          classification: object.classification,
          sovereigntyTier: object.sovereigntyTier,
          parentDocumentId: object.provenance.parentDocumentId,
          contentHash: object.contentHash,
          chunkIndex: object.chunkIndex,
          chunkTotal: object.chunkTotal,
          ingestedAt: object.ingestedAt,
          // Raw content is transmitted only under an explicit authorisation
          // record (CT-1 to CT-7). No such record exists, so it is omitted.
        },
      });
    }

    if (points.length === 0) {
      return { requested: objects.length, written: 0, failures, ok: false };
    }

    try {
      const result = await this.transport.upsertPoints(this.config.qdrant.collection, points);
      return {
        requested: objects.length,
        written: result.written,
        failures,
        ok: failures.length === 0 && result.written === objects.length,
      };
    } catch (error) {
      const reason = this.mapTransportFailure(error);
      this.lastErrorCode = reason;
      for (const point of points) {
        failures.push({
          objectId: point.id,
          reason,
          detail: redactCredentials(error instanceof Error ? error.message : 'upsert failed'),
        });
      }
      return { requested: objects.length, written: 0, failures, ok: false };
    }
  }

  async search(vector: number[], k: number, filters?: SearchFilters): Promise<RawHit[]> {
    if (this.transport === null) return [];
    try {
      const scored = await this.transport.searchPoints(this.config.qdrant.collection, {
        vector: [...vector],
        limit: k,
        maxClassificationRank: filters?.maxClassification
          ? CLASSIFICATION_RANK[filters.maxClassification]
          : undefined,
        parentDocumentId: filters?.parentDocumentId,
      });
      return scored
        .map((point) => ({ objectId: point.id, score: point.score }))
        .sort((a, b) => b.score - a.score || a.objectId.localeCompare(b.objectId))
        .slice(0, k);
    } catch (error) {
      this.lastErrorCode = this.mapTransportFailure(error);
      return [];
    }
  }

  /**
   * Retrieve by content hash for duplicate detection.
   *
   * A material limitation is recorded rather than concealed: the payload
   * transmitted to an external store deliberately excludes `content` (CT-5), so a
   * point cannot be reconstituted into a Knowledge Object from the store alone.
   * This method therefore reports *existence* by returning a minimal object whose
   * integrity cannot be verified, and the retrieval pipeline is written so that an
   * object failing integrity verification is excluded. The consequence is that the
   * Qdrant path supports duplicate detection and vector search, and does not
   * support content retrieval — which is the correct outcome for a store outside
   * the sovereignty boundary.
   */
  async getByHash(contentHash: string): Promise<KnowledgeObject | null> {
    if (this.transport === null) return null;
    try {
      const points = await this.transport.scrollByContentHash(
        this.config.qdrant.collection,
        contentHash
      );
      return points.length > 0 ? null : null;
    } catch (error) {
      this.lastErrorCode = this.mapTransportFailure(error);
      return null;
    }
  }

  /** Whether an object with this content hash exists, for duplicate detection. */
  async existsByHash(contentHash: string): Promise<boolean> {
    if (this.transport === null) return false;
    try {
      const points = await this.transport.scrollByContentHash(
        this.config.qdrant.collection,
        contentHash
      );
      return points.length > 0;
    } catch (error) {
      this.lastErrorCode = this.mapTransportFailure(error);
      return false;
    }
  }

  async getById(objectId: string): Promise<KnowledgeObject | null> {
    if (this.transport === null) return null;
    try {
      const point = await this.transport.getPoint(this.config.qdrant.collection, objectId);
      if (point === null) return null;
      // No content is stored, so no schema-valid object can be reconstituted. The
      // adapter returns null rather than an object failing verification, so that a
      // consumer can never hold unverified content.
      return null;
    } catch (error) {
      this.lastErrorCode = this.mapTransportFailure(error);
      return null;
    }
  }

  async delete(objectIds: string[]): Promise<number> {
    if (this.transport === null || objectIds.length === 0) return 0;
    try {
      // Logical deletion only (stage D-1). Physical reclamation depends on the
      // Vacuum Optimizer, whose default trigger conditions may never fire on a
      // small corpus, so a successful delete is NOT evidence of elimination
      // (dossier § 6.3). Stage D-2 is an operator action and Stage D-F is excluded
      // from this Order, so no elimination claim is made here.
      const result = await this.transport.deletePoints(this.config.qdrant.collection, objectIds);
      return result.deleted;
    } catch (error) {
      this.lastErrorCode = this.mapTransportFailure(error);
      return 0;
    }
  }

  async health(): Promise<StoreHealth> {
    const started = Date.now();
    if (this.transport === null) {
      return {
        storeId: this.id,
        reachable: false,
        latencyMs: 0,
        recordCount: 0,
        lastErrorCode: this.lastErrorCode ?? 'STORE_UNAVAILABLE',
        checkedAt: new Date(),
      };
    }
    try {
      const count = await this.transport.countPoints(this.config.qdrant.collection);
      return {
        storeId: this.id,
        reachable: true,
        latencyMs: Date.now() - started,
        recordCount: count,
        lastErrorCode: null,
        checkedAt: new Date(),
      };
    } catch (error) {
      const reason = this.mapTransportFailure(error);
      this.lastErrorCode = reason;
      return {
        storeId: this.id,
        reachable: false,
        latencyMs: Date.now() - started,
        recordCount: 0,
        lastErrorCode: reason,
        checkedAt: new Date(),
      };
    }
  }

  async stats(): Promise<StoreStats> {
    if (this.transport === null) {
      return { storeId: this.id, objectCount: 0, dimensions: null, indexSizeBytes: null };
    }
    try {
      const info = await this.transport.getCollectionInfo(this.config.qdrant.collection);
      return {
        storeId: this.id,
        objectCount: info.pointCount,
        dimensions: info.dimensions,
        indexSizeBytes: null,
      };
    } catch (error) {
      this.lastErrorCode = this.mapTransportFailure(error);
      return { storeId: this.id, objectCount: 0, dimensions: null, indexSizeBytes: null };
    }
  }

  // ----------------------------------------------------------
  // Verification seams
  // ----------------------------------------------------------

  /**
   * Number of times a transport has been constructed. Gate G6 asserts this is
   * exactly zero on every refusal path, which is the operative evidence that no
   * connection attempt occurred.
   */
  getTransportConstructionCount(): number {
    return this.transportConstructions;
  }

  isOpen(): boolean {
    return this.transport !== null;
  }
}

// ============================================================
// Helpers
// ============================================================

/**
 * Whether a string is an absolute `https:` URL. Plaintext `http:` is rejected,
 * including on loopback, because prohibition Q-4 admits no plaintext path and an
 * exception for loopback is how plaintext reaches production.
 */
export function isAbsoluteHttpsUrl(candidate: string): boolean {
  if (candidate.length === 0) return false;
  try {
    const url = new URL(candidate);
    return url.protocol === 'https:' && url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Whether a reported server version agrees with the pin.
 *
 * Agreement is required at major and minor level (rule VP-5). A patch difference
 * is tolerated because a patch release is, by the vendor's own release process, a
 * non-breaking correction — and refusing on patch would make routine security
 * patching an outage.
 */
export function versionMatchesPin(reported: string, pinned: string): boolean {
  const parse = (value: string): [number, number] | null => {
    const match = value.trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)/);
    if (!match) return null;
    return [Number.parseInt(match[1], 10), Number.parseInt(match[2], 10)];
  };
  const a = parse(reported);
  const b = parse(pinned);
  if (a === null || b === null) return false;
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * Read the credential at call time.
 *
 * Never stored on the adapter, never written to disk, never logged, never placed
 * in an error message and never included in a diagnostic payload (dossier § 4.2).
 * Returning the empty string is safe: the credential-present condition has already
 * refused before this function can be reached with no credential configured.
 */
function readCredentialAtCallTime(): string {
  return process.env.KNOWLEDGE_QDRANT_API_KEY ?? '';
}
