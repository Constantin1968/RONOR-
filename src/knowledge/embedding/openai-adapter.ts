/**
 * OpenAI Embedding Adapter — the learned embedder
 * MIP-015 STEP 3 · Learned Embedding Provider
 *
 * The plane's first LEARNED embedding provider. It produces vectors that carry
 * semantic structure, which the deterministic hashed-feature adapter cannot, and
 * it does so at the cost of three properties the deterministic adapter has for
 * free: it requires network egress, it requires a credential, and it is not
 * reproducible offline.
 *
 * Those costs are the reason for every design decision below.
 *
 * ── Substitutable transport ──────────────────────────────────────────────────
 * The adapter never constructs an HTTP client directly. It calls an injected
 * `EmbeddingTransport`, and the DEFAULT transport is the ABSENCE of one. A
 * transport must be supplied explicitly, either by the live factory (which
 * constructs the real OpenAI client) or by a test (which supplies a double).
 * This is the same discipline the Qdrant adapter uses, and it exists so that the
 * adapter's refusal paths can be proved without a network, and so that no test
 * can accidentally egress.
 *
 * ── Fallback is a decision, not an accident ──────────────────────────────────
 * When the learned provider is unreachable the plane may fall back to the
 * deterministic adapter. That fallback is CONFIGURED (`KNOWLEDGE_OPENAI_FALLBACK`),
 * defaults to enabled, and is always REPORTED: a vector produced by the fallback
 * carries `provider: 'deterministic'`, never `provider: 'openai'`. Mislabelling a
 * fallback vector as a learned one would corrupt the corpus in the worst possible
 * way — silently and unrecoverably — because a later re-embedding pass would have
 * no way to identify which objects need redoing.
 *
 * ── The credential ──────────────────────────────────────────────────────────
 * Read at call time from the environment, never stored on the instance, never
 * logged, never included in a refusal detail, never returned by `health()`.
 */

import type {
  EmbedResult,
  EmbeddingAdapter,
  EmbeddingHealth,
  EmbeddingInitResult,
  EmbeddingProviderId,
  KnowledgeReasonCode,
  OpenAIEmbeddingConfig,
} from '../../planes/r-knowledge/types';
import { DeterministicEmbeddingAdapter } from './deterministic-adapter';

// ============================================================
// Transport seam
// ============================================================

export interface EmbeddingTransportRequest {
  readonly model: string;
  readonly input: readonly string[];
}

export interface EmbeddingTransportResponse {
  readonly ok: boolean;
  /** One vector per input, in input order. Empty when `ok` is false. */
  readonly vectors: number[][];
  readonly reason: KnowledgeReasonCode | null;
  readonly detail?: string;
  /** Whether a further attempt could plausibly succeed. */
  readonly retryable: boolean;
}

/**
 * The transport contract. One method, because the adapter needs exactly one
 * operation and a wider contract would invite the adapter to depend on vendor
 * protocol details it has no business knowing.
 */
export interface EmbeddingTransport {
  embed(request: EmbeddingTransportRequest): Promise<EmbeddingTransportResponse>;
}

export type EmbeddingTransportFactory = (
  config: OpenAIEmbeddingConfig
) => EmbeddingTransport | null;

/**
 * The default transport factory: returns null.
 *
 * An adapter constructed without an explicit transport can therefore make no
 * request at all, which is what makes "no egress unless authorised" a structural
 * property rather than a promise. The live factory is in `openai-transport.ts`
 * and must be passed in deliberately.
 */
export const UNAVAILABLE_EMBEDDING_TRANSPORT: EmbeddingTransportFactory = () => null;

// ============================================================
// Conditions precedent
// ============================================================

/**
 * Conditions that must hold before a request may be issued. Evaluated together
 * so that a misconfigured deployment learns everything wrong with it at once
 * rather than one round-trip at a time.
 */
export type OpenAIConditionId =
  | 'EGRESS_AUTHORISED'
  | 'CREDENTIAL_PRESENT'
  | 'MODEL_NAMED'
  | 'ENDPOINT_ABSOLUTE'
  | 'DIMENSIONS_DECLARED'
  | 'TRANSPORT_AVAILABLE';

export interface OpenAIConditionVerdict {
  readonly id: OpenAIConditionId;
  readonly satisfied: boolean;
  readonly reason: KnowledgeReasonCode | null;
  readonly detail: string;
}

