/**
 * Fully Mocked Qdrant Transport — in-process test double
 * MIP-014 STEP 2 · Phases 3 and 6
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS, AND WHAT IT IS DELIBERATELY NOT
 *
 * This is an in-process test double substituted at the module boundary. It is the
 * definition of a mock adopted by MIP-014-EO-STEP2 Article 3A and by the
 * Pre-Implementation Dossier § 0.2:
 *
 *   > A mock is an in-process test double substituted at the module boundary that
 *   > performs no network input or output at all: it is the absence of a server,
 *   > not a small one.
 *
 * It therefore contains NO socket, NO listener, NO port binding, NO hostname
 * resolution, NO HTTP client, NO child process and NO container. It is NOT an
 * emulator, a simulator, a stub server, a testcontainer, a compose service or a
 * local double presenting a network surface. Prohibitions MT-1 to MT-8 are
 * satisfied by the absence of the capability, not by a policy against using it.
 *
 * The mechanical test stated by the Order is that the adapter suite passes with
 * all outbound network capability disabled. This double satisfies that test
 * trivially, because it performs no input or output at all: its entire state is a
 * JavaScript Map held in the test process's own heap.
 * ══════════════════════════════════════════════════════════════════════════════
 */

import { cosineSimilarity } from '../../../src/knowledge/embedding/deterministic-adapter';
import {
  QdrantTransportError,
} from '../../../src/knowledge/stores/qdrant-transport';
import type {
  QdrantCollectionInfo,
  QdrantPoint,
  QdrantScoredPoint,
  QdrantSearchRequest,
  QdrantServerInfo,
  QdrantTransport,
  QdrantTransportFactory,
  QdrantTransportFailure,
} from '../../../src/knowledge/stores/qdrant-transport';
import { CLASSIFICATION_RANK } from '../../../src/planes/r-knowledge/types';

export interface MockTransportOptions {
  dimensions: number;
  /** Version the double reports. Defaults to the pinned server version. */
  serverVersion?: string;
  /** Whether the collection is reported as existing. Defaults to true. */
  collectionExists?: boolean;
  /** Dimension the collection reports, for testing disagreement. */
  collectionDimensions?: number;
  /** Injected failure, applied to every operation, for degradation testing. */
  failWith?: QdrantTransportFailure;
  /** Injected failure applied only to write operations. */
  failWritesWith?: QdrantTransportFailure;
  /** Injected failure applied only to collection creation (MIP-015). */
  failCreateWith?: QdrantTransportFailure;
  /**
   * Omit the `createCollection` method entirely, modelling a transport that
   * cannot provision. The adapter must then refuse rather than call an absent
   * method (MIP-015).
   */
  omitCreateCollection?: boolean;
  /**
   * Report the collection as still absent AFTER a successful creation, modelling a
   * server that acknowledges a create it did not perform. The adapter must refuse
   * on re-read rather than proceed against storage whose state it cannot confirm.
   */
  createSilentlyFails?: boolean;
}

export interface MockTransportRecorder {
  /** Number of times the factory was invoked. Asserted zero on refusal paths. */
  factoryInvocations: number;
  /** Every operation name observed, in order. */
  operations: string[];
  /** Points currently held. The double's entire state. */
  points: Map<string, QdrantPoint>;
  /** Every value the adapter passed as a bearer token, for hygiene assertions. */
  tokensObserved: string[];
  /** Collections created through the double, with the spec each was created from. */
  collectionsCreated: { collection: string; dimensions: number; distance: string }[];
}

export const PINNED_SERVER_VERSION = 'v1.18.3';

/**
 * Construct a mocked transport factory together with a recorder.
 *
 * The recorder is returned separately so that a test can assert what the adapter
 * did — in particular, that the factory was never invoked on a refusal path, which
 * is the operative evidence for zero egress.
 */
