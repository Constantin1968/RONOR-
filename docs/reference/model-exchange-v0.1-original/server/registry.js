/**
 * RONOR Model Exchange v0.1 — Model Registry
 * -------------------------------------------
 * The registry is the catalog of all intelligence engines available to the
 * runtime. Each entry declares capabilities, economics, latency, jurisdiction,
 * quality and sovereignty so the Dynamic Router can score them per request.
 *
 * sovereignty_level: 3 = on-premises/sovereign, 2 = EU/UK jurisdiction cloud,
 *                    1 = US hyperscaler cloud, 0 = unknown
 */

export const MODEL_REGISTRY = [
  {
    id: "openai/gpt-4.1",
    provider: "OpenAI",
    display_name: "GPT-4.1",
    engine: "openai",
    capabilities: ["reasoning", "generation", "analysis", "summarization", "extraction"],
    cost_per_1k_input_tokens: 0.002, // USD
    cost_per_1k_output_tokens: 0.008, // USD
    latency_avg_ms: 2600,
    jurisdictions: ["US"],
    quality_score: 92, // 0-100
    sovereignty_level: 1,
    evidence_reliability: 74, // 0-100: how verifiable/attributable its outputs are
    operational_risk: 18, // 0-100: provider concentration, outage & policy-change risk
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
    status: "simulated", // no API key in this deployment — routing logic still applies
  },
  {
    id: "ronor/deterministic-core",
    provider: "RONOR (on-prem)",
    display_name: "Deterministic Core",
    engine: "deterministic",
    capabilities: ["calculation", "validation", "lookup"],
    cost_per_1k_input_tokens: 0.0,
    cost_per_1k_output_tokens: 0.0,
    latency_avg_ms: 12,
    jurisdictions: ["sovereign"],
    quality_score: 100, // within its capability envelope, it is exact
    sovereignty_level: 3,
    evidence_reliability: 100, // fully reproducible, formally verifiable
    operational_risk: 2,
    status: "live",
  },
];

export function getModel(id) {
  return MODEL_REGISTRY.find((m) => m.id === id) ?? null;
}

export function listModels() {
  return MODEL_REGISTRY;
}
