/**
 * RONOR Runtime — L1 · Policy Filter P1–P8
 * ────────────────────────────────────────
 * Eight deterministic rules applied BEFORE any scoring. Filtering first and
 * ranking second is the whole point: a cheap, fast, high-quality engine that
 * violates a data-residency constraint must never appear at the top of a table
 * where a hurried operator might approve it. Governance is a gate, not a
 * tie-breaker.
 *
 * What is new in Runtime Active, relative to the Core Active filter, is that
 * every rule now consults REAL PROVIDER METADATA rather than a static registry
 * row. In particular P0 admits only engines whose adapter reports a usable
 * credential, so "eligible" means "would actually execute if selected". An
 * eligible set containing an engine that will certainly fail on credentials is
 * a set that lies to the router and, through it, to the audit chain.
 *
 * Every rule records what it excluded AND what survived. A filter that logs only
 * its verdict cannot be audited, because the reviewer cannot reconstruct the
 * decision without re-running the code against a registry that may since have
 * changed.
 *
 * Prepared by AMB.
 */

import { invocableProviders } from '../providers/registry';
import type { CatalogueEntry, RuntimeCapability } from './catalogue';

export type ConfidentialityLevel = 'public' | 'internal' | 'restricted' | 'sovereign';
export type JurisdictionPin = 'EU' | 'sovereign' | 'US' | 'any';

export interface RuntimeRequestConstraints {
  task_type: RuntimeCapability;
  confidentiality_level: ConfidentialityLevel;
  allowed_providers?: string[];
  denied_providers?: string[];
  max_latency_ms?: number;
  max_cost_usd?: number;
  required_evidence_level?: number;
  jurisdiction_pin?: JurisdictionPin;
  /** Force live retrieval; excludes engines that cannot search. */
  require_search?: boolean;
  /** Pin a specific catalogue id. Recorded as an operator override. */
  pin_model?: string;
}

export interface PolicyEvaluation {
  rule: string;
  description: string;
  excluded: string[];
  passed: string[];
}

export interface RuntimePolicyResult {
  eligible: CatalogueEntry[];
  evaluations: PolicyEvaluation[];
  deterministicFirst: boolean;
  rejected: boolean;
  rejectionReason: string | null;
}

/** Tasks for which an exact engine is the correct first choice. */
const EXACT_TASKS: RuntimeCapability[] = ['calculation', 'validation', 'lookup'];

/** EU member-state codes recognised for residency purposes. */
const EU_JURISDICTIONS = new Set([
  'EU', 'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR',
  'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI',
  'ES', 'SE',
]);

/**
 * Estimate the USD cost of one request against one engine.
 *
 * A deliberate over-estimate. The input allowance covers the system prompt and
 * any retrieved context the caller has not yet assembled, and the output
 * allowance assumes a full-length answer. A cost ceiling that admitted engines
 * on an optimistic estimate would be a budget control that fails exactly when
 * the request turns out to be expensive.
 */
export function estimateRequestCost(
  entry: CatalogueEntry,
  promptChars: number,
  expectedOutputTokens = 900,
): number {
  const inputTokens = Math.ceil(promptChars / 4) + 600;
  const cost =
    (inputTokens / 1_000_000) * entry.input_cost_per_1m +
    (expectedOutputTokens / 1_000_000) * entry.output_cost_per_1m;
  return +cost.toFixed(8);
}

