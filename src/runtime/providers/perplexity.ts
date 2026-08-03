/**
 * RONOR Runtime — L1 · Perplexity Adapter (search-augmented)
 * ─────────────────────────────────────────────────────────
 * Perplexity's Sonar family is the only provider in the exchange that performs
 * live retrieval as part of generation, which is why it is marked
 * `searchAugmented: true` and why the Researcher worker prefers it.
 *
 * The endpoint is OpenAI-compatible at `api.perplexity.ai`, so the shared
 * transport carries the wire. Three vendor specifics are handled here:
 *
 *   · The API rejects `response_format` on several Sonar models, so a schema
 *     request becomes an instruction and the citations are read from the
 *     envelope rather than parsed out of the prose.
 *   · Sources arrive as `citations` (string URLs) on older responses and
 *     `search_results` (objects) on newer ones. Both shapes are normalised by
 *     the shared transport, and an unrecognised shape yields no citations rather
 *     than a guess — a fabricated source is worse than a missing one in an
 *     evidence chain.
 *   · Search scope options (`search_recency_filter`, `search_domain_filter`) are
 *     vendor-specific and exposed through the invocation's search hints so the
 *     Researcher can bound recency without the router knowing about Perplexity.
 *
 * With no `PERPLEXITY_API_KEY` the state is `key-absent`: no simulation, and the
 * router records the exclusion. The Researcher worker degrades to the
 * `web.search` tool plus a reasoning model, so search capability is never lost
 * outright.
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

export const PERPLEXITY_MODELS = ['sonar-pro', 'sonar', 'sonar-reasoning-pro'] as const;

export interface PerplexitySearchHints {
  /** `hour` | `day` | `week` | `month` | `year` */
  recency?: string;
  /** Restrict or exclude domains; a leading `-` excludes. */
  domains?: string[];
}

export class PerplexityAdapter implements ProviderAdapter {
  readonly descriptor: ProviderDescriptor = {
    id: 'perplexity',
    displayName: 'Perplexity',
    models: [...PERPLEXITY_MODELS],
    searchAugmented: true,
    jurisdictions: ['US'],
  };

  credentialState(env: NodeJS.ProcessEnv = process.env): CredentialState {
    if (nativeKey('perplexity', env)) return 'live-native';
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
    // Sonar models reject `response_format`. The schema becomes an instruction
    // so a worker written once still gets structured output here.
    const adjusted: ProviderInvocation = invocation.jsonSchema
      ? {
          ...invocation,
          jsonSchema: undefined,
          system: `${invocation.system ?? ''}\n\nRespond with a single JSON object conforming to this JSON Schema and nothing else:\n${JSON.stringify(
            invocation.jsonSchema.schema,
          )}`.trim(),
        }
      : invocation;

    const native = nativeKey('perplexity', env);
    if (native) {
      return invokeOpenAICompatible(
        {
          provider: 'perplexity',
          transport: 'native',
          baseUrl: env.PERPLEXITY_BASE_URL || 'https://api.perplexity.ai',
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
          provider: 'perplexity',
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

    return providerFailure('perplexity', invocation.model, 'native', {
      kind: 'credential-absent',
      message:
        'no Perplexity route: set PERPLEXITY_API_KEY to activate search-augmented generation. The Researcher worker degrades to the web.search tool until then.',
      retryable: false,
    });
  }
}
