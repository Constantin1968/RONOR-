/**
 * Live OpenAI Embedding Transport
 * MIP-015 STEP 3 · Learned Embedding Provider
 *
 * The ONLY module in the R-Knowledge plane that constructs a network client for
 * embedding. It is isolated deliberately: every other module in the embedding
 * path can be exercised with no possibility of egress, because the ability to
 * egress lives here and nowhere else.
 *
 * The credential is read at call time, never at construction time and never
 * retained on the instance. A long-lived adapter therefore holds no secret, and a
 * credential rotated in the environment takes effect on the next request rather
 * than requiring a restart.
 */

import { OpenAI } from 'openai';
import type {
  EmbeddingTransport,
  EmbeddingTransportFactory,
  EmbeddingTransportRequest,
  EmbeddingTransportResponse,
} from './openai-adapter';
import type { KnowledgeReasonCode, OpenAIEmbeddingConfig } from '../../planes/r-knowledge/types';

/** Read the credential at call time from either accepted variable. */
function readCredential(env: NodeJS.ProcessEnv = process.env): string | null {
  const specific = env.KNOWLEDGE_OPENAI_API_KEY;
  if (typeof specific === 'string' && specific.length > 0) return specific;
  const shared = env.OPENAI_API_KEY;
  if (typeof shared === 'string' && shared.length > 0) return shared;
  return null;
}

/**
 * Map an HTTP status onto a plane reason code and a retryability decision.
 *
 * Retryability is decided by whether a further identical attempt could plausibly
 * succeed. 401 and 404 cannot: the credential will not become valid and the model
 * will not come into existence by being asked twice. 429 and 5xx can.
 */
function classifyFailure(status: number | undefined): {
  reason: KnowledgeReasonCode;
  retryable: boolean;
} {
  if (status === 401 || status === 403) return { reason: 'EMBEDDING_CREDENTIALS_ABSENT', retryable: false };
  if (status === 404) return { reason: 'EMBEDDING_MODEL_ABSENT', retryable: false };
  if (status === 400 || status === 422) return { reason: 'CONFIG_INVALID', retryable: false };
  if (status === 429) return { reason: 'EMBEDDING_UNAVAILABLE', retryable: true };
  if (typeof status === 'number' && status >= 500) {
    return { reason: 'EMBEDDING_UNAVAILABLE', retryable: true };
  }
  // A transport-level failure with no status: DNS, TLS, timeout, socket reset.
  // Retryable, because these are the failures that are most often transient.
  return { reason: 'EMBEDDING_UNAVAILABLE', retryable: true };
}

/**
 * Strip anything credential-shaped from an error message before it is recorded.
 *
 * Error messages from HTTP clients sometimes echo request headers. A detail
 * string that reaches a log or an API response must not be able to carry a key,
 * so the redaction happens here at the boundary rather than being relied upon
 * further downstream.
 */
export function redactCredentialLike(text: string): string {
  return text
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi, 'Bearer [REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{40,}\b/g, '[REDACTED]');
}

class LiveOpenAIEmbeddingTransport implements EmbeddingTransport {
  private readonly config: OpenAIEmbeddingConfig;

  constructor(config: OpenAIEmbeddingConfig) {
    this.config = config;
  }

  async embed(request: EmbeddingTransportRequest): Promise<EmbeddingTransportResponse> {
    const credential = readCredential();
    if (credential === null) {
      return {
        ok: false,
        vectors: [],
        reason: 'EMBEDDING_CREDENTIALS_ABSENT',
        detail: 'no credential was present at call time',
        retryable: false,
      };
    }

    // The client is constructed per call. This is a deliberate trade of a small
    // amount of per-request overhead for the guarantee that no object in the
    // process holds a credential between requests.
    const client = new OpenAI({
      apiKey: credential,
      baseURL: this.config.baseUrl,
      timeout: this.config.timeoutMs,
      // Retries are handled by the adapter, which knows the plane's retry policy.
      // Leaving the client's own retry enabled would multiply the two.
      maxRetries: 0,
    });

    try {
      const response = await client.embeddings.create({
        model: request.model,
        input: [...request.input],
      });

      // Order matters: the caller maps vectors onto chunks positionally. The API
      // returns an `index` on each datum, so the response is sorted by it rather
      // than trusted to arrive in order.
      const sorted = [...response.data].sort((a, b) => a.index - b.index);
      const vectors = sorted.map((d) => d.embedding as number[]);

      return { ok: true, vectors, reason: null, retryable: false };
    } catch (err: unknown) {
      const status =
        typeof err === 'object' && err !== null && 'status' in err
          ? (err as { status?: number }).status
          : undefined;
      const { reason, retryable } = classifyFailure(status);
      const message = err instanceof Error ? err.message : String(err);

      return {
        ok: false,
        vectors: [],
        reason,
        detail: redactCredentialLike(message).slice(0, 300),
        retryable,
      };
    }
  }
}

/**
 * The live transport factory.
 *
 * Must be passed explicitly to the adapter. Nothing in the plane wires it in by
 * default, which is what keeps "no egress unless deliberately configured" a
 * structural property of the code rather than an operational convention.
 */
export const liveEmbeddingTransportFactory: EmbeddingTransportFactory = (
  config: OpenAIEmbeddingConfig
) => {
  if (config.model === null || config.model.length === 0) return null;
  if (!config.apiKeyPresent) return null;
  return new LiveOpenAIEmbeddingTransport(config);
};