export function makeMockQdrantTransportWithRecorder(
  options: MockTransportOptions
): { factory: QdrantTransportFactory; recorder: MockTransportRecorder } {
  const recorder: MockTransportRecorder = {
    factoryInvocations: 0,
    operations: [],
    points: new Map<string, QdrantPoint>(),
    tokensObserved: [],
    collectionsCreated: [],
  };

  // Existence is STATEFUL in the double, because auto-creation is only meaningful
  // if a collection that did not exist can come to exist. A double reporting a
  // fixed value could not distinguish a successful creation from a no-op.
  let collectionPresent = options.collectionExists ?? true;

  const factory: QdrantTransportFactory = (transportOptions) => {
    recorder.factoryInvocations += 1;
    recorder.tokensObserved.push(transportOptions.bearerToken);

    const guard = (operation: string, isWrite = false): void => {
      recorder.operations.push(operation);
      if (options.failWith) {
        throw new QdrantTransportError(options.failWith, `injected ${options.failWith} failure`);
      }
      if (isWrite && options.failWritesWith) {
        throw new QdrantTransportError(
          options.failWritesWith,
          `injected ${options.failWritesWith} write failure`
        );
      }
    };

    const transport: QdrantTransport = {
      async getServerInfo(): Promise<QdrantServerInfo> {
        guard('getServerInfo');
        return { version: options.serverVersion ?? PINNED_SERVER_VERSION };
      },

      async getCollectionInfo(): Promise<QdrantCollectionInfo> {
        guard('getCollectionInfo');
        if (!collectionPresent) {
          return { exists: false, pointCount: 0, dimensions: null, distance: null };
        }
        return {
          exists: true,
          pointCount: recorder.points.size,
          dimensions: options.collectionDimensions ?? options.dimensions,
          distance: 'Cosine',
        };
      },

      async upsertPoints(_collection: string, points: QdrantPoint[]): Promise<{ written: number }> {
        guard('upsertPoints', true);
        for (const point of points) {
          // The double asserts the governance property the adapter is meant to
          // enforce: an over-ceiling classification must never arrive here.
          if (CLASSIFICATION_RANK[point.payload.classification] > CLASSIFICATION_RANK.INTERNAL) {
            throw new Error(
              'MOCK ASSERTION FAILURE: an object classified above INTERNAL reached the ' +
                'transport. The adapter must refuse before transmission (rule CT-7).'
            );
          }
          recorder.points.set(point.id, point);
        }
        return { written: points.length };
      },

      async searchPoints(
        _collection: string,
        request: QdrantSearchRequest
      ): Promise<QdrantScoredPoint[]> {
        guard('searchPoints');
        const scored: QdrantScoredPoint[] = [];
        for (const point of recorder.points.values()) {
          if (
            request.maxClassificationRank !== undefined &&
            CLASSIFICATION_RANK[point.payload.classification] > request.maxClassificationRank
          ) {
            continue;
          }
          if (
            request.parentDocumentId !== undefined &&
            point.payload.parentDocumentId !== request.parentDocumentId
          ) {
            continue;
          }
          scored.push({
            id: point.id,
            score: cosineSimilarity(request.vector, point.vector),
            payload: point.payload,
          });
        }
        scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        return scored.slice(0, request.limit);
      },

      async getPoint(_collection: string, id: string): Promise<QdrantScoredPoint | null> {
        guard('getPoint');
        const point = recorder.points.get(id);
        return point ? { id: point.id, score: 1, payload: point.payload } : null;
      },

      async scrollByContentHash(
        _collection: string,
        contentHash: string
      ): Promise<QdrantScoredPoint[]> {
        guard('scrollByContentHash');
        const matches: QdrantScoredPoint[] = [];
        for (const point of recorder.points.values()) {
          if (point.payload.contentHash === contentHash) {
            matches.push({ id: point.id, score: 1, payload: point.payload });
          }
        }
        return matches;
      },

      async deletePoints(_collection: string, ids: string[]): Promise<{ deleted: number }> {
        guard('deletePoints', true);
        let deleted = 0;
        for (const id of ids) {
          if (recorder.points.delete(id)) deleted += 1;
        }
        return { deleted };
      },

      async countPoints(): Promise<number> {
        guard('countPoints');
        return recorder.points.size;
      },
    };

    // Provisioning is attached CONDITIONALLY, so that a transport genuinely lacking
    // the capability can be modelled. The adapter must detect absence and refuse,
    // rather than calling a method that is not there.
    if (!options.omitCreateCollection) {
      transport.createCollection = async (
        collection: string,
        spec: { dimensions: number; distance: string }
      ): Promise<void> => {
        guard('createCollection', true);
        if (options.failCreateWith) {
          throw new QdrantTransportError(
            options.failCreateWith,
            `injected ${options.failCreateWith} creation failure`
          );
        }
        recorder.collectionsCreated.push({
          collection,
          dimensions: spec.dimensions,
          distance: spec.distance,
        });
        // A server that acknowledges a create it did not perform. The adapter's
        // re-read must catch this; without the re-read it would proceed against a
        // collection that does not exist.
        if (!options.createSilentlyFails) {
          collectionPresent = true;
        }
      };
    }

    return transport;
  };

  return { factory, recorder };
}

/** Convenience wrapper where the recorder is not required. */
export function makeMockQdrantTransportFactory(
  options: MockTransportOptions
): QdrantTransportFactory {
  return makeMockQdrantTransportWithRecorder(options).factory;
}
