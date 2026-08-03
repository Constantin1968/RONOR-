/**
 * RONOR Runtime — L1 · Model Exchange Executor
 * ────────────────────────────────────────────
 * Policy → 6D rank → execute → fall back → account. One function, one
 * transaction, one auditable record of what was attempted and why.
 *
 * The fallback chain is the part that earns its keep in production. Rules:
 *
 *   · ATTEMPTS ARE BOUNDED. `maxAttempts` (default 3) caps the walk down the
 *     ranked table. An unbounded chain turns one provider outage into a bill for
 *     every engine in the catalogue on every request.
 *   · NON-RETRYABLE FAILURES STOP THE PROVIDER, NOT THE CHAIN. A rejected
 *     credential is permanent for that provider, so the chain moves on
 *     immediately rather than retrying; a rate limit is transient, so the next
 *     provider is tried and the rate-limited one is not blamed permanently.
 *   · CONTENT REFUSALS ARE NOT ROUTING FAILURES. When an engine declines on
 *     safety grounds, trying a cheaper engine to obtain the same refusal is
 *     waste. The chain records the refusal and stops.
 *   · EVERY ATTEMPT IS TELEMETRY. Success and failure both feed the calibrator,
 *     which is how a degraded provider loses its ranking without an operator
 *     editing a file.
 *   · THE COST OF FAILED ATTEMPTS IS COUNTED. A failed call may still have
 *     billed tokens. Reporting only the successful attempt's cost would
 *     understate spend precisely when the runtime is struggling, so
 *     `total_cost_usd` includes every attempt.
 *
 * Prepared by AMB.
 */

import { getAdapter } from '../providers/registry';
import type { ProviderInvocation, ProviderResponse } from '../providers/types';
import { recordSample } from './calibrator';
import { getCatalogueEntry, listCatalogue, type CatalogueEntry } from './catalogue';
import {
  applyRuntimePolicies,
  type PolicyEvaluation,
  type RuntimePolicyResult,
  type RuntimeRequestConstraints,
} from './policy';
import { rankCandidates, type ScoredCandidate } from './scoring';

export interface ExchangeAttempt {
  attempt: number;
  model_id: string;
  provider: string;
  vendor_model: string;
  transport: string;
  ok: boolean;
  latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  /** Why the chain moved on, when it did. */
  failure_kind: string | null;
  failure_message: string | null;
  /** Populated when this attempt was chosen because the previous one failed. */
  fallback_reason: string | null;
}

export interface ExchangeResult {
  ok: boolean;
  status:
    | 'completed'
    | 'completed-after-fallback'
    | 'rejected-policy'
    | 'all-providers-failed'
    | 'content-refused';
  chosen_model_id: string | null;
  chosen_provider: string | null;
  transport: string | null;
  content: string;
  citations: ProviderResponse['citations'];
  /** Sum across every attempt, successful or not. */
  total_cost_usd: number;
  /** Wall-clock across the whole chain, including failed attempts. */
  total_latency_ms: number;
  input_tokens: number;
  output_tokens: number;
  usage_estimated: boolean;
  routing_table: ScoredCandidate[];
  policy_evaluations: PolicyEvaluation[];
  eligible_models: string[];
  attempts: ExchangeAttempt[];
  fallback_used: boolean;
  rejection_reason: string | null;
}

export interface ExchangeOptions {
  constraints: RuntimeRequestConstraints;
  /** System instruction forwarded to the provider. */
  system?: string;
  prompt: string;
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  reasoningEffort?: ProviderInvocation['reasoningEffort'];
  maxOutputTokens?: number;
  temperature?: number;
  timeoutMs?: number;
  /** Cap on providers tried. Default 3. */
  maxAttempts?: number;
  /** Score only; execute nothing. */
  dryRun?: boolean;
  catalogue?: CatalogueEntry[];
  env?: NodeJS.ProcessEnv;
}

export function computeActualCost(
  entry: CatalogueEntry,
  inputTokens: number,
  outputTokens: number,
): number {
  const cost =
    (inputTokens / 1_000_000) * entry.input_cost_per_1m +
    (outputTokens / 1_000_000) * entry.output_cost_per_1m;
  return +cost.toFixed(8);
}

export function routeOnly(options: ExchangeOptions): {
  policy: RuntimePolicyResult;
  routing: ScoredCandidate[];
} {
  const catalogue = options.catalogue ?? listCatalogue();
  const policy = applyRuntimePolicies(
    options.constraints,
    options.prompt.length,
    catalogue,
    options.env ?? process.env,
  );
  const routing = policy.rejected
    ? []
    : rankCandidates(policy.eligible, options.prompt.length, policy.deterministicFirst);
  return { policy, routing };
}

