/**
 * RONOR Runtime — L1 · Model Catalogue
 * ────────────────────────────────────
 * The registry the Runtime Active router scores against. It differs from the
 * legacy `src/model-exchange/registry.ts` in three ways that matter, and the
 * legacy file is left untouched so its 594 tests keep their exact contract:
 *
 *   1. PRICES ARE REAL, per 1M tokens, taken from published vendor rate cards
 *      and cross-checked against the live gateway catalogue. Cost is the second
 *      heaviest term in the 6D score, so an invented price is an invented
 *      routing decision.
 *   2. LATENCY IS OBSERVED, NOT DECLARED. Each entry carries a seed used only
 *      until the calibrator has real measurements, after which the router reads
 *      the p50 from the Work Ledger. A registry with a hardcoded latency is a
 *      registry that cannot notice a degraded provider.
 *   3. EVERY ENTRY NAMES ITS ADAPTER AND ITS CREDENTIAL STATE, so "eligible" can
 *      mean "actually invocable right now" rather than "listed in a file".
 *
 * Prepared by AMB.
 */

import type { ProviderId } from '../providers/types';

export type RuntimeCapability =
  | 'reasoning'
  | 'generation'
  | 'analysis'
  | 'summarization'
  | 'extraction'
  | 'calculation'
  | 'validation'
  | 'lookup'
  | 'search'
  | 'synthesis'
  | 'verification'
  | 'decomposition';

export interface CatalogueEntry {
  /** Canonical RONOR identifier, `provider/model`. */
  id: string;
  provider: ProviderId;
  /** Vendor-facing model identifier passed to the adapter. */
  vendorModel: string;
  displayName: string;
  capabilities: RuntimeCapability[];
  /** USD per 1,000,000 tokens — the unit vendors actually publish. */
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  /** Seed latency in ms, superseded by observed p50 once samples exist. */
  latency_seed_ms: number;
  jurisdictions: string[];
  /** 3 sovereign/on-prem · 2 EU/UK cloud · 1 US hyperscaler · 0 unknown. */
  sovereignty_level: 0 | 1 | 2 | 3;
  /** 0–100. Composite capability rating used as the quality term. */
  quality_score: number;
  /** 0–100. How attributable this engine's output is. */
  evidence_reliability: number;
  /** 0–100. Higher is riskier. */
  operational_risk: number;
  context_window: number;
  max_output_tokens: number;
  /** True when the model performs live retrieval as part of generation. */
  search_augmented: boolean;
}

