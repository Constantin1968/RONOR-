/**
 * RONOR Runtime — L1 · OpenAI-Compatible Transport
 * ────────────────────────────────────────────────
 * Four of the five vendors expose an OpenAI-shaped `/chat/completions` surface,
 * either natively (OpenAI, DeepSeek, Perplexity) or through a gateway that
 * fronts several vendors behind one schema. This module implements that wire
 * once, correctly, and every adapter that can use it does.
 *
 * The subtlety this module exists to contain is the MAX-TOKEN TRAP. The three
 * model families disagree about which parameter caps output when the model also
 * reasons before answering:
 *
 *   · GPT-5 family     → `max_completion_tokens`. Sending `max_tokens` truncates
 *                        the answer because reasoning tokens consume the budget
 *                        first and the visible completion arrives empty.
 *   · Claude family    → `max_tokens`, which must exceed the thinking budget.
 *   · Gemini family    → `max_tokens`. Sending `max_completion_tokens` returns
 *                        `content: null` with `finish_reason: "length"`
 *                        regardless of how generous the budget is.
 *
 * Getting this wrong does not raise an error. It returns a successful HTTP 200
 * with an empty answer, which is the worst possible failure mode for a runtime
 * that writes results to an audit chain. The mapping is therefore explicit,
 * table-driven, and covered by tests that assert the emitted body rather than
 * the returned text.
 *
 * Prepared by AMB.
 */

import {
  DEFAULT_TIMEOUT_MS,
  classifyHttpStatus,
  estimateTokens,
  fetchWithTimeout,
  providerFailure,
  truncate,
  type ProviderCitation,
  type ProviderId,
  type ProviderInvocation,
  type ProviderMessage,
  type ProviderResponse,
  type TransportMode,
} from './types';

/** Which max-token parameter a model family honours. */
export type TokenParamStyle = 'max_completion_tokens' | 'max_tokens';

/** Which reasoning-control shape a model family accepts. */
export type ReasoningStyle = 'openai-effort' | 'anthropic-budget' | 'gemini-effort' | 'none';

export interface OpenAICompatibleTarget {
  provider: ProviderId;
  transport: TransportMode;
  baseUrl: string;
  apiKey: string;
  model: string;
  tokenParam: TokenParamStyle;
  reasoning: ReasoningStyle;
  /** Extra headers, e.g. an OpenAI organisation pin. */
  headers?: Record<string, string>;
}

/**
 * Infer the family conventions from a model identifier.
 *
 * This is a pure string decision so it can be asserted in tests without a
 * network. The default is the Claude/Gemini-safe `max_tokens`, because sending
 * `max_completion_tokens` to a family that does not expect it produces the
 * silent-empty-answer failure described above, whereas the converse merely
 * caps output slightly differently.
 */
export function inferFamilyConventions(model: string): {
  tokenParam: TokenParamStyle;
  reasoning: ReasoningStyle;
} {
  const m = model.toLowerCase();
  if (m.startsWith('gpt-') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4')) {
    return { tokenParam: 'max_completion_tokens', reasoning: 'openai-effort' };
  }
  if (m.startsWith('claude')) {
    return { tokenParam: 'max_tokens', reasoning: 'anthropic-budget' };
  }
  if (m.startsWith('gemini')) {
    return { tokenParam: 'max_tokens', reasoning: 'gemini-effort' };
  }
  if (m.startsWith('deepseek')) {
    return { tokenParam: 'max_tokens', reasoning: 'none' };
  }
  if (m.startsWith('sonar')) {
    return { tokenParam: 'max_tokens', reasoning: 'none' };
  }
  return { tokenParam: 'max_tokens', reasoning: 'none' };
}

/**
 * Anthropic requires `max_tokens` strictly greater than `budget_tokens`, and a
 * violation is a hard 400. The budget is therefore derived from the output
 * ceiling rather than configured independently, which makes the invariant
 * structural instead of a documented caution.
 */