/** Absolute URL with an explicit scheme. http is permitted only for localhost. */
export function isAcceptableEmbeddingEndpoint(raw: string): boolean {
  if (raw.length === 0) return false;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  // Plaintext is tolerated ONLY for a loopback endpoint, which is the local
  // development and CI case. Any other plaintext endpoint would put a credential
  // and the corpus text on the wire in clear, so it is refused.
  if (url.protocol === 'http:') {
    return url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '::1';
  }
  return false;
}

/**
 * Evaluate every statically decidable condition.
 *
 * Reachability and model existence are NOT decided here, because neither can be
 * known without asking the service. A function that returned a verdict on a
 * question it cannot answer would be a fiction a caller could rely on.
 */
export function evaluateOpenAIConditions(
  config: OpenAIEmbeddingConfig,
  egressAuthorised: boolean,
  transportAvailable: boolean
): OpenAIConditionVerdict[] {
  return [
    {
      id: 'EGRESS_AUTHORISED',
      satisfied: egressAuthorised,
      reason: egressAuthorised ? null : 'EMBEDDING_EGRESS_UNAUTHORISED',
      detail: egressAuthorised
        ? 'external egress is authorised for this deployment'
        : 'the learned provider requires KNOWLEDGE_EXTERNAL_EGRESS_AUTHORISED=true; no client was constructed and no request was made',
    },
    {
      id: 'CREDENTIAL_PRESENT',
      satisfied: config.apiKeyPresent,
      reason: config.apiKeyPresent ? null : 'EMBEDDING_CREDENTIALS_ABSENT',
      detail: config.apiKeyPresent
        ? 'a credential is present in the environment'
        : 'no credential is present in KNOWLEDGE_OPENAI_API_KEY or OPENAI_API_KEY',
    },
    {
      id: 'MODEL_NAMED',
      satisfied: config.model !== null && config.model.length > 0,
      reason: config.model !== null && config.model.length > 0 ? null : 'EMBEDDING_MODEL_ABSENT',
      detail:
        config.model !== null && config.model.length > 0
          ? `model named explicitly: ${config.model}`
          : 'no model was named; the plane supplies no vendor model as a default',
    },
    {
      id: 'ENDPOINT_ABSOLUTE',
      satisfied: isAcceptableEmbeddingEndpoint(config.baseUrl),
      reason: isAcceptableEmbeddingEndpoint(config.baseUrl) ? null : 'CONFIG_INVALID',
      detail: isAcceptableEmbeddingEndpoint(config.baseUrl)
        ? 'endpoint is an absolute URL with an acceptable scheme'
        : 'endpoint must be an absolute https:// URL (http:// is permitted for loopback only)',
    },
    {
      id: 'DIMENSIONS_DECLARED',
      satisfied: Number.isInteger(config.dimensions) && config.dimensions > 0,
      reason: Number.isInteger(config.dimensions) && config.dimensions > 0 ? null : 'CONFIG_INVALID',
      detail:
        Number.isInteger(config.dimensions) && config.dimensions > 0
          ? `expecting ${config.dimensions}-dimensional vectors`
          : `dimensions must be a positive integer; received ${String(config.dimensions)}`,
    },
    {
      id: 'TRANSPORT_AVAILABLE',
      satisfied: transportAvailable,
      reason: transportAvailable ? null : 'EMBEDDING_UNAVAILABLE',
      detail: transportAvailable
        ? 'a transport was supplied'
        : 'no transport was supplied; the default transport factory is the absence of a transport',
    },
  ];
}

// ============================================================
// The adapter
// ============================================================

export interface OpenAIEmbeddingAdapterOptions {
  readonly config: OpenAIEmbeddingConfig;
  readonly egressAuthorised: boolean;
  /** Defaults to the absence of a transport, so no request is possible. */
  readonly transportFactory?: EmbeddingTransportFactory;
  /** Supplied for the fallback path. Constructed lazily and only if needed. */
  readonly fallbackDimensions?: number;
}

export class OpenAIEmbeddingAdapter implements EmbeddingAdapter {
  readonly id: EmbeddingProviderId = 'openai';
  readonly provider = 'openai';
  readonly model: string | null;
  readonly dimensions: number;
  readonly requiresEgress = true;
  readonly requiresCredentials = true;
  /** A learned model is not reproducible offline. Stated, not glossed over. */
  readonly deterministic = false;

