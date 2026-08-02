/**
 * Embedding Adapter — Contract and Factory
 * MIP-014 STEP 2 · Phase 2 (Deterministic Core)
 *
 * Vendor independence is structural rather than declarative (STEP 1 § 11.1):
 *
 *   - The default provider is `deterministic` and its model is `null`. No vendor
 *     model string appears as a default anywhere in the plane.
 *   - An adapter requiring network egress cannot be constructed unless egress is
 *     explicitly authorised. The gate is evaluated in the factory, before the
 *     adapter exists, so a refusal cannot be accompanied by a client object
 *     having already been instantiated.
 *   - Every failure is a typed refusal. No adapter throws across the plane
 *     boundary.
 *
 * This module performs no network input or output under any configuration
 * reachable within MIP-014.
 */

import type {
  EmbedResult,
  EmbeddingAdapter,
  EmbeddingHealth,
  EmbeddingInitResult,
  EmbeddingProviderId,
  KnowledgeConfig,
  KnowledgeReasonCode,
} from '../../planes/r-knowledge/types';
import { DeterministicEmbeddingAdapter } from './deterministic-adapter';

export interface EmbeddingFactoryResult {
  ok: boolean;
  adapter: EmbeddingAdapter | null;
  reason: KnowledgeReasonCode | null;
  detail?: string;
}

/**
 * An adapter that refuses everything, returned in place of an unauthorised
 * external adapter.
 *
 * A null object is used rather than a thrown error for a governance reason: the
 * caller must be able to observe *that* embedding is unavailable and *why*,
 * without the refusal propagating as an exception that could disturb another
 * plane. The refusing adapter also records no endpoint and holds no credential,
 * so its mere existence discloses nothing.
 */
class RefusingEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: EmbeddingProviderId;
  readonly provider: string;
  readonly model: string | null = null;
  readonly dimensions: number;
  readonly requiresEgress: boolean;
  readonly requiresCredentials: boolean;
  readonly deterministic = false;

  private readonly refusal: KnowledgeReasonCode;
  private readonly refusalDetail: string;

  constructor(
    id: EmbeddingProviderId,
    dimensions: number,
    refusal: KnowledgeReasonCode,
    refusalDetail: string,
    requiresEgress: boolean,
    requiresCredentials: boolean
  ) {
    this.id = id;
    this.provider = id;
    this.dimensions = dimensions;
    this.refusal = refusal;
    this.refusalDetail = refusalDetail;
    this.requiresEgress = requiresEgress;
    this.requiresCredentials = requiresCredentials;
  }

  async init(): Promise<EmbeddingInitResult> {
    return { ok: false, provider: this.id, reason: this.refusal, detail: this.refusalDetail };
  }

  async embed(): Promise<EmbedResult> {
    return {
      ok: false,
      vectors: [],
      provider: this.provider,
      model: null,
      dimensions: this.dimensions,
      reason: this.refusal,
    };
  }

  async health(): Promise<EmbeddingHealth> {
    return {
      provider: this.id,
      available: false,
      latencyMs: 0,
      lastErrorCode: this.refusal,
      checkedAt: new Date(),
    };
  }
}

/**
 * Construct the configured embedding adapter.
 *
 * The factory is total: it always returns a result, and the result always
 * carries an adapter that can be called safely. When authorisation is absent the
 * adapter refuses rather than being null, so that the retrieval path can degrade
 * to level 1 without a null check at every call site — which is how a missing
 * null check becomes an outage.
 */
export function createEmbeddingAdapter(config: KnowledgeConfig): EmbeddingFactoryResult {
  switch (config.embeddingProvider) {
    case 'deterministic':
      return {
        ok: true,
        adapter: new DeterministicEmbeddingAdapter(config.embeddingDimensions),
        reason: null,
      };

    case 'local':
      // A local adapter would run an in-process or on-host model. None is
      // authorised by MIP-014, and none is implemented. The plane says so
      // rather than silently substituting the deterministic adapter, because a
      // silent substitution would make a configured provider a fiction.
      return {
        ok: false,
        adapter: new RefusingEmbeddingAdapter(
          'local',
          config.embeddingDimensions,
          'EMBEDDING_MODEL_ABSENT',
          'No local embedding model is authorised or present under MIP-014. ' +
            'The plane degrades to level 1 rather than substituting another provider.',
          false,
          false
        ),
        reason: 'EMBEDDING_MODEL_ABSENT',
        detail: 'no local embedding model is authorised under MIP-014',
      };

    case 'external': {
      // Hard gate, evaluated before any client object can exist.
      if (!config.externalEgressAuthorised) {
        return {
          ok: false,
          adapter: new RefusingEmbeddingAdapter(
            'external',
            config.embeddingDimensions,
            'EMBEDDING_EGRESS_UNAUTHORISED',
            'External embedding requires KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED=true. ' +
              'No endpoint was resolved, no client was constructed and no request was made.',
            true,
            true
          ),
          reason: 'EMBEDDING_EGRESS_UNAUTHORISED',
          detail: 'external egress is not authorised',
        };
      }
      if (config.embeddingModel === null) {
        return {
          ok: false,
          adapter: new RefusingEmbeddingAdapter(
            'external',
            config.embeddingDimensions,
            'EMBEDDING_MODEL_ABSENT',
            'External embedding requires an explicit model. No vendor model is ever a default.',
            true,
            true
          ),
          reason: 'EMBEDDING_MODEL_ABSENT',
          detail: 'no explicit embedding model configured',
        };
      }
      // Egress authorised and a model named — and still refused, because
      // MIP-014 implements no external adapter. The refusal is the honest
      // outcome: authorisation to egress is not an implementation.
      return {
        ok: false,
        adapter: new RefusingEmbeddingAdapter(
          'external',
          config.embeddingDimensions,
          'EMBEDDING_UNAVAILABLE',
          'No external embedding adapter is implemented under MIP-014. ' +
            'Egress authorisation does not create an implementation.',
          true,
          true
        ),
        reason: 'EMBEDDING_UNAVAILABLE',
        detail: 'no external embedding adapter is implemented under MIP-014',
      };
    }

    default: {
      // Exhaustiveness guard. Reached only if the union gains a member without
      // this switch being extended, which the compiler will otherwise catch.
      const unreachable: never = config.embeddingProvider;
      return {
        ok: false,
        adapter: new RefusingEmbeddingAdapter(
          'deterministic',
          config.embeddingDimensions,
          'CONFIG_INVALID',
          `unrecognised embedding provider: ${String(unreachable)}`,
          false,
          false
        ),
        reason: 'CONFIG_INVALID',
      };
    }
  }
}

/**
 * Verify that a vector set agrees with the adapter that claims to have produced
 * it (K-INV-4). Dimensional disagreement is a refusal, never a coercion: a
 * truncated or zero-padded vector would be a silent corruption of the corpus.
 */
export function verifyEmbeddingDimensions(
  vectors: readonly number[][],
  expectedDimensions: number
): { ok: boolean; reason: KnowledgeReasonCode | null; detail?: string } {
  for (let i = 0; i < vectors.length; i++) {
    if (vectors[i].length !== expectedDimensions) {
      return {
        ok: false,
        reason: 'EMBEDDING_DIMENSION_MISMATCH',
        detail: `vector ${i} has ${vectors[i].length} dimensions; the active adapter declares ${expectedDimensions}`,
      };
    }
  }
  return { ok: true, reason: null };
}
