/**
 * RONOR Runtime — L1 · Kimi (Moonshot AI) Adapter
 * ────────────────────────────────────────────────────
 * Moonshot AI publishes an OpenAI-compatible endpoint at api.moonshot.ai/v1.
 * The supported identifiers mirror the provider's published model list. The
 * adapter follows the same pattern as DeepSeek: native-first, key-absent otherwise.
 *
 * Credential variable: KIMI_API_KEY
 * Base URL override:   KIMI_API_BASE  (default https://api.moonshot.ai/v1)
 *
 * Prepared by AMB (operator-injected, 2026-08-05).
 */
import { invokeOpenAICompatible } from './openai-compatible';
import {
  providerFailure,
  type CredentialState,
  type ProviderAdapter,
  type ProviderDescriptor,
  type ProviderInvocation,
  type ProviderResponse,
} from './types';

export const KIMI_MODELS = [
  'kimi-k2.6',
  'kimi-k2.5',
  'moonshot-v1-8k',
  'moonshot-v1-32k',
  'moonshot-v1-128k',
] as const;

export class KimiAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'kimi',
    displayName: 'Kimi (Moonshot AI)',
    models: [...KIMI_MODELS],
    searchAugmented: false,
    jurisdictions: ['CN'],
  };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    const key = env.KIMI_API_KEY;
    if (key && key.trim()) return 'live-native';
    return 'key-absent';
  }

  async invoke(
    invocation: ProviderInvocation,
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<ProviderResponse> {
    const key = env.KIMI_API_KEY;
    if (key && key.trim()) {
      return invokeOpenAICompatible(
        {
          provider: 'kimi',
          transport: 'native',
          baseUrl: env.KIMI_API_BASE || 'https://api.moonshot.ai/v1',
          apiKey: key.trim(),
          model: invocation.model,
          tokenParam: 'max_tokens',
          reasoning: 'none',
        },
        invocation,
      );
    }
    return providerFailure('kimi', invocation.model, 'native', {
      kind: 'credential-absent',
      message:
        'no Kimi route: set KIMI_API_KEY to activate this provider. The adapter is complete and requires no code change.',
      retryable: false,
    });
  }
}