  private readonly config: OpenAIEmbeddingConfig;
  private readonly egressAuthorised: boolean;
  private readonly transportFactory: EmbeddingTransportFactory;
  private transport: EmbeddingTransport | null = null;
  private transportConstructions = 0;

  /** Constructed only when a fallback is actually required. */
  private fallback: DeterministicEmbeddingAdapter | null = null;
  private readonly fallbackDimensions: number;

  private lastErrorCode: KnowledgeReasonCode | null = null;
  private requestCount = 0;
  private fallbackCount = 0;

  constructor(options: OpenAIEmbeddingAdapterOptions) {
    this.config = options.config;
    this.egressAuthorised = options.egressAuthorised;
    this.transportFactory = options.transportFactory ?? UNAVAILABLE_EMBEDDING_TRANSPORT;
    this.model = options.config.model;
    this.dimensions = options.config.dimensions;
    this.fallbackDimensions = options.fallbackDimensions ?? options.config.dimensions;
  }

  /** Diagnostic accessor: how many transports this adapter has constructed. */
  getTransportConstructionCount(): number {
    return this.transportConstructions;
  }

  /** Diagnostic accessor: how many embed calls fell back to the deterministic adapter. */
  getFallbackCount(): number {
    return this.fallbackCount;
  }

  getRequestCount(): number {
    return this.requestCount;
  }

  /**
   * Evaluate conditions and construct the transport.
   *
   * The transport is constructed only after every condition has passed, so a
   * refusal is never accompanied by a client object that already exists and could
   * already have opened a socket.
   */
  async init(): Promise<EmbeddingInitResult> {
    const verdicts = evaluateOpenAIConditions(this.config, this.egressAuthorised, true);
    const unsatisfied = verdicts.filter((v) => !v.satisfied && v.id !== 'TRANSPORT_AVAILABLE');

    if (unsatisfied.length > 0) {
      this.lastErrorCode = unsatisfied[0].reason;
      return {
        ok: false,
        provider: this.id,
        reason: unsatisfied[0].reason,
        // Every unsatisfied condition is reported, not merely the first, so that
        // an operator fixes one thing and does not discover a second on the next
        // attempt.
        detail: unsatisfied.map((v) => `${v.id}: ${v.detail}`).join('; '),
      };
    }

    const transport = this.transportFactory(this.config);
    if (transport === null) {
      this.lastErrorCode = 'EMBEDDING_UNAVAILABLE';
      return {
        ok: false,
        provider: this.id,
        reason: 'EMBEDDING_UNAVAILABLE',
        detail:
          'no transport was supplied. The default transport factory is the absence of a ' +
          'transport, so an adapter constructed without one can issue no request.',
      };
    }

    this.transport = transport;
    this.transportConstructions += 1;
    this.lastErrorCode = null;
    return { ok: true, provider: this.id, reason: null };
  }

