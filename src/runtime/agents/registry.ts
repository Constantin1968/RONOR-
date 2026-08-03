/**
 * RONOR Runtime — L3 · Agent Registry and Passports
 * ─────────────────────────────────────────────────
 * An Agent Passport is the machine-readable statement of what a digital worker
 * is permitted to do: which capabilities it claims, which tools it may call,
 * which confidentiality ceiling it may operate at, which engines it prefers, and
 * what it costs to run. Nothing in the runtime dispatches work to an agent
 * without one.
 *
 * The passport is not documentation. It is ENFORCED:
 *
 *   · `allowed_tools` is the allow-list the tool framework checks. An agent
 *     cannot call a tool absent from its passport, however it is prompted.
 *   · `max_confidentiality` caps the material the agent may see. The Researcher
 *     performs outbound retrieval, so it is capped below `sovereign` — a worker
 *     whose job is egress must never be handed material that forbids egress.
 *   · `preferred_models` is a HINT to the router, not an override. Governance
 *     still filters; the preference only reorders what survives. An agent that
 *     could pin its own engine would be an agent that could route around policy.
 *
 * Three workers ship operational, chosen so the set covers the full evidence
 * lifecycle rather than three variations on "ask a model":
 *
 *   Researcher       — gathers, with retrieval and search. Cheap, broad, cited.
 *   Analyst          — reasons over what was gathered. Expensive, deep, no egress.
 *   Evidence Curator — adversarially checks the analysis against its sources and
 *                      is the only worker permitted to lower a confidence score.
 *
 * Prepared by AMB.
 */

import type { RuntimeCapability } from '../router/catalogue';
import type { ConfidentialityLevel } from '../router/policy';

export type AgentId = 'researcher' | 'analyst' | 'evidence-curator';

export type AgentStatus = 'operational' | 'degraded' | 'unavailable';

export interface AgentPassport {
  agent_id: AgentId;
  name: string;
  version: string;
  /** One sentence an operator can read in a dashboard. */
  mandate: string;
  capabilities: RuntimeCapability[];
  /** The ONLY tools this agent may invoke. Enforced by the tool framework. */
  allowed_tools: string[];
  /** Ceiling on the material this agent may process. */
  max_confidentiality: ConfidentialityLevel;
  /** Router hints, in order of preference. Never an override of policy. */
  preferred_models: string[];
  /** Task type submitted to the router for this agent's own inference. */
  router_task_type: RuntimeCapability;
  /** Evidence-reliability floor imposed on this agent's engine selection. */
  required_evidence_level: number | null;
  /** Reasoning budget requested for this agent's work. */
  reasoning_effort: 'none' | 'low' | 'medium' | 'high';
  max_output_tokens: number;
  /** True when this agent may reduce a confidence figure produced elsewhere. */
  may_lower_confidence: boolean;
  status: AgentStatus;
}

