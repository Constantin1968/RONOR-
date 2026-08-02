/**
 * R-Knowledge — Degradation Ladder Tests
 * MIP-014 STEP 2 · Phase 3 · Gate G3
 *
 * Gate G3 requires that all four levels be reachable, that every level be
 * reversible without restart or data loss, and that level 3 be an explicit
 * unavailable result rather than an empty success.
 */

import {
  computeDegradation,
  ingestionPermitted,
  initialDegradation,
  levelForReason,
  refusalStatus,
  resultsAreDegraded,
  retrievalPermitted,
  transitionIsReversible,
} from '../../src/knowledge/degradation';
import type { DependencyHealth } from '../../src/knowledge/degradation';
import type { KnowledgeReasonCode } from '../../src/planes/r-knowledge/types';

const HEALTHY: DependencyHealth = {
  storeAvailable: true,
  storeWritable: true,
  storeCircuitOpen: false,
  embedderAvailable: true,
  lastStoreErrorCode: null,
  lastEmbedderErrorCode: null,
};

describe('R-Knowledge · degradation levels', () => {
  test('level 0 when store and embedder are both available', () => {
    const state = computeDegradation(HEALTHY);
    expect(state.level).toBe(0);
    expect(state.name).toBe('normal');
    expect(state.reason).toBeNull();
  });

  test('level 1 on embedder refusal (RK-020)', () => {
    const state = computeDegradation({
      ...HEALTHY,
      embedderAvailable: false,
      lastEmbedderErrorCode: 'EMBEDDING_EGRESS_UNAUTHORISED',
    });
    expect(state.level).toBe(1);
    expect(state.name).toBe('embedding-degraded');
    expect(state.reason).toBe('EMBEDDING_EGRESS_UNAUTHORISED');
    // Ingestion continues, storing objects without vectors.
    expect(ingestionPermitted(state)).toBe(true);
    // Results must be visibly marked, because the scores are non-semantic.
    expect(resultsAreDegraded(state)).toBe(true);
  });

  test('level 2 when the store is reachable but refusing writes', () => {
    const state = computeDegradation({
      ...HEALTHY,
      storeWritable: false,
      lastStoreErrorCode: 'STORE_WRITE_REFUSED',
    });
    expect(state.level).toBe(2);
    expect(state.name).toBe('store-degraded');
    // Read-only: retrieval continues, ingestion is refused with 503.
    expect(retrievalPermitted(state)).toBe(true);
    expect(ingestionPermitted(state)).toBe(false);
    expect(refusalStatus(state)).toBe(503);
  });

  test('level 2 when the circuit is open', () => {
    const state = computeDegradation({ ...HEALTHY, storeCircuitOpen: true });
    expect(state.level).toBe(2);
    expect(state.reason).toBe('STORE_CIRCUIT_OPEN');
  });

  test('level 3 when the store is unavailable (RK-021)', () => {
    const state = computeDegradation({
      ...HEALTHY,
      storeAvailable: false,
      lastStoreErrorCode: 'STORE_UNAVAILABLE',
    });
    expect(state.level).toBe(3);
    expect(state.name).toBe('plane-unavailable');
    expect(state.reason).toBe('STORE_UNAVAILABLE');
    // The decisive property: retrieval is refused outright. It does not return
    // an empty success, which would invite substituted model knowledge.
    expect(retrievalPermitted(state)).toBe(false);
    expect(ingestionPermitted(state)).toBe(false);
  });

  test('store unavailability outranks embedder unavailability', () => {
    // Reporting level 1 here would advertise a lexical fallback with no corpus.
    const state = computeDegradation({
      ...HEALTHY,
      storeAvailable: false,
      embedderAvailable: false,
    });
    expect(state.level).toBe(3);
  });

  test('all four levels are reachable', () => {
    const levels = new Set([
      computeDegradation(HEALTHY).level,
      computeDegradation({ ...HEALTHY, embedderAvailable: false }).level,
      computeDegradation({ ...HEALTHY, storeWritable: false }).level,
      computeDegradation({ ...HEALTHY, storeAvailable: false }).level,
    ]);
    expect(levels).toEqual(new Set([0, 1, 2, 3]));
  });
});

describe('R-Knowledge · reversibility', () => {
  test('every state declares itself reversible', () => {
    const states = [
      computeDegradation(HEALTHY),
      computeDegradation({ ...HEALTHY, embedderAvailable: false }),
      computeDegradation({ ...HEALTHY, storeWritable: false }),
      computeDegradation({ ...HEALTHY, storeAvailable: false }),
    ];
    for (const state of states) expect(state.reversible).toBe(true);
  });

  test('recovery is the same operation as degradation, so no restart is involved', () => {
    const degraded = computeDegradation({ ...HEALTHY, storeAvailable: false });
    expect(degraded.level).toBe(3);
    // The identical function, given restored health, yields level 0. There is no
    // separate recovery path that could be forgotten or fail.
    const recovered = computeDegradation(HEALTHY);
    expect(recovered.level).toBe(0);
    expect(transitionIsReversible(degraded, recovered)).toBe(true);
  });

  test('every pairwise transition among the four levels is reversible', () => {
    const states = [
      computeDegradation(HEALTHY),
      computeDegradation({ ...HEALTHY, embedderAvailable: false }),
      computeDegradation({ ...HEALTHY, storeWritable: false }),
      computeDegradation({ ...HEALTHY, storeAvailable: false }),
    ];
    for (const from of states) {
      for (const to of states) {
        expect(transitionIsReversible(from, to)).toBe(true);
      }
    }
  });

  test('the state is frozen, so a level cannot be mutated in place', () => {
    const state = computeDegradation(HEALTHY);
    expect(Object.isFrozen(state)).toBe(true);
    expect(() => {
      (state as unknown as { level: number }).level = 3;
    }).toThrow();
  });

  test('the initial state is level 0 when no reason is supplied and level 3 when one is', () => {
    expect(initialDegradation().level).toBe(0);
    expect(initialDegradation('KNOWLEDGE_DISABLED').level).toBe(3);
  });
});

describe('R-Knowledge · reason-to-level mapping', () => {
  const cases: [KnowledgeReasonCode, number][] = [
    ['STORE_UNAVAILABLE', 3],
    ['STORE_UNAUTHORISED_EGRESS', 3],
    ['STORE_AUTH_FAILURE', 3],
    ['STORE_TLS_FAILURE', 3],
    ['STORE_VERSION_MISMATCH', 3],
    ['SQLITE_PROHIBITED_IN_PRODUCTION', 3],
    ['NO_AUTHORISED_PRODUCTION_STORE', 3],
    ['STORE_WRITE_REFUSED', 2],
    ['STORE_CIRCUIT_OPEN', 2],
    ['STORE_TIMEOUT', 2],
    ['EMBEDDING_UNAVAILABLE', 1],
    ['EMBEDDING_EGRESS_UNAUTHORISED', 1],
    ['RETRIEVAL_EMPTY', 0],
  ];

  test.each(cases)('%s maps to level %i', (reason, level) => {
    expect(levelForReason(reason)).toBe(level);
  });
});