  /**
   * Embed a batch of texts.
   *
   * Batching respects `config.batchSize` and preserves input order across batch
   * boundaries, because a caller maps vectors back onto chunks positionally: a
   * reordering here would silently attach every vector to the wrong chunk, which
   * is a corruption that no later verification would catch.
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    if (texts.length === 0) {
      return {
        ok: true,
        vectors: [],
        provider: this.provider,
        model: this.model,
        dimensions: this.dimensions,
        reason: null,
      };
    }

    if (this.transport === null || this.model === null) {
      return this.attemptFallback(
        texts,
        this.transport === null ? 'EMBEDDING_UNAVAILABLE' : 'EMBEDDING_MODEL_ABSENT'
      );
    }

    const vectors: number[][] = [];

    for (let offset = 0; offset < texts.length; offset += this.config.batchSize) {
      const batch = texts.slice(offset, offset + this.config.batchSize);
      const response = await this.requestWithRetry({ model: this.model, input: batch });

      if (!response.ok) {
        this.lastErrorCode = response.reason;
        return this.attemptFallback(texts, response.reason ?? 'EMBEDDING_UNAVAILABLE');
      }

      // Arity check. A response with the wrong number of vectors cannot be
      // repaired by guessing which input each one belongs to.
      if (response.vectors.length !== batch.length) {
        this.lastErrorCode = 'EMBEDDING_PROVIDER_MISMATCH';
        return this.attemptFallback(texts, 'EMBEDDING_PROVIDER_MISMATCH');
      }

      // Width check, per vector. Refused rather than padded or truncated: a
      // coerced vector is a silent corpus corruption.
      for (const vector of response.vectors) {
        if (vector.length !== this.dimensions) {
          this.lastErrorCode = 'EMBEDDING_DIMENSION_MISMATCH';
          return {
            ok: false,
            vectors: [],
            provider: this.provider,
            model: this.model,
            dimensions: this.dimensions,
            reason: 'EMBEDDING_DIMENSION_MISMATCH',
          };
        }
      }

      vectors.push(...response.vectors);
    }

    this.requestCount += 1;
    this.lastErrorCode = null;
    return {
      ok: true,
      vectors,
      provider: this.provider,
      model: this.model,
      dimensions: this.dimensions,
      reason: null,
    };
  }

  /**
   * Issue one request, retrying only what is retryable.
   *
   * A non-retryable failure — an authentication rejection, an unknown model — is
   * returned immediately. Retrying it would waste the caller's time and, in the
   * authentication case, risk a lockout.
   */
  private async requestWithRetry(
    request: EmbeddingTransportRequest
  ): Promise<EmbeddingTransportResponse> {
    let attempt = 0;
    let last: EmbeddingTransportResponse = {
      ok: false,
      vectors: [],
      reason: 'EMBEDDING_UNAVAILABLE',
      detail: 'no attempt was made',
      retryable: false,
    };

    while (attempt <= this.config.maxRetries) {
      if (this.transport === null) return last;
      try {
        last = await this.transport.embed(request);
      } catch (err) {
        // A transport that throws is a defect in the transport, not a reason to
        // propagate an exception across the plane boundary.
        last = {
          ok: false,
          vectors: [],
          reason: 'EMBEDDING_UNAVAILABLE',
          detail: `transport threw: ${err instanceof Error ? err.message : String(err)}`,
          retryable: false,
        };
      }
      if (last.ok || !last.retryable) return last;
      attempt += 1;
    }

    return last;
  }

  /**
   * Fall back to the deterministic adapter, if and only if configured to.
   *
   * The returned result is labelled `provider: 'deterministic'`. This is the
   * single most important line in the fallback path: a fallback vector recorded
   * as a learned vector would be indistinguishable from a real one, and a later
   * re-embedding pass would have no way to find the objects that need redoing.
   */
  private async attemptFallback(
    texts: string[],
    reason: KnowledgeReasonCode
  ): Promise<EmbedResult> {
    if (!this.config.fallbackToDeterministic) {
      return {
        ok: false,
        vectors: [],
        provider: this.provider,
        model: this.model,
        dimensions: this.dimensions,
        reason,
      };
    }

    if (this.fallback === null) {
      this.fallback = new DeterministicEmbeddingAdapter(this.fallbackDimensions);
    }
    const result = await this.fallback.embed(texts);
    this.fallbackCount += 1;

    return {
      ok: result.ok,
      vectors: result.vectors,
      // Truthful attribution. NOT 'openai'.
      provider: 'deterministic',
      model: null,
      dimensions: this.fallbackDimensions,
      // The originating reason is preserved so that the caller can see WHY the
      // fallback happened, not merely that it did.
      reason,
    };
  }

  /**
   * Liveness probe.
   *
   * Embeds a single fixed token. Deliberately not a bare reachability check: an
   * endpoint that accepts a TCP connection but rejects the credential is not
   * available for this adapter's purpose, and reporting it as available would be
   * misleading.
   */
  async health(): Promise<EmbeddingHealth> {
    const startedAt = Date.now();

    if (this.transport === null || this.model === null) {
      return {
        provider: this.id,
        available: false,
        latencyMs: 0,
        lastErrorCode: this.lastErrorCode ?? 'EMBEDDING_UNAVAILABLE',
        checkedAt: new Date(),
      };
    }

    let response: EmbeddingTransportResponse;
    try {
      response = await this.transport.embed({ model: this.model, input: ['health'] });
    } catch (err) {
      return {
        provider: this.id,
        available: false,
        latencyMs: Date.now() - startedAt,
        lastErrorCode: 'EMBEDDING_UNAVAILABLE',
        checkedAt: new Date(),
      };
    }

    return {
      provider: this.id,
      available: response.ok,
      latencyMs: Date.now() - startedAt,
      lastErrorCode: response.ok ? null : response.reason,
      checkedAt: new Date(),
    };
  }
}