const PASSPORTS: readonly AgentPassport[] = Object.freeze([
  {
    agent_id: 'researcher',
    name: 'Researcher',
    version: '1.0.0',
    mandate:
      'Gather evidence on a question from the governed corpus and, where authorised, from public sources; return findings with citations and never assert an uncited fact.',
    capabilities: ['search', 'lookup', 'extraction', 'summarization'],
    allowed_tools: ['knowledge.search', 'web.fetch', 'calc.exact'],
    // Capped BELOW sovereign deliberately: this worker performs outbound
    // retrieval, and sovereign material may not leave the boundary. A passport
    // that granted it sovereign access would be a passport that contradicts the
    // egress rule its own tools obey.
    max_confidentiality: 'restricted',
    preferred_models: [
      'perplexity/sonar-pro',
      'google/gemini-3-flash-preview',
      'openai/gpt-5-mini',
      'anthropic/claude-haiku-4-5',
    ],
    // `extraction`, NOT `search`, and the distinction is the whole point.
    //
    // This field selects the ENGINE that reasons over what the tools returned. It
    // does not describe what the worker does. The first version set it to
    // 'search', which conflated "this worker performs retrieval" with "this
    // worker needs a model that performs retrieval" — and because only Perplexity
    // declares the `search` capability, P2_CAPABILITY_MATCH correctly emptied the
    // candidate set and the Researcher failed on EVERY mission whenever no
    // Perplexity key was present.
    //
    // The retrieval is done by knowledge.search and web.fetch before the engine is
    // ever called. What the engine must then do is pull attributable claims out of
    // that returned material, which is extraction.
    //
    // The fix belongs here and not in P2. Widening the capability rule so that any
    // model satisfies `search` would let a request that genuinely needs live
    // retrieval route silently to a model that cannot retrieve — a wrong answer
    // presented confidently, which is worse than the clean refusal P2 gave.
    router_task_type: 'extraction',
    // A gathering worker is judged on attributability, not eloquence.
    required_evidence_level: 60,
    reasoning_effort: 'low',
    max_output_tokens: 4096,
    may_lower_confidence: false,
    status: 'operational',
  },
  {
    agent_id: 'analyst',
    name: 'Analyst',
    version: '1.0.0',
    mandate:
      'Reason over gathered evidence to produce a structured assessment: what the evidence supports, what it does not, and what remains unknown.',
    capabilities: ['analysis', 'reasoning', 'synthesis'],
    // No web.fetch. The Analyst reasons over what the Researcher gathered; giving
    // it independent egress would make the provenance of its inputs untraceable.
    allowed_tools: ['calc.exact', 'knowledge.search'],
    max_confidentiality: 'sovereign',
    preferred_models: [
      'anthropic/claude-opus-4-7',
      'openai/gpt-5.5',
      'anthropic/claude-sonnet-4-6',
      'openai/gpt-5',
      'google/gemini-3.1-pro-preview',
    ],
    router_task_type: 'analysis',
    required_evidence_level: null,
    reasoning_effort: 'high',
    max_output_tokens: 8192,
    may_lower_confidence: false,
    status: 'operational',
  },
  {
    agent_id: 'evidence-curator',
    name: 'Evidence Curator',
    version: '1.0.0',
    mandate:
      'Adversarially verify each claim against its cited source, mark unsupported claims, and assign a defensible confidence score to the synthesis.',
    capabilities: ['verification', 'validation', 'extraction'],
    allowed_tools: ['knowledge.search', 'web.fetch', 'calc.exact'],
    max_confidentiality: 'restricted',
    // Verification is routed to high-evidence engines first; the Curator's value
    // is entirely in the reliability of its checking.
    preferred_models: [
      'anthropic/claude-sonnet-4-6',
      'perplexity/sonar-pro',
      'anthropic/claude-haiku-4-5',
      'openai/gpt-5-mini',
    ],
    router_task_type: 'verification',
    required_evidence_level: 70,
    reasoning_effort: 'medium',
    max_output_tokens: 4096,
    // The only worker permitted to lower a confidence figure. Concentrating that
    // authority in the adversarial reviewer is the point: a worker that can raise
    // its own confidence has no incentive to find its own errors.
    may_lower_confidence: true,
    status: 'operational',
  },
]);

/**
 * Deep-copy a passport.
 *
 * A shallow spread shares the `allowed_tools`, `capabilities` and
 * `preferred_models` ARRAYS with the frozen registry entry. Freezing the outer
 * object does not freeze them, so a caller that pushed onto `allowed_tools` would
 * silently grant that tool to every subsequent request in the process. This is
 * the difference between a permission model and a suggestion.
 */
function clonePassport(p: AgentPassport): AgentPassport {
  return {
    ...p,
    capabilities: [...p.capabilities],
    allowed_tools: [...p.allowed_tools],
    preferred_models: [...p.preferred_models],
  };
}

export function agentPassports(): AgentPassport[] {
  return PASSPORTS.map(clonePassport);
}

export function getPassport(agentId: string): AgentPassport | null {
  const found = PASSPORTS.find((p) => p.agent_id === agentId);
  return found ? clonePassport(found) : null;
}

/**
 * May this agent process material at this confidentiality level?
 *
 * Compared by ordinal rank rather than string equality, so a new level inserted
 * into the scale does not silently widen every existing passport.
 */
export function passportPermits(
  passport: AgentPassport,
  confidentiality: ConfidentialityLevel,
): boolean {
  return CONFIDENTIALITY_RANK[confidentiality] <= CONFIDENTIALITY_RANK[passport.max_confidentiality];
}

export const CONFIDENTIALITY_RANK: Readonly<Record<ConfidentialityLevel, number>> = Object.freeze({
  public: 0,
  internal: 1,
  restricted: 2,
  sovereign: 3,
});

/**
 * Agents eligible to act on material at this confidentiality level.
 *
 * Used by the coordinator so that a sovereign mission is planned with the
 * workers that may actually run it, rather than planned optimistically and then
 * failing worker by worker.
 */
export function agentsFor(confidentiality: ConfidentialityLevel): AgentPassport[] {
  return agentPassports().filter((p) => passportPermits(p, confidentiality));
}
