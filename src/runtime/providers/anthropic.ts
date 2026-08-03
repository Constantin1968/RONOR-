/**
 * RONOR Runtime — L1 · Anthropic Adapter
 * ──────────────────────────────────────
 * Two routes, one contract.
 *
 * NATIVE: `POST /v1/messages`, which is NOT OpenAI-shaped. The differences that
 * matter are all in this file rather than hidden in the shared transport:
 *
 *   · `x-api-key` header, not `Authorization: Bearer`.
 *   · `anthropic-version` is mandatory; omitting it is a 400.
 *   · The system instruction is a TOP-LEVEL `system` field. Sending a
 *     `role: "system"` message is rejected.
 *   · Content is an array of typed blocks. With extended thinking enabled the
 *     first block is a `thinking` block, so taking `content[0]` yields the
 *     model's private reasoning instead of its answer — we filter for `text`.
 *   · `max_tokens` MUST exceed `thinking.budget_tokens`. This is a hard 400 and
 *     the budget is therefore derived from the ceiling, never set beside it.
 *   · There is no `response_format`. Structured output is obtained by
 *     instruction plus extraction, so JSON requests append an explicit
 *     schema-shaped instruction and the reader tolerates prose around the object.
 *
 * GATEWAY: an OpenAI-compatible proxy normalises all of the above, so when no
 * vendor key is present the same models are reachable through the shared
 * transport with `max_tokens` and Anthropic-style thinking budgets.
 *
 * Prepared by AMB.
 */

import { nativeKey, resolveGateway, gatewayServes } from './gateway';
import {
  anthropicThinkingBudget,
  inferFamilyConventions,
  invokeOpenAICompatible,
} from './openai-compatible';
import {
  DEFAULT_TIMEOUT_MS,
  classifyHttpStatus,
  estimateTokens,
  fetchWithTimeout,
  providerFailure,
  truncate,
  type CredentialState,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderInvocation,
  type ProviderResponse,
} from './types';

export const ANTHROPIC_MODELS = [
  'claude-opus-4-7',
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
] as const;

const ANTHROPIC_VERSION = '2023-06-01';

