/**
 * Qdrant Transport Boundary
 * MIP-014 STEP 2 · Phase 3 (Store Layer) · Phase 6 (Adapter Verification)
 *
 * This module exists so that the Qdrant adapter has a substitutable seam at the
 * module boundary, which is the definition of a mock adopted by the governing
 * Order (Article 3A) and by the Pre-Implementation Dossier § 0.2:
 *
 *   > A mock is an in-process test double substituted at the module boundary that
 *   > performs no network input or output at all: it is the absence of a server,
 *   > not a small one.
 *
 * Two consequences follow, and both are deliberate.
 *
 * First, the transport interface below is expressed in terms of *operations*, not
 * in terms of HTTP. There is no method that takes a URL, no method that returns a
 * response object and no header map anywhere in the signature. A test double
 * therefore satisfies the interface without simulating a network, and the adapter
 * cannot smuggle a request through a generic escape hatch.
 *
 * Second — AMENDED BY MIP-015 STEP 3. Under MIP-014-EO-STEP2 no implementation of
 * this interface performed network input or output: the only implementation was the
 * in-process double used by the adapter's own tests, and `@qdrant/js-client-rest`
 * was deliberately not installed because an Order authorising no egress should not
 * create a capability it withholds.
 *
 * MIP-015 authorises Qdrant as the production store. A LIVE implementation now
 * exists in `qdrant-live-transport.ts`, and the client is installed and pinned
 * exactly. The mocked double remains, and remains the default: the adapter's
 * refusal paths are still proved with no possibility of egress, and the live
 * transport must be injected deliberately.
 */

import type { KnowledgeClassification } from '../../planes/r-knowledge/types';

// ============================================================
// Vendor-neutral transport operations
// ============================================================

/**
 * Payload transmitted with a point.
 *
 * Governance metadata required for filtering only, per dossier § 5.1. There is no
 * field for a credential, an operator identifier, a session identifier or an
 * audit-chain hash, so rule CT-5 is enforced by the *shape* of the type rather
 * than by a reviewer's vigilance.
 *
 * `content` is optional and is transmitted only under an explicit authorisation
 * record (CT-1 to CT-7). No `CONFIDENTIAL` or `RESTRICTED` object reaches this
 * type at all, because the adapter refuses such objects before composing a point.
 */
export interface QdrantPointPayload {
  classification: KnowledgeClassification;
  sovereigntyTier: 1 | 2 | 3;
  parentDocumentId: string;
  contentHash: string;
  chunkIndex: number;
  chunkTotal: number;
  ingestedAt: string;
  content?: string;
}

export interface QdrantPoint {
  /** The Knowledge Object `objectId`. Qdrant accepts UUID identifiers natively,
   *  so no mapping table and no synthetic key exists (dossier § 5.1). */
  id: string;
  vector: number[];
  payload: QdrantPointPayload;
}

export interface QdrantSearchRequest {
  vector: number[];
  limit: number;
  /** Classification ceiling for server-side pre-filtering. This is a retrieval
   *  optimisation only; the governance boundary is plane-side (dossier § 5.3). */
  maxClassificationRank?: number;
  parentDocumentId?: string;
}

export interface QdrantScoredPoint {
  id: string;
  score: number;
  payload: QdrantPointPayload | null;
}

export interface QdrantCollectionInfo {
  exists: boolean;
  pointCount: number;
  dimensions: number | null;
  distance: 'Cosine' | 'Dot' | 'Euclid' | null;
}

export interface QdrantServerInfo {
  version: string;
}

/**
 * Transport failure classification.
 *
 * The classifier is vendor-neutral by construction: the adapter maps every
 * transport failure onto this small closed set, and the plane's own reason-code
 * taxonomy is derived from it. No Qdrant error type, HTTP status or error string
 * crosses the adapter boundary (invariant N-2).
 */
export type QdrantTransportFailure =
  | 'unauthorised'
  | 'forbidden'
  | 'tls'
  | 'timeout'
  | 'unreachable'
  | 'not-found'
  | 'protocol';

export class QdrantTransportError extends Error {
  readonly failure: QdrantTransportFailure;

  constructor(failure: QdrantTransportFailure, message: string) {
    super(message);
    this.name = 'QdrantTransportError';
    this.failure = failure;
  }
}

/**
 * Collection provisioning specification.
 *
 * Deliberately minimal: a name, a width and a metric. There is no shard count, no
 * replication factor and no quantisation setting, because those are capacity and
 * durability decisions belonging to whoever operates the cluster — not to an
 * application that merely needs somewhere to put vectors.
 */
export interface QdrantCollectionSpec {
  dimensions: number;
  distance: 'Cosine' | 'Dot' | 'Euclid';
}

