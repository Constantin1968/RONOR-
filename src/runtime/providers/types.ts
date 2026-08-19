/**
 * RONOR Runtime — L1 Model Exchange · Provider Contract
 * ─────────────────────────────────────────────────────
 * One contract, five vendors. Every provider adapter in the exchange implements
 * `ProviderAdapter` and nothing else is permitted to reach a vendor endpoint.
 * The contract is deliberately narrow: a caller supplies a `ProviderInvocation`
 * and receives a `ProviderResponse`. There is no vendor-shaped escape hatch,
 * because a router that must special-case a vendor is a router that cannot
 * honestly claim to be provider-neutral.
 *
 * Three properties are load-bearing and each is asserted by the test suite:
 *
 *   1. NO ADAPTER THROWS. Every failure path returns a `ProviderResponse` with
 *      `ok: false` and a typed `failure`. The fallback chain in the router
 *      depends on being able to inspect a refusal rather than catch it, because
 *      an exception carries no provenance and cannot be written to a ledger.
 *
 *   2. EVERY RESPONSE CARRIES MEASURED FACTS. `latency_ms` is wall-clock,
 *      `usage` is the vendor's own token accounting where it is reported and a
 *      declared estimate where it is not. The 6D router calibrates on these
 *      numbers, so a fabricated latency would silently corrupt routing.
 *
 *   3. CREDENTIAL STATE IS OBSERVABLE BEFORE INVOCATION. `credentialState()`
 *      answers "could this adapter run right now?" without spending a token.
 *      A provider whose key is absent is reported as `key-absent`, never
 *      simulated and never quietly skipped.
 *
 * Prepared by AMB.
 */

/** The five vendor families the exchange speaks natively. */
export type ProviderId =
  | 'openai'
  | 'anthropic'
  | 'google'
  | 'deepseek'
  | 'perplexity'
  | 'kimi'
  | 'deterministic';

/**
 * How the adapter reaches the vendor.
 *
 * `native`  — the vendor's own API with the vendor's own key.
 * `gateway` — an OpenAI-compatible proxy that fronts several vendors.
 *
 * The distinction is recorded on every response and written to the audit chain,
 * because "which wire did this token travel on" is a sovereignty question, not
 * an implementation detail.
 */
export type TransportMode = 'native' | 'gateway' | 'local';

export type CredentialState =
  /** A key is present and the adapter will attempt a live call. */
  | 'live-native'
  /** No vendor key, but an OpenAI-compatible gateway is configured and serves this model. */
  | 'live-gateway'
  /** Requires no credential at all (deterministic core). */
  | 'live-local'
  /** No credential and no gateway route. The adapter refuses rather than simulates. */
  | 'key-absent';

export type ProviderFailureKind =
  | 'credential-absent'
  | 'auth-rejected'
  | 'rate-limited'
  | 'model-unsupported'
  | 'timeout'
  | 'network'
  | 'bad-response'
  | 'content-refused'
  | 'server-error'
  | 'not-computable';

export interface ProviderFailure {
  kind: ProviderFailureKind;
  message: string;
  /** HTTP status when the failure came from a response rather than the wire. */
  httpStatus?: number;
  /** True when trying a different provider is a reasonable next action. */
  retryable: boolean;
}

export interface ProviderUsage {
  input_tokens: number;
  output_tokens: number;
  /**
   * True when the vendor did not report usage and the numbers above are a
   * declared estimate. The Cost-of-Intelligence ledger records this flag so an
   * operator can tell measured spend from inferred spend.
   */
  estimated: boolean;
}

/** A citation surfaced by a search-augmented provider. */
export interface ProviderCitation {
  title: string;
  url?: string;
  snippet?: string;
}

export interface ProviderInvocation {
  /** Vendor-facing model identifier, e.g. `claude-sonnet-4-6`. */
  model: string;
  /** System instruction. Adapters map this to the vendor's own mechanism. */
  system?: string;
  /** The user turn. Multi-turn history is supplied via `messages` when needed. */
  prompt: string;
  /** Optional explicit history; when present it supersedes `prompt`. */
  messages?: ProviderMessage[];
  temperature?: number;
  /**
   * Ceiling on VISIBLE output tokens. Each adapter translates this into the
   * parameter its vendor family actually honours — a mistranslation here is the
   * single most common cause of empty completions, so it is centralised.
   */
  maxOutputTokens?: number;
  /** Request a JSON object back, with an optional strict schema. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** Thinking / reasoning budget, expressed neutrally and mapped per family. */
  reasoningEffort?: 'none' | 'low' | 'medium' | 'high';
  timeoutMs?: number;
}

