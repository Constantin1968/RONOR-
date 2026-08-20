/**
 * RONOR Runtime — L1 · Gateway Resolution
 * ───────────────────────────────────────
 * RONOR is model-portable by design, which in practice means an operator may
 * hold a vendor key, a gateway key that fronts several vendors, or both. This
 * module states the resolution order once so that no adapter invents its own.
 *
 *   1. NATIVE FIRST. If the vendor's own key is present, use the vendor's own
 *      API. A direct route has fewer intermediaries, and for sovereignty
 *      accounting "who saw this token" is the question that matters.
 *   2. GATEWAY SECOND. If an OpenAI-compatible gateway is configured and its
 *      allow-list covers the model, route through it and record the hop.
 *   3. OTHERWISE REFUSE. No simulation, no silent substitution of a different
 *      model. `key-absent` is a first-class, reportable state.
 *
 * The gateway allow-list is configuration, not discovery. A runtime that probed
 * the gateway on boot would make startup depend on a third party being awake,
 * and a runtime that probed per-request would pay that latency forever. The
 * list is therefore declared, overridable, and its staleness is an operator
 * concern surfaced in the health endpoint.
 *
 * Prepared by AMB.
 */

import type { ProviderId } from './types';

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  /** Vendor-facing model ids the gateway will accept. */
  allowedModels: string[];
}

/**
 * Default gateway model allow-list.
 *
 * Sourced from the live `/models` catalogue of the OpenAI-compatible proxy at
 * build time and verified by the `runtime:providers` live probe. Override with
 * `RONOR_GATEWAY_MODELS` (comma-separated) when the operator's gateway differs.
 */
export const DEFAULT_GATEWAY_MODELS: readonly string[] = [
  'gpt-5-nano',
  'gpt-5-mini',
  'gpt-5',
  'gpt-5.5',
  'claude-haiku-4-5',
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-opus-4-7',
  'gemini-3-flash-preview',
  'gemini-3.1-pro-preview',
];

export function resolveGateway(env: NodeJS.ProcessEnv = process.env): GatewayConfig | null {
  // RONOR_GATEWAY_* is the explicit, RONOR-owned configuration. OPENAI_API_BASE
  // is honoured as a fallback because it is the conventional variable for an
  // OpenAI-compatible endpoint and many deployments already set it.
  const baseUrl = env.RONOR_GATEWAY_BASE_URL || env.OPENAI_API_BASE || '';
  const apiKey = env.RONOR_GATEWAY_API_KEY || env.OPENAI_API_KEY || '';
  if (!baseUrl || !apiKey) return null;

  const declared = env.RONOR_GATEWAY_MODELS;
  const allowedModels = declared
    ? declared
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : [...DEFAULT_GATEWAY_MODELS];

  return { baseUrl, apiKey, allowedModels };
}

export function gatewayServes(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const gw = resolveGateway(env);
  if (!gw) return false;
  return gw.allowedModels.includes(model);
}

/** Vendor-native credential variable for each provider, stated in one place. */
export const NATIVE_KEY_VARS: Record<Exclude<ProviderId, 'deterministic' | 'ollama'>, string> = {
  openai: 'OPENAI_NATIVE_API_KEY',
  anthropic: 'ANTHROPIC_API_KEY',
  google: 'GEMINI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  perplexity: 'PERPLEXITY_API_KEY',
  kimi: 'KIMI_API_KEY',
};

/**
 * Read a vendor-native key.
 *
 * OpenAI is the deliberate exception. `OPENAI_API_KEY` is overwhelmingly used
 * for gateway credentials in this deployment class, so treating it as a native
 * key would send gateway tokens to `api.openai.com` and fail with a confusing
 * 401. A separate `OPENAI_NATIVE_API_KEY` is therefore required to opt into the
 * direct route, and `OPENAI_BASE_URL` may redirect it.
 */
export function nativeKey(
  provider: Exclude<ProviderId, 'deterministic' | 'ollama'>,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const v = env[NATIVE_KEY_VARS[provider]];
  return v && v.trim() ? v.trim() : null;
}
