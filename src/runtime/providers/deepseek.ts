/**
 * RONOR Runtime — L1 · DeepSeek Adapter
 * ─────────────────────────────────────
 * DeepSeek publishes an OpenAI-compatible endpoint at `api.deepseek.com/v1`, so
 * the native route reuses the shared transport rather than reimplementing the
 * wire. Two family facts shape the configuration:
 *
 *   · Output is capped with `max_tokens`. There is no `max_completion_tokens`.
 *   · `deepseek-reasoner` emits its chain of thought in a separate
 *     `reasoning_content` field and REJECTS `temperature`, `top_p` and
 *     `response_format`. The adapter therefore strips the JSON-schema request
 *     for that model and falls back to instruction-plus-extraction, which is
 *     what the worker layer already tolerates.
 *
 * On credentials this adapter is deliberately strict. There is no gateway route
 * in the default allow-list, so with no `DEEPSEEK_API_KEY` its state is
 * `key-absent` and the router excludes it from candidacy with a recorded reason.
 * It does not simulate. An operator who adds the key gets a live provider on the
 * next request with no code change and no redeploy.
 *
 * Prepared by AMB.
 */

import { nativeKey, resolveGateway, gatewayServes } from './gateway';
import { invokeOpenAICompatible } from './openai-compatible';
import {
  providerFailure,
  type CredentialState,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderInvocation,
  type ProviderResponse,
} from './types';

export const DEEPSEEK_MODELS = ['deepseek-chat', 'deepseek-reasoner'] as const;

/** Models that reject `response_format` and sampling parameters. */
const REASONER_MODELS = new Set(['deepseek-reasoner']);

export class DeepSeekAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'deepseek',
    displayName: 'DeepSeek',
    models: [...DEEPSEEK_MODELS],
    searchAugmented: false,
    jurisdictions: ['CN'],
  };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    if (nativeKey('deepseek', env)) return 'live-native';
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
    // `deepseek-reasoner` 400s on response_format and on sampling parameters.
    // Removing them here keeps one worker schema usable across every provider.
    const adjusted: ProviderInvocation = REASONER_MODELS.has(invocation.model)
      ? {
          ...invocation,
          temperature: undefined,
          jsonSchema: undefined,
          system: invocation.jsonSchema
            ? `${invocation.system ?? ''}\n\nRespond with a single JSON object conforming to this JSON Schema and nothing else:\n${JSON.stringify(
                invocation.jsonSchema.schema,
              )}`.trim()
            : invocation.system,
        }
      : invocation;

    const native = nativeKey('deepseek', env);
    if (native) {
      return invokeOpenAICompatible(
        {
          provider: 'deepseek',
          transport: 'native',
          baseUrl: env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1',
          apiKey: native,
          model: adjusted.model,
          tokenParam: 'max_tokens',
          reasoning: 'none',
        },
        adjusted,
      );
    }

    const gw = resolveGateway(env);
    if (gw && gatewayServes(adjusted.model, env)) {
      return invokeOpenAICompatible(
        {
          provider: 'deepseek',
          transport: 'gateway',
          baseUrl: gw.baseUrl,
          apiKey: gw.apiKey,
          model: adjusted.model,
          tokenParam: 'max_tokens',
          reasoning: 'none',
        },
        adjusted,
      );
    }

    return providerFailure('deepseek', invocation.model, 'native', {
      kind: 'credential-absent',
      message:
        'no DeepSeek route: set DEEPSEEK_API_KEY to activate this provider. The adapter is complete and requires no code change.',
      retryable: false,
    });
  }
}
