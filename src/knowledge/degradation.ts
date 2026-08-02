/**
 * Degradation Ladder
 * MIP-014 STEP 2 · Phase 3 (Store Layer)
 *
 * Four levels, all reversible without restart and without data loss
 * (STEP 1 § 13.1):
 *
 *   0  normal              store and embedder both available
 *   1  embedding-degraded  embedder unavailable; lexical retrieval only, marked
 *   2  store-degraded      store reachable but failing writes; read-only
 *   3  plane-unavailable   explicit unavailable result with a reason code
 *
 * Reversibility is structural rather than promised: the state is a single value
 * recomputed from the current health of the two dependencies, so recovery is the
 * same operation as degradation and no restart, no cache invalidation and no
 * manual step is involved.
 *
 * Level 3 is emphatically NOT an empty success. A retrieval at level 3 returns an
 * explicit unavailable result carrying a reason code, and never unattributed
 * model output (STEP 1 § 13.1).
 */

import type {
  DegradationLevel,
  DegradationState,
  KnowledgeReasonCode,
} from '../planes/r-knowledge/types';

const LEVEL_NAMES: Readonly<Record<DegradationLevel, DegradationState['name']>> = Object.freeze({
  0: 'normal',
  1: 'embedding-degraded',
  2: 'store-degraded',
  3: 'plane-unavailable',
});

export interface DependencyHealth {
  storeAvailable: boolean;
  /** Store reachable but refusing writes — the distinguishing mark of level 2. */
  storeWritable: boolean;
  storeCircuitOpen: boolean;
  embedderAvailable: boolean;
  lastStoreErrorCode: KnowledgeReasonCode | null;
  lastEmbedderErrorCode: KnowledgeReasonCode | null;
}

/**
 * Compute the degradation level from dependency health.
 *
 * The evaluation order encodes precedence, and the precedence is not arbitrary.
 * Store unavailability outranks embedder unavailability, because a plane that
 * cannot read its corpus cannot serve a degraded answer either; reporting level 1
 * in that situation would advertise a lexical fallback that has no corpus to
 * search.
 */
export function computeDegradation(health: DependencyHealth, since: Date = new Date()): DegradationState {
  if (!health.storeAvailable) {
    return frozen(3, health.lastStoreErrorCode ?? 'STORE_UNAVAILABLE', since);
  }
  if (health.storeCircuitOpen) {
    // A half-open or open circuit means writes must not be attempted, but what
    // has already been read remains serviceable — level 2, not level 3.
    return frozen(2, 'STORE_CIRCUIT_OPEN', since);
  }
  if (!health.storeWritable) {
    return frozen(2, health.lastStoreErrorCode ?? 'STORE_WRITE_REFUSED', since);
  }
  if (!health.embedderAvailable) {
    return frozen(1, health.lastEmbedderErrorCode ?? 'EMBEDDING_UNAVAILABLE', since);
  }
  return frozen(0, null, since);
}

function frozen(
  level: DegradationLevel,
  reason: KnowledgeReasonCode | null,
  since: Date
): DegradationState {
  return Object.freeze({
    level,
    name: LEVEL_NAMES[level],
    reason,
    reversible: true as const,
    since,
  });
}

/** The initial state before any health probe has been performed. */
export function initialDegradation(reason: KnowledgeReasonCode | null = null): DegradationState {
  return reason === null ? frozen(0, null, new Date()) : frozen(3, reason, new Date());
}

/**
 * Whether ingestion is permitted at a level. Levels 2 and 3 refuse ingestion with
 * HTTP 503; level 1 permits it, storing objects without vectors and flagging them
 * for re-embedding.
 */
export function ingestionPermitted(state: DegradationState): boolean {
  return state.level === 0 || state.level === 1;
}

/** Whether retrieval is permitted at a level. Only level 3 refuses outright. */
export function retrievalPermitted(state: DegradationState): boolean {
  return state.level < 3;
}

/**
 * Whether results at a level must be marked degraded. At level 1 the scores are
 * lexical and explicitly non-semantic, which a consumer must be able to see.
 */
export function resultsAreDegraded(state: DegradationState): boolean {
  return state.level >= 1;
}

/**
 * The HTTP status a refusal at a level maps to. Ingestion at level 2 or 3 is 503
 * because the condition is transient and recovery is automatic; the caller is
 * being asked to retry, not being told the request was wrong.
 */
export function refusalStatus(state: DegradationState): 503 {
  return 503;
}

/**
 * Whether a transition is reversible. Every transition in this ladder is, so the
 * function is total and always true — stated explicitly so that the property is
 * testable rather than merely documented.
 */
export function transitionIsReversible(_from: DegradationState, _to: DegradationState): boolean {
  return true;
}

/**
 * Map a store or embedder reason code to the level it implies, for use when a
 * single failed operation must be classified without a full health probe.
 */
export function levelForReason(reason: KnowledgeReasonCode): DegradationLevel {
  switch (reason) {
    case 'STORE_UNAVAILABLE':
    case 'STORE_UNCONFIGURED':
    case 'STORE_UNAUTHORISED_EGRESS':
    case 'STORE_NOT_AUTHORISED_FOR_ENVIRONMENT':
    case 'STORE_AUTH_FAILURE':
    case 'STORE_TLS_FAILURE':
    case 'STORE_VERSION_MISMATCH':
    case 'SQLITE_PROHIBITED_IN_PRODUCTION':
    case 'NO_AUTHORISED_PRODUCTION_STORE':
    case 'KNOWLEDGE_DISABLED':
    case 'CONFIG_INVALID':
      return 3;
    case 'STORE_WRITE_REFUSED':
    case 'STORE_CIRCUIT_OPEN':
    case 'STORE_TIMEOUT':
    case 'STORE_PROTOCOL_ERROR':
      return 2;
    case 'EMBEDDING_UNAVAILABLE':
    case 'EMBEDDING_MODEL_ABSENT':
    case 'EMBEDDING_CREDENTIALS_ABSENT':
    case 'EMBEDDING_EGRESS_UNAUTHORISED':
      return 1;
    default:
      return 0;
  }
}
