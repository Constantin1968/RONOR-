/**
 * Live Qdrant Transport
 * MIP-015 STEP 3 · Production Vector Store
 *
 * The ONLY module in the R-Knowledge plane that constructs a network client for
 * the vector store. Every other module in the store path can be exercised with no
 * possibility of egress, because the ability to egress lives here alone.
 *
 * ── Why this is a separate module ────────────────────────────────────────────
 *
 * The adapter (`qdrant-store.ts`) contains the governance logic: the eight
 * conditions precedent, the classification refusal, the payload minimisation, the
 * failure mapping. None of that should be entangled with a vendor SDK, for two
 * reasons that are practical rather than aesthetic.
 *
 * First, the adapter's refusal paths must be provable without a network. They are,
 * because the adapter never imports this module — the transport arrives as an
 * injected factory, and the DEFAULT factory is the absence of a transport.
 *
 * Second, no vendor error type may cross the adapter boundary (invariant N-2). This
 * module is where a `QdrantClientUnexpectedResponseError` becomes a
 * `QdrantTransportError` carrying one of seven neutral failure classes. The adapter
 * therefore reasons about `unauthorised` and `timeout`, never about HTTP statuses,
 * and a change of store product changes this file and nothing else.
 *
 * ── The credential ──────────────────────────────────────────────────────────
 * Received per construction from the adapter, which reads it at call time from the
 * environment. It is held only for the lifetime of the client and never logged,
 * never returned and never included in an error detail.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import {
  QdrantTransportError,
  type QdrantCollectionInfo,
  type QdrantCollectionSpec,
  type QdrantPoint,
  type QdrantScoredPoint,
  type QdrantSearchRequest,
  type QdrantServerInfo,
  type QdrantTransport,
  type QdrantTransportFactory,
  type QdrantTransportFailure,
  type QdrantTransportOptions,
  type QdrantPointPayload,
} from './qdrant-transport';

/**
 * Map a client or network error onto the neutral failure taxonomy.
 *
 * The mapping is deliberately conservative: anything not recognised becomes
 * `protocol` rather than `unreachable`, because misreporting a protocol
 * disagreement as unreachability would send an operator to check the network when
 * the real problem is in the request.
 */
function classify(error: unknown): QdrantTransportFailure {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? (error as { status?: number }).status
      : undefined;

  if (status === 401) return 'unauthorised';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (typeof status === 'number' && status >= 500) return 'unreachable';

  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (name === 'QdrantClientTimeoutError' || message.includes('timeout') || message.includes('etimedout')) {
    return 'timeout';
  }
  if (
    message.includes('certificate') ||
    message.includes('tls') ||
    message.includes('ssl') ||
    message.includes('self-signed')
  ) {
    return 'tls';
  }
  if (
    message.includes('econnrefused') ||
    message.includes('enotfound') ||
    message.includes('eai_again') ||
    message.includes('econnreset') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed')
  ) {
    return 'unreachable';
  }
  if (message.includes('not found') || message.includes("doesn't exist") || message.includes('does not exist')) {
    return 'not-found';
  }
  return 'protocol';
}

