/**
 * RONOR Runtime — L1 · Google Gemini Adapter
 * ──────────────────────────────────────────
 * NATIVE: `POST /v1beta/models/{model}:generateContent`, which departs from the
 * OpenAI schema more than any other vendor in the exchange:
 *
 *   · The key travels as `?key=` on the query string (an `x-goog-api-key`
 *     header is also accepted; we use the header to keep keys out of logs).
 *   · Turns are `contents[]` with `role: "user" | "model"` — there is no
 *     `assistant` role, and no `system` role. The system instruction is a
 *     separate top-level `systemInstruction` object.
 *   · Generation controls live under `generationConfig`, where the output cap is
 *     `maxOutputTokens`.
 *   · Structured output is `responseMimeType: "application/json"` plus
 *     `responseSchema`, which is a RESTRICTED JSON Schema dialect: it rejects
 *     `additionalProperties`, `$schema` and several other keywords, so the
 *     schema is sanitised before it is sent.
 *   · A response can be blocked by safety filters with HTTP 200 and no
 *     candidate. That is a content refusal, not a server error, and it is
 *     classified as such so the fallback chain reacts correctly.
 *
 * GATEWAY: an OpenAI-compatible proxy flattens all of this. The one trap the
 * shared transport encodes is that Gemini must be capped with `max_tokens` —
 * sending `max_completion_tokens` returns a null completion with
 * `finish_reason: "length"` no matter how large the budget is.
 *
 * Prepared by AMB.
 */

import { nativeKey, resolveGateway, gatewayServes } from './gateway';
import { inferFamilyConventions, invokeOpenAICompatible } from './openai-compatible';
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

export const GOOGLE_MODELS = ['gemini-3.1-pro-preview', 'gemini-3.7-flash', 'gemini-3.6-flash'] as const;

/**
 * Strip JSON Schema keywords Gemini's `responseSchema` dialect rejects.
 *
 * Sending an unsupported keyword is a 400 on the whole request, so a schema
 * authored for OpenAI's strict mode — which REQUIRES `additionalProperties:
 * false` — would fail here. Sanitising is therefore not optional politeness; it
 * is what lets one worker schema serve every provider.
 */
export function sanitiseGeminiSchema(schema: unknown): unknown {
  if (Array.isArray(schema)) return schema.map(sanitiseGeminiSchema);
  if (!schema || typeof schema !== 'object') return schema;

  const rejected = new Set([
    'additionalProperties',
    '$schema',
    '$id',
    'definitions',
    '$defs',
    'strict',
    'default',
    'examples',
    'const',
  ]);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(schema as Record<string, unknown>)) {
    if (rejected.has(k)) continue;
    out[k] = sanitiseGeminiSchema(v);
  }
  return out;
}