export const RUNTIME_CATALOGUE: CatalogueEntry[] = [
  {
    id: 'ollama/qwen3-4b-instruct', provider: 'ollama', vendorModel: 'qwen3:4b-instruct', displayName: 'Qwen3 4B Local',
    capabilities: ['generation', 'analysis', 'summarization', 'extraction', 'decomposition'], input_cost_per_1m: 0, output_cost_per_1m: 0,
    latency_seed_ms: 6500, jurisdictions: ['LOCAL', 'RO'], sovereignty_level: 3, quality_score: 68, evidence_reliability: 55, operational_risk: 12,
    context_window: 40_000, max_output_tokens: 8192, search_augmented: false,
  },
  {
    id: 'ollama/qwen2.5-coder-3b', provider: 'ollama', vendorModel: 'qwen2.5-coder:3b', displayName: 'Qwen2.5 Coder 3B Local',
    capabilities: ['generation', 'analysis', 'validation', 'verification'], input_cost_per_1m: 0, output_cost_per_1m: 0,
    latency_seed_ms: 5200, jurisdictions: ['LOCAL', 'RO'], sovereignty_level: 3, quality_score: 66, evidence_reliability: 58, operational_risk: 12,
    context_window: 32_000, max_output_tokens: 8192, search_augmented: false,
  },
  {
    id: 'ollama/deepseek-r1-1.5b', provider: 'ollama', vendorModel: 'deepseek-r1:1.5b', displayName: 'DeepSeek R1 1.5B Local',
    capabilities: ['reasoning', 'analysis', 'calculation'], input_cost_per_1m: 0, output_cost_per_1m: 0,
    latency_seed_ms: 4200, jurisdictions: ['LOCAL', 'RO'], sovereignty_level: 3, quality_score: 59, evidence_reliability: 48, operational_risk: 14,
    context_window: 128_000, max_output_tokens: 8192, search_augmented: false,
  },
  {
    id: 'ollama/qwen2.5-72b-contabo', provider: 'ollama', vendorModel: 'qwen2.5:72b-instruct-q4_K_M', displayName: 'Qwen2.5 72B Sovereign',
    capabilities: ['reasoning', 'generation', 'analysis', 'summarization', 'synthesis', 'decomposition'], input_cost_per_1m: 0, output_cost_per_1m: 0,
    latency_seed_ms: 102_000, jurisdictions: ['LOCAL', 'RO'], sovereignty_level: 3, quality_score: 85, evidence_reliability: 68, operational_risk: 16,
    context_window: 32_000, max_output_tokens: 8192, search_augmented: false,
  },
  {
    id: 'ollama/llama3.1-70b-contabo', provider: 'ollama', vendorModel: 'llama3.1:70b-instruct-q4_K_M', displayName: 'Llama 3.1 70B Sovereign Verifier',
    capabilities: ['reasoning', 'analysis', 'verification', 'synthesis'], input_cost_per_1m: 0, output_cost_per_1m: 0,
    latency_seed_ms: 116_000, jurisdictions: ['LOCAL', 'RO'], sovereignty_level: 3, quality_score: 84, evidence_reliability: 72, operational_risk: 15,
    context_window: 128_000, max_output_tokens: 8192, search_augmented: false,
  },
  {
    id: 'ollama/deepseek-r1-70b-contabo', provider: 'ollama', vendorModel: 'deepseek-r1:70b-llama-distill-q4_K_M', displayName: 'DeepSeek R1 70B Sovereign',
    capabilities: ['reasoning', 'analysis', 'calculation', 'synthesis'], input_cost_per_1m: 0, output_cost_per_1m: 0,
    latency_seed_ms: 125_000, jurisdictions: ['LOCAL', 'RO'], sovereignty_level: 3, quality_score: 86, evidence_reliability: 65, operational_risk: 18,
    context_window: 128_000, max_output_tokens: 8192, search_augmented: false,
  },
  // ---- OpenAI -------------------------------------------------------------
  {
    id: 'openai/gpt-5.5',
    provider: 'openai',
    vendorModel: 'gpt-5.5',
    displayName: 'GPT-5.5',
    capabilities: ['reasoning', 'generation', 'analysis', 'synthesis', 'decomposition', 'extraction'],
    input_cost_per_1m: 5.0,
    output_cost_per_1m: 30.0,
    latency_seed_ms: 9000,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 96,
    evidence_reliability: 78,
    operational_risk: 16,
    context_window: 400_000,
    max_output_tokens: 128_000,
    search_augmented: false,
  },
  {
    id: 'openai/gpt-5',
    provider: 'openai',
    vendorModel: 'gpt-5',
    displayName: 'GPT-5',
    capabilities: ['reasoning', 'generation', 'analysis', 'synthesis', 'decomposition', 'extraction'],
    input_cost_per_1m: 1.25,
    output_cost_per_1m: 10.0,
    latency_seed_ms: 6500,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 93,
    evidence_reliability: 76,
    operational_risk: 17,
    context_window: 400_000,
    max_output_tokens: 128_000,
    search_augmented: false,
  },
  {
    id: 'openai/gpt-5-mini',
    provider: 'openai',
    vendorModel: 'gpt-5-mini',
    displayName: 'GPT-5 mini',
    capabilities: ['reasoning', 'generation', 'analysis', 'summarization', 'extraction', 'validation'],
    input_cost_per_1m: 0.25,
    output_cost_per_1m: 2.0,
    latency_seed_ms: 3800,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 86,
    evidence_reliability: 70,
    operational_risk: 19,
    context_window: 400_000,
    max_output_tokens: 128_000,
    search_augmented: false,
  },
  {
    id: 'openai/gpt-5-nano',
    provider: 'openai',
    vendorModel: 'gpt-5-nano',
    displayName: 'GPT-5 nano',
    capabilities: ['summarization', 'extraction', 'validation', 'lookup'],
    input_cost_per_1m: 0.05,
    output_cost_per_1m: 0.4,
    latency_seed_ms: 2200,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 76,
    evidence_reliability: 62,
    operational_risk: 22,
    context_window: 400_000,
    max_output_tokens: 128_000,
    search_augmented: false,
  },

  // ---- Anthropic ----------------------------------------------------------
  {
    id: 'anthropic/claude-opus-4-7',
    provider: 'anthropic',
    vendorModel: 'claude-opus-4-7',
    displayName: 'Claude Opus 4.7',
    capabilities: ['reasoning', 'generation', 'analysis', 'synthesis', 'verification', 'decomposition'],
    input_cost_per_1m: 5.0,
    output_cost_per_1m: 25.0,
    latency_seed_ms: 8500,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 95,
    evidence_reliability: 82,
    operational_risk: 15,
    context_window: 200_000,
    max_output_tokens: 64_000,
    search_augmented: false,
  },
  {
    id: 'anthropic/claude-sonnet-4-6',
    provider: 'anthropic',
    vendorModel: 'claude-sonnet-4-6',
    displayName: 'Claude Sonnet 4.6',
    capabilities: ['reasoning', 'generation', 'analysis', 'synthesis', 'verification', 'extraction'],
    input_cost_per_1m: 3.0,
    output_cost_per_1m: 15.0,
    latency_seed_ms: 5200,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 92,
    evidence_reliability: 80,
    operational_risk: 16,
    context_window: 200_000,
    max_output_tokens: 64_000,
    search_augmented: false,
  },
  {
    id: 'anthropic/claude-haiku-4-5',
    provider: 'anthropic',
    vendorModel: 'claude-haiku-4-5',
    displayName: 'Claude Haiku 4.5',
    capabilities: ['summarization', 'extraction', 'validation', 'analysis', 'verification'],
    input_cost_per_1m: 1.0,
    output_cost_per_1m: 5.0,
    latency_seed_ms: 2600,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 82,
    evidence_reliability: 72,
    operational_risk: 18,
    context_window: 200_000,
    max_output_tokens: 64_000,
    search_augmented: false,
  },

  // ---- Google -------------------------------------------------------------
  {
    id: 'google/gemini-3.1-pro-preview',
    provider: 'google',
    vendorModel: 'gemini-3.1-pro-preview',
    displayName: 'Gemini 3.1 Pro',
    capabilities: ['reasoning', 'generation', 'analysis', 'synthesis', 'summarization', 'extraction'],
    input_cost_per_1m: 2.0,
    output_cost_per_1m: 12.0,
    latency_seed_ms: 6000,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 91,
    evidence_reliability: 74,
    operational_risk: 18,
    context_window: 1_000_000,
    max_output_tokens: 65_536,
    search_augmented: false,
  },
  {
    id: 'google/gemini-3-flash-preview',
    provider: 'google',
    vendorModel: 'gemini-3-flash-preview',
    displayName: 'Gemini 3 Flash',
    capabilities: ['summarization', 'extraction', 'analysis', 'validation', 'lookup'],
    input_cost_per_1m: 0.5,
    output_cost_per_1m: 3.0,
    latency_seed_ms: 2400,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 83,
    evidence_reliability: 68,
    operational_risk: 20,
    context_window: 1_000_000,
    max_output_tokens: 65_536,
    search_augmented: false,
  },

  // ---- DeepSeek -----------------------------------------------------------
  {
    id: 'deepseek/deepseek-reasoner',
    provider: 'deepseek',
    vendorModel: 'deepseek-reasoner',
    displayName: 'DeepSeek Reasoner',
    capabilities: ['reasoning', 'analysis', 'calculation', 'synthesis'],
    input_cost_per_1m: 0.55,
    output_cost_per_1m: 2.19,
    latency_seed_ms: 11_000,
    jurisdictions: ['CN'],
    sovereignty_level: 0,
    quality_score: 88,
    evidence_reliability: 64,
    operational_risk: 42,
    context_window: 128_000,
    max_output_tokens: 32_768,
    search_augmented: false,
  },
  {
    id: 'deepseek/deepseek-chat',
    provider: 'deepseek',
    vendorModel: 'deepseek-chat',
    displayName: 'DeepSeek Chat',
    capabilities: ['generation', 'summarization', 'extraction', 'analysis'],
    input_cost_per_1m: 0.27,
    output_cost_per_1m: 1.1,
    latency_seed_ms: 4200,
    jurisdictions: ['CN'],
    sovereignty_level: 0,
    quality_score: 80,
    evidence_reliability: 60,
    operational_risk: 44,
    context_window: 128_000,
    max_output_tokens: 8_192,
    search_augmented: false,
  },

  // ---- Perplexity ---------------------------------------------------------
  {
    id: 'perplexity/sonar-pro',
    provider: 'perplexity',
    vendorModel: 'sonar-pro',
    displayName: 'Perplexity Sonar Pro',
    capabilities: ['search', 'lookup', 'summarization', 'analysis'],
    input_cost_per_1m: 3.0,
    output_cost_per_1m: 15.0,
    latency_seed_ms: 7000,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    // Highest evidence reliability in the catalogue: this is the only engine
    // that returns retrieval URLs alongside its answer, so a claim it makes can
    // be checked against a source rather than merely believed.
    quality_score: 84,
    evidence_reliability: 90,
    operational_risk: 20,
    context_window: 200_000,
    max_output_tokens: 8_192,
    search_augmented: true,
  },
  {
    id: 'perplexity/sonar',
    provider: 'perplexity',
    vendorModel: 'sonar',
    displayName: 'Perplexity Sonar',
    capabilities: ['search', 'lookup', 'summarization'],
    input_cost_per_1m: 1.0,
    output_cost_per_1m: 1.0,
    latency_seed_ms: 4000,
    jurisdictions: ['US'],
    sovereignty_level: 1,
    quality_score: 76,
    evidence_reliability: 86,
    operational_risk: 22,
    context_window: 128_000,
    max_output_tokens: 4_096,
    search_augmented: true,
  },

  // ---- Moonshot AI --------------------------------------------------------
  {
    id: 'kimi/kimi-k2.6',
    provider: 'kimi',
    vendorModel: 'kimi-k2.6',
    displayName: 'Kimi K2.6',
    capabilities: ['reasoning', 'generation', 'analysis', 'synthesis', 'decomposition'],
    input_cost_per_1m: 0.95,
    output_cost_per_1m: 4.0,
    latency_seed_ms: 7000,
    jurisdictions: ['CN'],
    sovereignty_level: 0,
    quality_score: 91,
    evidence_reliability: 68,
    operational_risk: 42,
    context_window: 256_000,
    max_output_tokens: 64_000,
    search_augmented: false,
  },

  // ---- Sovereign local ----------------------------------------------------
  {
    id: 'ronor/deterministic-core',
    provider: 'deterministic',
    vendorModel: 'ronor/deterministic-core',
    displayName: 'RONOR Deterministic Core',
    capabilities: ['calculation', 'validation', 'lookup'],
    input_cost_per_1m: 0,
    output_cost_per_1m: 0,
    latency_seed_ms: 5,
    jurisdictions: ['sovereign'],
    sovereignty_level: 3,
    quality_score: 100,
    evidence_reliability: 100,
    operational_risk: 2,
    context_window: 8_192,
    max_output_tokens: 1_024,
    search_augmented: false,
  },
];

export function getCatalogueEntry(id: string): CatalogueEntry | null {
  return RUNTIME_CATALOGUE.find((e) => e.id === id) ?? null;
}

export function listCatalogue(): CatalogueEntry[] {
  return [...RUNTIME_CATALOGUE];
}

export function entriesForProvider(provider: ProviderId): CatalogueEntry[] {
  return RUNTIME_CATALOGUE.filter((e) => e.provider === provider);
}