export function applyRuntimePolicies(
  constraints: RuntimeRequestConstraints,
  promptChars: number,
  catalogue: CatalogueEntry[],
  env: NodeJS.ProcessEnv = process.env,
): RuntimePolicyResult {
  const evaluations: PolicyEvaluation[] = [];
  let candidates = [...catalogue];

  const record = (rule: string, description: string, before: string[]) => {
    evaluations.push({
      rule,
      description,
      excluded: before.filter((id) => !candidates.some((c) => c.id === id)),
      passed: candidates.map((c) => c.id),
    });
  };

  // ---- P0: Credential reality ---------------------------------------------
  // Runs first and unconditionally. Every later rule reasons about engines that
  // could actually execute, so the router never ranks a certain failure.
  {
    const before = candidates.map((c) => c.id);
    const live = invocableProviders(env);
    candidates = candidates.filter((c) => live.has(c.provider));
    record(
      'P0_CREDENTIAL_PRESENT',
      'engine adapter must report a usable credential (native key, gateway route, or local execution); providers in key-absent state are excluded rather than simulated',
      before,
    );
  }

  // ---- P1: Sovereign confidentiality --------------------------------------
  if (constraints.confidentiality_level === 'sovereign') {
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter((c) => c.sovereignty_level >= 3);
    record(
      'P1_SOVEREIGN_ONLY',
      'confidentiality_level=sovereign → only engines executing on sovereign or on-premises infrastructure (sovereignty_level >= 3) may see the payload',
      before,
    );
  } else if (constraints.confidentiality_level === 'restricted') {
    const before = candidates.map((c) => c.id);
    // Restricted material may traverse a certified cloud but not an
    // uncertified jurisdiction. sovereignty_level 0 means "we cannot attest
    // where this ran", which is not a standard restricted data can be held to.
    candidates = candidates.filter((c) => c.sovereignty_level >= 1);
    record(
      'P1_RESTRICTED_ATTESTABLE',
      'confidentiality_level=restricted → exclude engines whose execution jurisdiction cannot be attested (sovereignty_level 0)',
      before,
    );
  }

  // ---- P2: Capability match -----------------------------------------------
  {
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter(
      (c) =>
        c.capabilities.includes(constraints.task_type) ||
        // Reasoning engines are admitted as escalation for exact tasks, because
        // the deterministic core legitimately declines queries it cannot parse
        // and something must be able to answer.
        (EXACT_TASKS.includes(constraints.task_type) && c.capabilities.includes('reasoning')),
    );
    record(
      'P2_CAPABILITY_MATCH',
      `task_type=${constraints.task_type} → engine must declare the capability; reasoning engines admitted as escalation for exact tasks`,
      before,
    );
  }

  // ---- P3: Deterministic-first --------------------------------------------
  let deterministicFirst = false;
  if (constraints.task_type === 'calculation') {
    deterministicFirst = true;
    evaluations.push({
      rule: 'P3_DETERMINISTIC_FIRST',
      description:
        'task_type=calculation → the exact engine takes routing priority over any probabilistic engine regardless of score',
      excluded: [],
      passed: candidates.map((c) => c.id),
    });
  }

  // ---- P4: Provider allow/deny list ---------------------------------------
  if (constraints.allowed_providers?.length) {
    const allow = new Set(constraints.allowed_providers.map((p) => p.toLowerCase()));
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter(
      (c) => allow.has(c.provider) || allow.has(c.displayName.toLowerCase()) || allow.has(c.id),
    );
    record(
      'P4_PROVIDER_ALLOWLIST',
      `allowed_providers=[${constraints.allowed_providers.join(', ')}] → exclude every other provider`,
      before,
    );
  }
  if (constraints.denied_providers?.length) {
    const deny = new Set(constraints.denied_providers.map((p) => p.toLowerCase()));
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter(
      (c) => !deny.has(c.provider) && !deny.has(c.displayName.toLowerCase()) && !deny.has(c.id),
    );
    record(
      'P4_PROVIDER_DENYLIST',
      `denied_providers=[${constraints.denied_providers.join(', ')}] → exclude the named providers`,
      before,
    );
  }

  // ---- P5: Latency ceiling ------------------------------------------------
  if (typeof constraints.max_latency_ms === 'number' && constraints.max_latency_ms > 0) {
    const before = candidates.map((c) => c.id);
    const ceiling = constraints.max_latency_ms;
    // Compared against the CALIBRATED latency, not the seed, so a provider that
    // has degraded in production is excluded by the same rule that admitted it
    // when it was fast. Imported lazily to keep this module free of a cycle.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { telemetryFor } = require('./calibrator') as typeof import('./calibrator');
    candidates = candidates.filter((c) => telemetryFor(c.id).latencyMs <= ceiling);
    record(
      'P5_LATENCY_CEILING',
      `max_latency_ms=${ceiling} → observed p50 latency (or catalogue seed while warming up) must not exceed the ceiling`,
      before,
    );
  }

  // ---- P6: Cost ceiling ---------------------------------------------------
  if (typeof constraints.max_cost_usd === 'number' && constraints.max_cost_usd > 0) {
    const before = candidates.map((c) => c.id);
    const ceiling = constraints.max_cost_usd;
    candidates = candidates.filter((c) => estimateRequestCost(c, promptChars) <= ceiling);
    record(
      'P6_COST_CEILING',
      `max_cost_usd=${ceiling} → conservatively estimated request cost must not exceed the budget`,
      before,
    );
  }

  // ---- P7: Evidence floor -------------------------------------------------
  if (
    typeof constraints.required_evidence_level === 'number' &&
    constraints.required_evidence_level > 0
  ) {
    const before = candidates.map((c) => c.id);
    const floor = constraints.required_evidence_level;
    candidates = candidates.filter((c) => c.evidence_reliability >= floor);
    record(
      'P7_EVIDENCE_FLOOR',
      `required_evidence_level=${floor} → engine evidence reliability must meet the floor`,
      before,
    );
  }

  // ---- P8: Jurisdiction pin -----------------------------------------------
  const pin = constraints.jurisdiction_pin;
  if (pin === 'EU') {
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter(
      (c) => c.jurisdictions.includes('sovereign') || c.jurisdictions.some((j) => EU_JURISDICTIONS.has(j)),
    );
    record(
      'P8_JURISDICTION_EU',
      'jurisdiction_pin=EU → inference must execute in an EU member state or on sovereign infrastructure',
      before,
    );
  } else if (pin === 'sovereign') {
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter((c) => c.jurisdictions.includes('sovereign'));
    record(
      'P8_JURISDICTION_SOVEREIGN',
      'jurisdiction_pin=sovereign → inference must execute on sovereign infrastructure',
      before,
    );
  } else if (pin === 'US') {
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter(
      (c) => c.jurisdictions.includes('US') || c.jurisdictions.includes('sovereign'),
    );
    record(
      'P8_JURISDICTION_US',
      'jurisdiction_pin=US → inference must execute in the United States or on sovereign infrastructure',
      before,
    );
  }

  // ---- Search requirement (subordinate to P2) -----------------------------
  if (constraints.require_search) {
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter((c) => c.search_augmented);
    record(
      'P2S_SEARCH_REQUIRED',
      'require_search=true → only engines performing live retrieval as part of generation are admissible',
      before,
    );
  }

  // ---- Operator pin -------------------------------------------------------
  // Applied last so an operator override cannot smuggle an engine past a
  // governance rule. Pinning selects WITHIN the eligible set; it does not
  // enlarge it. An operator who pins a policy-excluded engine receives an
  // explicit rejection rather than a quiet substitution.
  if (constraints.pin_model) {
    const before = candidates.map((c) => c.id);
    candidates = candidates.filter((c) => c.id === constraints.pin_model);
    record(
      'P9_OPERATOR_PIN',
      `pin_model=${constraints.pin_model} → operator override applied WITHIN the policy-eligible set; a pin cannot admit an engine that policy excluded`,
      before,
    );
  }

  const rejected = candidates.length === 0;
  return {
    eligible: candidates,
    evaluations,
    deterministicFirst,
    rejected,
    rejectionReason: rejected
      ? buildRejectionReason(evaluations)
      : null,
  };
}

/**
 * Name the rule that emptied the set.
 *
 * "No engine satisfies all constraints" is technically true and operationally
 * useless. The last rule to exclude anything is the one an operator must relax,
 * so it is named explicitly.
 */
function buildRejectionReason(evaluations: PolicyEvaluation[]): string {
  const emptying = [...evaluations].reverse().find((e) => e.passed.length === 0 && e.excluded.length > 0);
  if (emptying) {
    return `No eligible engine after ${emptying.rule}: ${emptying.description}. Excluded at this step: ${emptying.excluded.join(', ')}.`;
  }
  return 'No engine in the runtime catalogue satisfies the supplied constraints. Relax confidentiality_level, jurisdiction_pin, cost or latency ceilings, evidence floor, or provider lists.';
}