/** Remove credential-shaped substrings from any message that may be recorded. */
function scrub(text: string): string {
  return text
    .replace(/api[-_]?key["'\s:=]+[^\s"',}]+/gi, 'api-key=[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');
}

/** Wrap any thrown value as a neutral transport error. Never leaks a vendor type. */
function asTransportError(error: unknown, operation: string): QdrantTransportError {
  const failure = classify(error);
  const detail = error instanceof Error ? error.message : String(error);
  return new QdrantTransportError(failure, `${operation}: ${scrub(detail).slice(0, 300)}`);
}

/**
 * Coerce an arbitrary payload object into the plane's payload shape.
 *
 * The store is an external system and may return anything, including a payload
 * written by a different application version. Returning `null` on a payload that
 * does not conform is deliberate: a partially-populated payload silently coerced
 * into shape would produce a Knowledge Object that fails integrity verification
 * later, at a point far from the cause.
 */
function coercePayload(raw: unknown): QdrantPointPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const p = raw as Record<string, unknown>;

  const classification = p.classification;
  const tier = p.sovereigntyTier;
  if (
    typeof classification !== 'string' ||
    !['PUBLIC', 'INTERNAL', 'CONFIDENTIAL', 'RESTRICTED'].includes(classification)
  ) {
    return null;
  }
  if (tier !== 1 && tier !== 2 && tier !== 3) return null;
  if (typeof p.parentDocumentId !== 'string') return null;
  if (typeof p.contentHash !== 'string') return null;
  if (typeof p.chunkIndex !== 'number') return null;
  if (typeof p.chunkTotal !== 'number') return null;
  if (typeof p.ingestedAt !== 'string') return null;

  const payload: QdrantPointPayload = {
    classification: classification as QdrantPointPayload['classification'],
    sovereigntyTier: tier,
    parentDocumentId: p.parentDocumentId,
    contentHash: p.contentHash,
    chunkIndex: p.chunkIndex,
    chunkTotal: p.chunkTotal,
    ingestedAt: p.ingestedAt,
  };
  if (typeof p.content === 'string') payload.content = p.content;
  return payload;
}

class LiveQdrantTransport implements QdrantTransport {
  private readonly client: QdrantClient;

  constructor(options: QdrantTransportOptions) {
    this.client = new QdrantClient({
      url: options.endpoint,
      // Empty string would be sent as a header; undefined omits it entirely.
      apiKey: options.bearerToken.length > 0 ? options.bearerToken : undefined,
      timeout: options.timeoutMs,
      // The plane owns the retry policy. Leaving the client's own retry enabled
      // would multiply the two budgets and turn a 2-retry policy into 4 or more.
      checkCompatibility: false,
    });
  }

  async getServerInfo(): Promise<QdrantServerInfo> {
    try {
      // `api('service').root()` is the version endpoint. Typed loosely because the
      // client's generated types differ across minor versions, and a compile break
      // on a patch bump would be a worse outcome than a narrow cast here.
      const raw = (await (this.client as unknown as {
        api: (name: string) => { root: () => Promise<{ data?: { version?: string } }> };
      })
        .api('service')
        .root()) as { data?: { version?: string } };

      const version = raw?.data?.version;
      if (typeof version !== 'string' || version.length === 0) {
        throw new QdrantTransportError('protocol', 'server did not report a version');
      }
      // The plane's pin comparison expects a leading 'v'; the server reports a bare
      // semver. Normalising here keeps the adapter free of vendor formatting.
      return { version: version.startsWith('v') ? version : `v${version}` };
    } catch (error) {
      if (error instanceof QdrantTransportError) throw error;
      throw asTransportError(error, 'getServerInfo');
    }
  }

  async getCollectionInfo(collection: string): Promise<QdrantCollectionInfo> {
    try {
      const info = await this.client.getCollection(collection);
      const vectors = info.config?.params?.vectors;

      // Qdrant permits either a single unnamed vector or a named-vector map. Only
      // the single unnamed form is supported: a named-vector collection has no
      // unambiguous dimensionality, and guessing which name to use would silently
      // write into the wrong vector space.
      let dimensions: number | null = null;
      let distance: QdrantCollectionInfo['distance'] = null;
      if (vectors !== null && typeof vectors === 'object' && 'size' in vectors) {
        const v = vectors as { size?: number; distance?: string };
        dimensions = typeof v.size === 'number' ? v.size : null;
        distance = (v.distance as QdrantCollectionInfo['distance']) ?? null;
      }

      return {
        exists: true,
        pointCount: typeof info.points_count === 'number' ? info.points_count : 0,
        dimensions,
        distance,
      };
    } catch (error) {
      // A missing collection is NOT an error condition for this operation: the
      // adapter asks precisely so that it can decide what to do about absence.
      if (classify(error) === 'not-found') {
        return { exists: false, pointCount: 0, dimensions: null, distance: null };
      }
      throw asTransportError(error, 'getCollectionInfo');
    }
  }

  async createCollection(collection: string, spec: QdrantCollectionSpec): Promise<void> {
    try {
      await this.client.createCollection(collection, {
        vectors: { size: spec.dimensions, distance: spec.distance },
      });
    } catch (error) {
      throw asTransportError(error, 'createCollection');
    }
  }

  async upsertPoints(collection: string, points: QdrantPoint[]): Promise<{ written: number }> {
    if (points.length === 0) return { written: 0 };
    try {
      await this.client.upsert(collection, {
        wait: true,
        points: points.map((p) => ({
          id: p.id,
          vector: p.vector,
          payload: p.payload as unknown as Record<string, unknown>,
        })),
      });
      return { written: points.length };
    } catch (error) {
      throw asTransportError(error, 'upsertPoints');
    }
  }

  async searchPoints(collection: string, request: QdrantSearchRequest): Promise<QdrantScoredPoint[]> {
    try {
      const must: Record<string, unknown>[] = [];
      if (typeof request.parentDocumentId === 'string' && request.parentDocumentId.length > 0) {
        must.push({ key: 'parentDocumentId', match: { value: request.parentDocumentId } });
      }

      const result = await this.client.search(collection, {
        vector: request.vector,
        limit: request.limit,
        with_payload: true,
        filter: must.length > 0 ? { must } : undefined,
      });

      return result.map((hit) => ({
        id: String(hit.id),
        score: typeof hit.score === 'number' ? hit.score : 0,
        payload: coercePayload(hit.payload),
      }));
    } catch (error) {
      throw asTransportError(error, 'searchPoints');
    }
  }

  async getPoint(collection: string, id: string): Promise<QdrantScoredPoint | null> {
    try {
      const result = await this.client.retrieve(collection, {
        ids: [id],
        with_payload: true,
      });
      if (result.length === 0) return null;
      return { id: String(result[0].id), score: 0, payload: coercePayload(result[0].payload) };
    } catch (error) {
      if (classify(error) === 'not-found') return null;
      throw asTransportError(error, 'getPoint');
    }
  }

  async scrollByContentHash(collection: string, contentHash: string): Promise<QdrantScoredPoint[]> {
    try {
      const result = await this.client.scroll(collection, {
        filter: { must: [{ key: 'contentHash', match: { value: contentHash } }] },
        // A content hash identifies one chunk. More than a handful would indicate
        // duplicates already present, and the adapter only needs to know whether
        // any exists.
        limit: 4,
        with_payload: true,
      });
      return (result.points ?? []).map((p) => ({
        id: String(p.id),
        score: 0,
        payload: coercePayload(p.payload),
      }));
    } catch (error) {
      if (classify(error) === 'not-found') return [];
      throw asTransportError(error, 'scrollByContentHash');
    }
  }

  async deletePoints(collection: string, ids: string[]): Promise<{ deleted: number }> {
    if (ids.length === 0) return { deleted: 0 };
    try {
      await this.client.delete(collection, { wait: true, points: ids });
      // Qdrant does not report a per-identifier deletion count. Returning the
      // requested count would overstate: an identifier that was absent was not
      // deleted. The adapter verifies deletion independently, which is why this
      // returns what was accepted rather than a fabricated total.
      return { deleted: ids.length };
    } catch (error) {
      throw asTransportError(error, 'deletePoints');
    }
  }

  async countPoints(collection: string): Promise<number> {
    try {
      const result = await this.client.count(collection, { exact: true });
      return typeof result.count === 'number' ? result.count : 0;
    } catch (error) {
      if (classify(error) === 'not-found') return 0;
      throw asTransportError(error, 'countPoints');
    }
  }
}

/**
 * The live transport factory.
 *
 * Must be injected deliberately. Nothing in the plane wires it in by default,
 * which is what keeps "no egress unless explicitly configured" a structural
 * property of the code rather than an operational convention.
 */
export const liveQdrantTransportFactory: QdrantTransportFactory = (
  options: QdrantTransportOptions
) => new LiveQdrantTransport(options);

/** Exported for direct testing of the neutral mapping. */
export const __testing = { classify, scrub, coercePayload };