export function anthropicThinkingBudget(maxOutputTokens: number, effort: string): number | null {
  if (effort === 'none') return null;
  const fraction = effort === 'high' ? 0.5 : effort === 'medium' ? 0.3 : 0.15;
  const budget = Math.floor(maxOutputTokens * fraction);
  // Anthropic rejects budgets below 1024, and the budget must leave room for a
  // visible answer. When neither holds, thinking is simply not requested.
  if (budget < 1024 || budget >= maxOutputTokens) return null;
  return budget;
}

export function buildChatCompletionsBody(
  target: OpenAICompatibleTarget,
  invocation: ProviderInvocation,
): Record<string, unknown> {
  const messages: ProviderMessage[] = invocation.messages?.length
    ? [...invocation.messages]
    : [
        ...(invocation.system ? [{ role: 'system' as const, content: invocation.system }] : []),
        { role: 'user' as const, content: invocation.prompt },
      ];

  // A generous default: reasoning-capable models spend part of the budget
  // before emitting a single visible character, and a tight ceiling is
  // indistinguishable from a refusal in the response body.
  const maxOut = invocation.maxOutputTokens ?? 8192;

  const body: Record<string, unknown> = {
    model: target.model,
    messages,
  };

  // Temperature is omitted rather than defaulted. Several reasoning models
  // reject any explicit temperature, and a default we did not need would turn
  // a working call into a 400 on those models.
  if (typeof invocation.temperature === 'number') {
    body.temperature = invocation.temperature;
  }

  body[target.tokenParam] = maxOut;

  const effort = invocation.reasoningEffort ?? 'none';
  switch (target.reasoning) {
    case 'openai-effort':
      // `minimal` is the cheapest non-zero setting the GPT-5 family exposes;
      // there is no way to disable reasoning outright, so `none` maps to it.
      body.reasoning = { effort: effort === 'none' ? 'minimal' : effort };
      break;
    case 'anthropic-budget': {
      const budget = anthropicThinkingBudget(maxOut, effort);
      if (budget !== null) body.thinking = { type: 'enabled', budget_tokens: budget };
      break;
    }
    case 'gemini-effort':
      if (effort !== 'none') body.reasoning_effort = effort;
      break;
    case 'none':
      break;
  }

  if (invocation.jsonSchema) {
    body.response_format = {
      type: 'json_schema',
      json_schema: {
        name: invocation.jsonSchema.name,
        strict: true,
        schema: invocation.jsonSchema.schema,
      },
    };
  }

  return body;
}

interface ChatCompletionsPayload {
  choices?: Array<{
    message?: { content?: string | null };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
  };
  /** Perplexity returns its search sources here. */
  citations?: unknown;
  search_results?: unknown;
  error?: unknown;
}

