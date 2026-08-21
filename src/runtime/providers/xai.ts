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

export const XAI_MODELS = ['grok-4.5'] as const;

export class XAIAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'xai',
    displayName: 'Grok (xAI)',
    models: [...XAI_MODELS],
    searchAugmented: false,
    jurisdictions: ['US'],
  };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    if (nativeKey('xai', env)) return 'live-native';
    const gateway = resolveGateway(env);
    return gateway && this.descriptor.models.some((model) => gateway.allowedModels.includes(model))
      ? 'live-gateway'
      : 'key-absent';
  }

  async invoke(invocation: ProviderInvocation, env: NodeJS.ProcessEnv = process.env): Promise<ProviderResponse> {
    const native = nativeKey('xai', env);
    if (native) {
      return invokeOpenAICompatible({
        provider: 'xai', transport: 'native',
        baseUrl: env.XAI_BASE_URL || 'https://api.x.ai/v1', apiKey: native,
        model: invocation.model, tokenParam: 'max_tokens', reasoning: 'none',
      }, invocation);
    }
    const gateway = resolveGateway(env);
    if (gateway && gatewayServes(invocation.model, env)) {
      return invokeOpenAICompatible({
        provider: 'xai', transport: 'gateway', baseUrl: gateway.baseUrl,
        apiKey: gateway.apiKey, model: invocation.model,
        tokenParam: 'max_tokens', reasoning: 'none',
      }, invocation);
    }
    return providerFailure('xai', invocation.model, 'native', {
      kind: 'credential-absent',
      message: 'no xAI route: set XAI_API_KEY to activate Grok; no credential is stored by the adapter',
      retryable: false,
    });
  }
}