export class GoogleAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'google',
    displayName: 'Google DeepMind',
    models: [...GOOGLE_MODELS],
    searchAugmented: false,
    jurisdictions: ['US'],
  };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    if (nativeKey('google', env)) return 'live-native';
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
    const native = nativeKey('google', env);
    if (native) return this.invokeNative(native, invocation, env);

    const gw = resolveGateway(env);
    if (gw && gatewayServes(invocation.model, env)) {
      return invokeOpenAICompatible(
        {
          provider: 'google',
          transport: 'gateway',
          baseUrl: gw.baseUrl,
          apiKey: gw.apiKey,
          model: invocation.model,
          ...inferFamilyConventions(invocation.model),
        },
        invocation,
      );
    }

    return providerFailure('google', invocation.model, 'native', {
      kind: 'credential-absent',
      message:
        'no Google route: set GEMINI_API_KEY for the native Generative Language API, or configure a gateway whose allow-list covers this model',
      retryable: false,
    });
  }

  private async invokeNative(
    apiKey: string,
    invocation: ProviderInvocation,
    env: NodeJS.ProcessEnv,
  ): Promise<ProviderResponse> {
    const started = Date.now();
    const baseUrl = (
      env.GEMINI_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta'
    ).replace(/\/$/, '');

    const turns = invocation.messages?.length
      ? invocation.messages
      : [{ role: 'user' as const, content: invocation.prompt }];

    const systemParts: string[] = [];
    if (invocation.system) systemParts.push(invocation.system);

    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];
    for (const t of turns) {
      if (t.role === 'system') {
        systemParts.push(t.content);
        continue;
      }
      // There is no `assistant` role in this API; prior model turns are `model`.
      contents.push({ role: t.role === 'assistant' ? 'model' : 'user', parts: [{ text: t.content }] });
    }

    const generationConfig: Record<string, unknown> = {
      maxOutputTokens: invocation.maxOutputTokens ?? 8192,
    };
    if (typeof invocation.temperature === 'number') {
      generationConfig.temperature = invocation.temperature;
    }
    if (invocation.jsonSchema) {
      generationConfig.responseMimeType = 'application/json';
      generationConfig.responseSchema = sanitiseGeminiSchema(invocation.jsonSchema.schema);
    }

    const body: Record<string, unknown> = { contents, generationConfig };
    if (systemParts.length) {
      body.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    }

    const outcome = await fetchWithTimeout(
      `${baseUrl}/models/${encodeURIComponent(invocation.model)}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify(body),
      },
      invocation.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );

    const latency = () => Date.now() - started;

    if ('timedOut' in outcome) {
      return providerFailure(
        'google',
        invocation.model,
        'native',
        { kind: 'timeout', message: 'Gemini did not respond within the deadline', retryable: true },
        latency(),
      );
    }
    if ('error' in outcome) {
      return providerFailure(
        'google',
        invocation.model,
        'native',
        { kind: 'network', message: outcome.error.message, retryable: true },
        latency(),
      );
    }

    const raw = await outcome.res.text();
    if (!outcome.res.ok) {
      return providerFailure(
        'google',
        invocation.model,
        'native',
        classifyHttpStatus(outcome.res.status, raw),
        latency(),
      );
    }

    let payload: {
      candidates?: Array<{
        content?: { parts?: Array<{ text?: string }> };
        finishReason?: string;
      }>;
      promptFeedback?: { blockReason?: string };
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
    };
    try {
      payload = JSON.parse(raw);
    } catch {
      return providerFailure(
        'google',
        invocation.model,
        'native',
        { kind: 'bad-response', message: `non-JSON body: ${truncate(raw)}`, retryable: true },
        latency(),
      );
    }

    // A safety block arrives as HTTP 200 with no candidate. Reporting it as a
    // server error would invite a pointless retry against the same filter.
    if (payload.promptFeedback?.blockReason) {
      return providerFailure(
        'google',
        invocation.model,
        'native',
        {
          kind: 'content-refused',
          message: `prompt blocked by safety filter: ${payload.promptFeedback.blockReason}`,
          retryable: true,
        },
        latency(),
      );
    }

    const candidate = payload.candidates?.[0];
    const content = (candidate?.content?.parts ?? [])
      .map((p) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();

    if (!content) {
      return providerFailure(
        'google',
        invocation.model,
        'native',
        {
          kind: 'bad-response',
          message: `empty candidate (finishReason=${candidate?.finishReason ?? 'unknown'})`,
          retryable: true,
        },
        latency(),
      );
    }

    const um = payload.usageMetadata;
    const measured =
      typeof um?.promptTokenCount === 'number' && typeof um?.candidatesTokenCount === 'number';

    return {
      ok: true,
      provider: 'google',
      model: invocation.model,
      transport: 'native',
      content,
      usage: measured
        ? {
            input_tokens: um!.promptTokenCount as number,
            output_tokens: um!.candidatesTokenCount as number,
            estimated: false,
          }
        : {
            input_tokens: estimateTokens(invocation.prompt + (invocation.system ?? '')),
            output_tokens: estimateTokens(content),
            estimated: true,
          },
      latency_ms: latency(),
      citations: [],
      finishReason: candidate?.finishReason ?? null,
      failure: null,
      simulated: false,
    };
  }
}
