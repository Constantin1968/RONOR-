/**
 * RONOR Runtime — L1 · OpenAI Adapter
 * ───────────────────────────────────
 * The GPT-5 family. Notable family behaviours, each of which the shared
 * transport already encodes but which are worth stating where an operator will
 * look for them:
 *
 *   · Output is capped with `max_completion_tokens`, never `max_tokens`.
 *   · Reasoning is always on; `effort: "minimal"` is the floor, not "off".
 *     A minimal-effort call still bills reasoning tokens, which is why the
 *     Cost-of-Intelligence ledger reads the vendor's reported usage rather than
 *     inferring spend from the visible answer.
 *   · Strict JSON schema is honoured, so the workers request it rather than
 *     asking the model politely for JSON and parsing hopefully.
 *
 * Prepared by AMB.
 */

import { nativeKey, resolveGateway, gatewayServes } from './gateway';
import { invokeOpenAICompatible, inferFamilyConventions } from './openai-compatible';
import {
  providerFailure,
  type CredentialState,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderInvocation,
  type ProviderResponse,
} from './types';

export const OPENAI_MODELS = ['gpt-5.5', 'gpt-5', 'gpt-5-mini', 'gpt-5-nano'] as const;

export class OpenAIAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'openai',
    displayName: 'OpenAI',
    models: [...OPENAI_MODELS],
    searchAugmented: false,
    jurisdictions: ['US'],
  };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    if (nativeKey('openai', env)) return 'live-native';
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
    const conventions = inferFamilyConventions(invocation.model);

    const native = nativeKey('openai', env);
    if (native) {
      return invokeOpenAICompatible(
        {
          provider: 'openai',
          transport: 'native',
          baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1',
          apiKey: native,
          model: invocation.model,
          ...conventions,
          ...(env.OPENAI_ORG_ID ? { headers: { 'OpenAI-Organization': env.OPENAI_ORG_ID } } : {}),
        },
        invocation,
      );
    }

    const gw = resolveGateway(env);
    if (gw && gatewayServes(invocation.model, env)) {
      return invokeOpenAICompatible(
        {
          provider: 'openai',
          transport: 'gateway',
          baseUrl: gw.baseUrl,
          apiKey: gw.apiKey,
          model: invocation.model,
          ...conventions,
        },
        invocation,
      );
    }

    return providerFailure('openai', invocation.model, 'native', {
      kind: 'credential-absent',
      message:
        'no OpenAI route: set OPENAI_NATIVE_API_KEY for the direct API, or configure a gateway whose allow-list covers this model',
      retryable: false,
    });
  }
}