export async function executeExchange(options: ExchangeOptions): Promise<ExchangeResult> {
  const started = Date.now();
  const { policy, routing } = routeOnly(options);

  const base: Omit<ExchangeResult, 'ok' | 'status'> = {
    chosen_model_id: null,
    chosen_provider: null,
    transport: null,
    content: '',
    citations: [],
    total_cost_usd: 0,
    total_latency_ms: 0,
    input_tokens: 0,
    output_tokens: 0,
    usage_estimated: false,
    routing_table: routing,
    policy_evaluations: policy.evaluations,
    eligible_models: policy.eligible.map((e) => e.id),
    attempts: [],
    fallback_used: false,
    rejection_reason: null,
  };

  if (policy.rejected || routing.length === 0) {
    return {
      ...base,
      ok: false,
      status: 'rejected-policy',
      total_latency_ms: Date.now() - started,
      rejection_reason: policy.rejectionReason ?? 'no eligible engine',
    };
  }

  if (options.dryRun) {
    return {
      ...base,
      ok: true,
      status: 'completed',
      chosen_model_id: routing[0].model_id,
      chosen_provider: routing[0].provider,
      total_latency_ms: Date.now() - started,
    };
  }

  const maxAttempts = Math.max(1, options.maxAttempts ?? 3);
  const attempts: ExchangeAttempt[] = [];
  let totalCost = 0;
  let lastFailureMessage: string | null = null;
  let previousFailure: string | null = null;

  for (let i = 0; i < routing.length && attempts.length < maxAttempts; i++) {
    const candidate = routing[i];
    const entry = getCatalogueEntry(candidate.model_id);
    if (!entry) continue;
    const adapter = getAdapter(entry.provider);
    if (!adapter) continue;

    const invocation: ProviderInvocation = {
      model: entry.vendorModel,
      system: options.system,
      prompt: options.prompt,
      jsonSchema: options.jsonSchema,
      reasoningEffort: options.reasoningEffort,
      // Never ask a model for more visible tokens than it can emit; the vendor
      // rejects the request outright rather than clamping.
      maxOutputTokens: Math.min(options.maxOutputTokens ?? 8192, entry.max_output_tokens),
      temperature: options.temperature,
      timeoutMs: options.timeoutMs,
    };

    const response = await adapter.invoke(invocation, options.env ?? process.env);

    // Telemetry is recorded for both outcomes. A failure that did not update the
    // calibrator would leave a broken provider ranked as though it were healthy.
    recordSample(entry.id, response.latency_ms, response.ok);

    const attemptCost = computeActualCost(
      entry,
      response.usage.input_tokens,
      response.usage.output_tokens,
    );
    totalCost += attemptCost;

    attempts.push({
      attempt: attempts.length + 1,
      model_id: entry.id,
      provider: entry.provider,
      vendor_model: entry.vendorModel,
      transport: response.transport,
      ok: response.ok,
      latency_ms: response.latency_ms,
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cost_usd: attemptCost,
      failure_kind: response.failure?.kind ?? null,
      failure_message: response.failure?.message ?? null,
      fallback_reason: previousFailure,
    });

    if (response.ok) {
      const usedFallback = attempts.length > 1;
      return {
        ...base,
        ok: true,
        status: usedFallback ? 'completed-after-fallback' : 'completed',
        chosen_model_id: entry.id,
        chosen_provider: entry.provider,
        transport: response.transport,
        content: response.content,
        citations: response.citations,
        total_cost_usd: +totalCost.toFixed(8),
        total_latency_ms: Date.now() - started,
        input_tokens: response.usage.input_tokens,
        output_tokens: response.usage.output_tokens,
        usage_estimated: response.usage.estimated,
        attempts,
        fallback_used: usedFallback,
      };
    }

    lastFailureMessage = response.failure?.message ?? 'unknown failure';
    previousFailure = `${entry.id} failed: ${response.failure?.kind ?? 'unknown'} — ${lastFailureMessage}`;

    // A safety refusal is a decision about the CONTENT, not about the provider.
    // Shopping the same prompt around the catalogue to find a laxer filter is
    // both wasteful and, in a governed runtime, the wrong instinct entirely.
    if (response.failure?.kind === 'content-refused') {
      return {
        ...base,
        ok: false,
        status: 'content-refused',
        chosen_model_id: entry.id,
        chosen_provider: entry.provider,
        transport: response.transport,
        total_cost_usd: +totalCost.toFixed(8),
        total_latency_ms: Date.now() - started,
        attempts,
        fallback_used: attempts.length > 1,
        rejection_reason: `content refused by ${entry.displayName}: ${lastFailureMessage}`,
      };
    }
  }

  return {
    ...base,
    ok: false,
    status: 'all-providers-failed',
    total_cost_usd: +totalCost.toFixed(8),
    total_latency_ms: Date.now() - started,
    attempts,
    fallback_used: attempts.length > 1,
    rejection_reason: `every attempted engine failed (${attempts.length} attempt${
      attempts.length === 1 ? '' : 's'
    }). Last error: ${lastFailureMessage ?? 'unknown'}`,
  };
}