export interface ProviderMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ProviderResponse {
  ok: boolean;
  provider: ProviderId;
  /** The model actually invoked, which may differ from the one requested. */
  model: string;
  transport: TransportMode;
  content: string;
  usage: ProviderUsage;
  latency_ms: number;
  /** Non-empty only for search-augmented providers. */
  citations: ProviderCitation[];
  /** Vendor stop reason, normalised where possible. */
  finishReason: string | null;
  failure: ProviderFailure | null;
  /**
   * Always false in Runtime Active. The field is retained so that any future
   * simulation path must announce itself in the same field every ledger and
   * audit record already reads.
   */
  simulated: boolean;
}

export interface ProviderDescriptor {
  id: ProviderId;
  displayName: string;
  /** Models this adapter can serve, in the vendor's own identifier space. */
  models: string[];
  /** True when the provider augments generation with live web search. */
  searchAugmented: boolean;
  /** Legal jurisdictions the vendor operates the inference in. */
  jurisdictions: string[];
}

export interface ProviderAdapter {
  readonly descriptor: ProviderDescriptor;
  /**
   * Answer whether this adapter can run right now, and over which wire.
   * MUST NOT perform network I/O: it is called on the health path and on every
   * routing decision, and a probe there would make routing latency depend on
   * vendor availability.
   */
  credentialState(env?: NodeJS.ProcessEnv): CredentialState;
  /** Execute. Never throws; failures arrive as `ok: false` with a typed reason. */
  invoke(invocation: ProviderInvocation, env?: NodeJS.ProcessEnv): Promise<ProviderResponse>;
}

// ---------------------------------------------------------------------------
// Shared helpers used by every adapter. Kept here so that failure shapes are
// literally identical across vendors rather than merely similar.
// ---------------------------------------------------------------------------

export function providerFailure(
  provider: ProviderId,
  model: string,
  transport: TransportMode,
  failure: ProviderFailure,
  latency_ms = 0,
): ProviderResponse {
  return {
    ok: false,
    provider,
    model,
    transport,
    content: '',
    usage: { input_tokens: 0, output_tokens: 0, estimated: true },
    latency_ms,
    citations: [],
    finishReason: null,
    failure,
    simulated: false,
  };
}

/** Classify an HTTP status into a failure kind with a sane retry verdict. */
export function classifyHttpStatus(status: number, body: string): ProviderFailure {
  if (status === 401 || status === 403) {
    return {
      kind: 'auth-rejected',
      message: `authentication rejected (${status}): ${truncate(body)}`,
      httpStatus: status,
      retryable: false,
    };
  }
  if (status === 404 || status === 400) {
    // A 400 from these APIs is most often an unsupported model or malformed
    // parameter for the family. Both are permanent for this provider and are
    // worth failing over rather than retrying.
    return {
      kind: 'model-unsupported',
      message: `request rejected (${status}): ${truncate(body)}`,
      httpStatus: status,
      retryable: true,
    };
  }
  if (status === 429) {
    return {
      kind: 'rate-limited',
      message: `rate limited (429): ${truncate(body)}`,
      httpStatus: status,
      retryable: true,
    };
  }
  return {
    kind: 'server-error',
    message: `upstream error (${status}): ${truncate(body)}`,
    httpStatus: status,
    retryable: true,
  };
}

export function truncate(s: string, n = 240): string {
  const flat = s.replace(/\s+/g, ' ').trim();
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`;
}

/**
 * Token estimate used only when a vendor omits usage. Four characters per token
 * is the conventional English approximation; it is flagged `estimated: true` at
 * the call site so no ledger presents it as measurement.
 */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

/** `fetch` with a hard deadline that resolves rather than rejects on timeout. */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ res: Response } | { timedOut: true } | { error: Error }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return { res };
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') return { timedOut: true };
    return { error: err instanceof Error ? err : new Error(String(err)) };
  } finally {
    clearTimeout(timer);
  }
}

export const DEFAULT_TIMEOUT_MS = 120_000;
