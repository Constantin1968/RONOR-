/**
 * RONOR Runtime — L1 · Provider Registry
 * ──────────────────────────────────────
 * The single place the runtime learns which adapters exist and which of them can
 * actually run. Two design choices are deliberate:
 *
 *   · ADAPTERS ARE SINGLETONS, held in a frozen map. An adapter holds no request
 *     state, so there is nothing to isolate per call, and a single instance
 *     makes the health surface trivially consistent with the routing surface.
 *
 *   · CREDENTIAL STATE IS COMPUTED ON DEMAND, NEVER CACHED. An operator who adds
 *     `PERPLEXITY_API_KEY` and restarts nothing should see the provider become
 *     live on the next request. Caching would convert a configuration change
 *     into a deployment, which is exactly the friction this layer exists to
 *     remove.
 *
 * Prepared by AMB.
 */

import { AnthropicAdapter } from './anthropic';
import { DeepSeekAdapter } from './deepseek';
import { DeterministicAdapter } from './deterministic';
import { GoogleAdapter } from './google';
import { OpenAIAdapter } from './openai';
import { PerplexityAdapter } from './perplexity';
import { KimiAdapter } from './kimi';
import { OllamaAdapter } from './ollama';
import type { CredentialState, ProviderAdapter, ProviderId } from './types';

const ADAPTERS: ReadonlyMap<ProviderId, ProviderAdapter> = new Map<ProviderId, ProviderAdapter>([
  ['openai', new OpenAIAdapter()],
  ['anthropic', new AnthropicAdapter()],
  ['google', new GoogleAdapter()],
  ['deepseek', new DeepSeekAdapter()],
  ['perplexity', new PerplexityAdapter()],
  ['kimi', new KimiAdapter()],
  ['ollama', new OllamaAdapter()],
  ['deterministic', new DeterministicAdapter()],
]);

export function getAdapter(provider: ProviderId): ProviderAdapter | null {
  return ADAPTERS.get(provider) ?? null;
}

export function listAdapters(): ProviderAdapter[] {
  return [...ADAPTERS.values()];
}

export interface ProviderStatus {
  provider: ProviderId;
  displayName: string;
  credentialState: CredentialState;
  /** True when a request routed here would reach a vendor. */
  invocable: boolean;
  transport: 'native' | 'gateway' | 'local' | 'none';
  models: string[];
  searchAugmented: boolean;
  jurisdictions: string[];
}

export function providerStatuses(env: NodeJS.ProcessEnv = process.env): ProviderStatus[] {
  return listAdapters().map((a) => {
    const state = a.credentialState(env);
    return {
      provider: a.descriptor.id,
      displayName: a.descriptor.displayName,
      credentialState: state,
      invocable: state !== 'key-absent',
      transport:
        state === 'live-native'
          ? 'native'
          : state === 'live-gateway'
            ? 'gateway'
            : state === 'live-local'
              ? 'local'
              : 'none',
      models: [...a.descriptor.models],
      searchAugmented: a.descriptor.searchAugmented,
      jurisdictions: [...a.descriptor.jurisdictions],
    };
  });
}

export function invocableProviders(env: NodeJS.ProcessEnv = process.env): Set<ProviderId> {
  const out = new Set<ProviderId>();
  for (const a of listAdapters()) {
    if (a.credentialState(env) !== 'key-absent') out.add(a.descriptor.id);
  }
  return out;
}

/** Is there any live provider capable of live web retrieval? */
export function hasSearchAugmentedProvider(env: NodeJS.ProcessEnv = process.env): boolean {
  return listAdapters().some(
    (a) => a.descriptor.searchAugmented && a.credentialState(env) !== 'key-absent',
  );
}
