/**
 * RONOR Model Exchange — Model Registry
 * ─────────────────────────────────────
 * Catalog of intelligence engines available to the runtime. Each entry declares
 * capabilities, economics, latency, jurisdiction, quality and sovereignty so
 * the Dynamic Router can score them per request, and so MI9 Gate can decide
 * whether an engine is admissible for a given operational context.
 *
 * sovereignty_level:
 *   3 = on-premises or sovereign infrastructure
 *   2 = EU/UK jurisdiction cloud
 *   1 = US hyperscaler cloud
 *   0 = unknown / uncertified
 *
 * Ported from RONOR Model Exchange v0.1 (18 Jul 2026 archive) and extended
 * with sovereignty-aligned engines from the Ma11AI Model Sovereignty Matrix.
 */

export type EngineType =
  | "openai"
  | "anthropic"
  | "mistral"
  | "qwen"
  | "deterministic";

export type ModelCapability =
  | "reasoning"
  | "generation"
  | "analysis"
  | "summarization"
  | "extraction"
  | "calculation"
  | "validation"
  | "lookup";

export interface ModelRegistryEntry {
  id: string;
  provider: string;
  display_name: string;
  engine: EngineType;
  capabilities: ModelCapability[];
  cost_per_1k_input_tokens: number;
  cost_per_1k_output_tokens: number;
  latency_avg_ms: number;
  jurisdictions: string[];
  quality_score: number;              // 0-100 (higher = better)
  sovereignty_level: 0 | 1 | 2 | 3;
  evidence_reliability: number;       // 0-100 (higher = more attributable)
  operational_risk: number;           // 0-100 (higher = riskier)
  status: "live" | "simulated" | "offline";
}

export const MODEL_REGISTRY: ModelRegistryEntry[] = [
  {
    id: "openai/gpt-4.1",
    provider: "OpenAI",
    display_name: "GPT-4.1",
    engine: "openai",
    capabilities: ["reasoning", "generation", "analysis", "summarization", "extraction"],
    cost_per_1k_input_tokens: 0.002,
    cost_per_1k_output_tokens: 0.008,
    latency_avg_ms: 2600,
    jurisdictions: ["US"],
    quality_score: 92,
    sovereignty_level: 1,
    evidence_reliability: 74,
    operational_risk: 18,
    status: "live",
  },
  {
    id: "anthropic/claude-sonnet-4",
    provider: "Anthropic",
    display_name: "Claude Sonnet 4",
    engine: "anthropic",
    capabilities: ["reasoning", "generation", "analysis", "summarization", "extraction"],
    cost_per_1k_input_tokens: 0.003,
    cost_per_1k_output_tokens: 0.015,
    latency_avg_ms: 3100,
    jurisdictions: ["US"],
    quality_score: 91,
    sovereignty_level: 1,
    evidence_reliability: 76,
    operational_risk: 20,
    status: "simulated",
  },
  {
    id: "mistral/mistral-large-2",
    provider: "Mistral AI",
    display_name: "Mistral Large 2",
    engine: "mistral",
    capabilities: ["reasoning", "generation", "analysis", "summarization", "extraction"],
    cost_per_1k_input_tokens: 0.002,
    cost_per_1k_output_tokens: 0.006,
    latency_avg_ms: 2400,
    jurisdictions: ["EU", "FR"],
    quality_score: 87,
    sovereignty_level: 2,
    evidence_reliability: 78,
    operational_risk: 14,
    status: "simulated",
  },
  {
    id: "qwen/qwen3-72b",
    provider: "Alibaba (open-weight)",
    display_name: "Qwen 3 72B",
    engine: "qwen",
    capabilities: ["reasoning", "generation", "analysis", "extraction"],
    cost_per_1k_input_tokens: 0.0005,
    cost_per_1k_output_tokens: 0.002,
    latency_avg_ms: 2900,
    jurisdictions: ["sovereign", "self-hosted"],
    quality_score: 84,
    sovereignty_level: 3,
    evidence_reliability: 70,
    operational_risk: 22,
    status: "simulated",
  },
  {
    id: "ronor/deterministic-core",
    provider: "RONOR (on-prem)",
    display_name: "Deterministic Core",
    engine: "deterministic",
    capabilities: ["calculation", "validation", "lookup"],
    cost_per_1k_input_tokens: 0,
    cost_per_1k_output_tokens: 0,
    latency_avg_ms: 12,
    jurisdictions: ["sovereign"],
    quality_score: 100,
    sovereignty_level: 3,
    evidence_reliability: 100,
    operational_risk: 2,
    status: "live",
  },
];

export function getModel(id: string): ModelRegistryEntry | null {
  return MODEL_REGISTRY.find((m) => m.id === id) ?? null;
}

export function listModels(): ModelRegistryEntry[] {
  return MODEL_REGISTRY;
}