export class AnthropicAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'anthropic',
    displayName: 'Anthropic',
    models: [...ANTHROPIC_MODELS],
    searchAugmented: false,
    jurisdictions: ['US'],
  };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    if (nativeKey('anthropic', env)) return 'live-native';
    const gw = resolveGateway(env);
    if (gw && this.descriptor.models.some((m) => gw.allowedModels.includes(m))) {
      return 'live-gateway';
    }
    return 'key-absent';
  }

  async invoke(
    invocation: ProviderInvocation,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ProviderResponse> {
    const native = nativeKey('anthropic', env);
    if (native) return this.invokeNative(native, invocation, env);

    const gw = resolveGateway(env);
    if (gw && gatewayServes(invocation.model, env)) {
      return invokeOpenAICompatible(
        {
          provider: 'anthropic',
          transport: 'gateway',
          baseUrl: gw.baseUrl,
          apiKey: gw.apiKey,
          model: invocation.model,
          ...inferFamilyConventions(invocation.model),
        },
        invocation,
      );
    }

    return providerFailure('anthropic', invocation.model, 'native', {
      kind: 'credential-absent',
      message:
        'no Anthropic route: set ANTHROPIC_API_KEY for the native Messages API, or configure a gateway whose allow-list covers this model',
      retryable: false,
    });
  }

  private async invokeNative(
    apiKey: string,
    invocation: ProviderInvocation,
    env: NodeJS.ProcessEnv,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    const baseUrl = (env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1').replace(/\/$/, '');
    const maxOut = invocation.maxOutputTokens ?? 8192;

    // Anthropic has no `response_format`. A schema request becomes an explicit
    // instruction so the caller's contract is still satisfied, and the reader
    // below tolerates the model wrapping the object in prose.
    const systemParts: string[] = [];
    if (invocation.system) systemParts.push(invocation.system);
    if (invocation.jsonSchema) {
      systemParts.push(
        `Respond with a single JSON object conforming to this JSON Schema and nothing else:\n${JSON.stringify(
          invocation.jsonSchema.schema,
        )}`,
      );
    }

    const messages = (
      invocation.messages?.length
        ? invocation.messages
        : [{ role: 'user' as const, content: invocation.prompt }]
    )
      // A system-role message is a 400 on this API; its content is folded into
      // the top-level field instead of being dropped.
      .filter((m) => {
        if (m.role === 'system') {
          systemParts.push(m.content);
          return false;
        }
        return true;
      })
      .map((m) => ({ role: m.role, content: m.content }));

    const body: Record<string, unknown> = {
      model: invocation.model,
      max_tokens: maxOut,
      messages,
    };
    if (systemParts.length) body.system = systemParts.join('\n\n');
    if (typeof invocation.temperature === 'number') body.temperature = invocation.temperature;

    const budget = anthropicThinkingBudget(maxOut, invocation.reasoningEffort ?? 'none');
    if (budget !== null) {
      body.thinking = { type: 'enabled', budget_tokens: budget };
      // Extended thinking forbids an explicit temperature.
      delete body.temperature;
    }

    const outcome = await fetchWithTimeout(
      `${baseUrl}/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': env.ANTHROPIC_VERSION || ANTHROPIC_VERSION,
        },
        body: JSON.stringify(body),
      },
      invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const latency = () => Date.now() - started;

    if ('timedOut' in outcome) {
      return providerFailure(
        'anthropic',
        invocation.model,
        'native',
        { kind: 'timeout', message: 'Anthropic did not respond within the deadline', retryable: true },
        latency(),
      );
    }
    if ('error' in outcome) {
      return providerFailure(
        'anthropic',
        invocation.model,
        'native',
        { kind: 'network', message: outcome.error.message, retryable: true },
        latency(),
      );
    }

    const raw = await outcome.res.text();
    if (!outcome.res.ok) {
      return providerFailure(
        'anthropic',
        invocation.model,
        'native',
        classifyHttpStatus(outcome.res.status, raw),
        latency(),
      );
    }

    let payload: {
      content?: Array<{ type?: string; text?: string }>;
      stop_reason?: string | null;
      usage?: { input_tokens?: number; output_tokens?: number };
    };
    try {
      payload = JSON.parse(raw);
    } catch {
      return providerFailure(
        'anthropic',
        invocation.model,
        'native',
        { kind: 'bad-response', message: `non-JSON body: ${truncate(raw)}`, retryable: true },
        latency(),
      );
    }

    // Only `text` blocks are the answer. With thinking enabled the array also
    // holds a `thinking` block, and reading position zero would return private
    // reasoning as if it were the response.
    const content = (payload.content ?? [])
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n')
      .trim();

    if (!content) {
      return providerFailure(
        'anthropic',
        invocation.model,
        'native',
        {
          kind: 'bad-response',
          message: `no text block in response (stop_reason=${payload.stop_reason ?? 'unknown'})`,
          retryable: true,
        },
        latency(),
      );
    }

    const usage = payload.usage;
    const measured =
      typeof usage?.input_tokens === 'number' && typeof usage?.output_tokens === 'number';

    return {
      ok: true,
      provider: 'anthropic',
      model: invocation.model,
      transport: 'native',
      content,
      usage: measured
        ? {
            input_tokens: usage!.input_tokens as number,
            output_tokens: usage!.output_tokens as number,
            estimated: false,
          }
        : {
            input_tokens: estimateTokens(invocation.prompt + (invocation.system ?? '')),
            output_tokens: estimateTokens(content),
            estimated: true,
          },
      latency_ms: latency(),
      citations: [],
      finishReason: payload.stop_reason ?? null,
      failure: null,
      simulated: false,
    };
  }
}