/**
 * The operations the adapter requires of a Qdrant server.
 *
 * Note what is still absent, and why.
 *
 * `deleteCollection` does not exist. Prohibition AC-2 denies the application the
 * capability to destroy a collection, and an interface that lacks the operation
 * cannot exercise it even if a credential were mistakenly over-scoped. Elimination
 * remains an operator action recorded in a deployment record. There is likewise no
 * snapshot operation.
 *
 * `createCollection` DOES now exist — amended by MIP-015 STEP 3, which requires
 * collection auto-creation with correct vector dimensions. The capability is
 * narrowly drawn and doubly gated:
 *
 *   1. It can only CREATE, never destroy or reshape. An existing collection is
 *      never touched by it.
 *   2. The adapter invokes it only when `autoCreateCollection` is explicitly
 *      enabled in configuration. The default is DISABLED, so a deployment that has
 *      not asked for provisioning still refuses on a missing collection exactly as
 *      it did under MIP-014.
 *
 * The asymmetry between create and delete is intentional rather than an oversight:
 * creating an empty collection is recoverable by deleting it, whereas deleting a
 * populated one is not recoverable at all.
 */
export interface QdrantTransport {
  /** Server version, asserted against the pin at initialisation (rule VP-5). */
  getServerInfo(): Promise<QdrantServerInfo>;
  getCollectionInfo(collection: string): Promise<QdrantCollectionInfo>;
  upsertPoints(collection: string, points: QdrantPoint[]): Promise<{ written: number }>;
  searchPoints(collection: string, request: QdrantSearchRequest): Promise<QdrantScoredPoint[]>;
  getPoint(collection: string, id: string): Promise<QdrantScoredPoint | null>;
  /** Scroll with a payload filter, used for content-hash duplicate detection. */
  scrollByContentHash(collection: string, contentHash: string): Promise<QdrantScoredPoint[]>;
  deletePoints(collection: string, ids: string[]): Promise<{ deleted: number }>;
  countPoints(collection: string): Promise<number>;
  /**
   * Create a collection. Optional on the interface so that a transport which
   * cannot or must not provision simply does not offer it, and the adapter then
   * refuses on a missing collection rather than failing at the call site.
   */
  createCollection?(collection: string, spec: QdrantCollectionSpec): Promise<void>;
}

/**
 * Factory type for obtaining a transport.
 *
 * The adapter receives a factory rather than a transport, so that the transport is
 * constructed only after every condition precedent has been satisfied. This is
 * what makes "zero egress on refusal" a structural property: on any refusal path
 * the factory is never called, so no client object, no connection pool and no
 * socket can exist.
 */
export type QdrantTransportFactory = (options: QdrantTransportOptions) => QdrantTransport;

export interface QdrantTransportOptions {
  endpoint: string;
  collection: string;
  timeoutMs: number;
  /** Supplied at call time and never retained by the adapter (dossier § 4.2). */
  bearerToken: string;
}

/**
 * The absence of a transport.
 *
 * Returned when no transport factory has been injected, which is the state of the
 * plane in every environment reachable under MIP-014-EO-STEP2. Every method
 * refuses with `unreachable`, and no method performs input or output of any kind.
 *
 * This is not a stub server. It presents no network surface, binds no port,
 * resolves no hostname and opens no socket. It is the absence of a server.
 */
export const UNAVAILABLE_TRANSPORT_FACTORY: QdrantTransportFactory = () => ({
  async getServerInfo(): Promise<QdrantServerInfo> {
    throw new QdrantTransportError(
      'unreachable',
      'No Qdrant transport implementation is present. MIP-014-EO-STEP2 authorises adapter ' +
        'development and verification against a fully mocked transport only; no live client ' +
        'is installed and no service may be provisioned, started, contacted or operated.'
    );
  },
  async getCollectionInfo(): Promise<QdrantCollectionInfo> {
    throw new QdrantTransportError('unreachable', 'no transport implementation is present');
  },
  async upsertPoints(): Promise<{ written: number }> {
    throw new QdrantTransportError('unreachable', 'no transport implementation is present');
  },
  async searchPoints(): Promise<QdrantScoredPoint[]> {
    throw new QdrantTransportError('unreachable', 'no transport implementation is present');
  },
  async getPoint(): Promise<QdrantScoredPoint | null> {
    throw new QdrantTransportError('unreachable', 'no transport implementation is present');
  },
  async scrollByContentHash(): Promise<QdrantScoredPoint[]> {
    throw new QdrantTransportError('unreachable', 'no transport implementation is present');
  },
  async deletePoints(): Promise<{ deleted: number }> {
    throw new QdrantTransportError('unreachable', 'no transport implementation is present');
  },
  async countPoints(): Promise<number> {
    throw new QdrantTransportError('unreachable', 'no transport implementation is present');
  },
  async createCollection(): Promise<void> {
    throw new QdrantTransportError('unreachable', 'no transport implementation is present');
  },
});