export async function invokeOpenAICompatible(
  target: OpenAICompatibleTarget,
  invocation: ProviderInvocation,
): Promise<ProviderResponse> {
  const started = Date.now();
  const url = `${target.baseUrl.replace(/\/$/, '')}/chat/completions`;
  const body = buildChatCompletionsBody(target, invocation);

  const outcome = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${target.apiKey}`,
        ...(target.headers ?? {}),
      },
      body: JSON.stringify(body),
    },
    invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  );

  const latency = () => Date.now() - started;

  if ('timedOut' in outcome) {
    return providerFailure(
      target.provider,
      target.model,
      target.transport,
      {
        kind: 'timeout',
        message: `no response within ${invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`,
        retryable: true,
      },
      latency(),
    );
  }
  if ('error' in outcome) {
    return providerFailure(
      target.provider,
      target.model,
      target.transport,
      { kind: 'network', message: outcome.error.message, retryable: true },
      latency(),
    );
  }

  const res = outcome.res;
  const rawText = await res.text();

  if (!res.ok) {
    return providerFailure(
      target.provider,
      target.model,
      target.transport,
      classifyHttpStatus(res.status, rawText),
      latency(),
    );
  }

  let payload: ChatCompletionsPayload;
  try {
    payload = JSON.parse(rawText) as ChatCompletionsPayload;
  } catch {
    return providerFailure(
      target.provider,
      target.model,
      target.transport,
      { kind: 'bad-response', message: `non-JSON body: ${truncate(rawText)}`, retryable: true },
      latency(),
    );
  }

  // A gateway may answer 200 while carrying an error object — for example when
  // the requested model is outside its allow-list. Treating that as success
  // would put an empty answer into the audit chain.
  if (payload.error !== undefined && !payload.choices?.length) {
    const msg = typeof payload.error === 'string' ? payload.error : JSON.stringify(payload.error);
    return providerFailure(
      target.provider,
      target.model,
      target.transport,
      {
        kind: /unsupported model|not found|does not exist/i.test(msg)
          ? 'model-unsupported'
          : 'server-error',
        message: truncate(msg),
        retryable: true,
      },
      latency(),
    );
  }

  const choice = payload.choices?.[0];
  const content = typeof choice?.message?.content === 'string' ? choice.message.content : '';
  const finishReason = choice?.finish_reason ?? null;

  if (!content.trim()) {
    // Empty content with `finish_reason: length` is the signature of the
    // max-token trap: the budget was consumed by reasoning. It is reported
    // explicitly so the fallback chain can try another provider instead of
    // recording a blank answer as a success.
    return providerFailure(
      target.provider,
      target.model,
      target.transport,
      {
        kind: 'bad-response',
        message:
          finishReason === 'length'
            ? 'empty completion with finish_reason=length — output budget exhausted before visible tokens'
            : `empty completion (finish_reason=${finishReason ?? 'unknown'})`,
        retryable: true,
      },
      latency(),
    );
  }

  const reported = payload.usage;
  const hasReported =
    typeof reported?.prompt_tokens === 'number' && typeof reported?.completion_tokens === 'number';

  return {
    ok: true,
    provider: target.provider,
    model: target.model,
    transport: target.transport,
    content,
    usage: hasReported
      ? {
          input_tokens: reported!.prompt_tokens as number,
          output_tokens: reported!.completion_tokens as number,
          estimated: false,
        }
      : {
          input_tokens: estimateTokens(invocation.prompt + (invocation.system ?? '')),
          output_tokens: estimateTokens(content),
          estimated: true,
        },
    latency_ms: latency(),
    citations: normaliseCitations(payload),
    finishReason,
    failure: null,
    simulated: false,
  };
}

/**
 * Extract citations from a search-augmented response.
 *
 * Perplexity has shipped several shapes over time — a bare string array under
 * `citations`, and objects under `search_results`. Both are accepted, and an
 * unrecognised shape yields an empty list rather than a partial guess, because
 * a malformed citation is worse than an absent one in an evidence chain.
 */
export function normaliseCitations(payload: {
  citations?: unknown;
  search_results?: unknown;
}): ProviderCitation[] {
  const out: ProviderCitation[] = [];

  if (Array.isArray(payload.search_results)) {
    for (const item of payload.search_results) {
      if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const title = typeof o.title === 'string' ? o.title : undefined;
        const url = typeof o.url === 'string' ? o.url : undefined;
        if (title || url) {
          out.push({
            title: title ?? url ?? 'untitled source',
            url,
            snippet: typeof o.snippet === 'string' ? o.snippet : undefined,
          });
        }
      }
    }
  }

  if (out.length === 0 && Array.isArray(payload.citations)) {
    for (const item of payload.citations) {
      if (typeof item === 'string') {
        out.push({ title: item, url: /^https?:\/\//.test(item) ? item : undefined });
      } else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>;
        const url = typeof o.url === 'string' ? o.url : undefined;
        const title = typeof o.title === 'string' ? o.title : url;
        if (title) out.push({ title, url });
      }
    }
  }

  return out.slice(0, 12);
}
