/**
 * MI9 Gate — Machine Intelligence Governance Gate
 *
 * The MI9 Gate sits between frontier-model reasoning and any consequential
 * action in the physical world. It answers a single question:
 *
 *   "Given this decision, this context, and this policy, should the system:
 *      allow autonomously,
 *      allow with human co-sign,
 *      escalate to a human operator,
 *      or block outright?"
 *
 * Named after the nine gates of governance formally required by an accountable
 * autonomy loop:
 *   1. Sovereignty        — data residency, jurisdiction
 *   2. Risk tier          — EU AI Act risk classification
 *   3. Reversibility      — can the action be undone?
 *   4. Impact magnitude   — €/MWh/lives at stake
 *   5. Confidence         — model confidence vs. required floor
 *   6. Evidence           — is the reasoning grounded in verifiable data?
 *   7. Policy compliance  — declarative rule set (YAML)
 *   8. Rate limits        — how many autonomous decisions per window?
 *   9. Fallback available — is a deterministic fallback ready if we block?
 *
 * Every gate produces an auditable finding. The overall verdict is the
 * strictest verdict across gates.
 */

import { createLogger } from '../utils/logger';
import * as yaml from 'js-yaml';
import * as fs from 'fs';
import * as path from 'path';

const logger = createLogger('MI9-Gate');

// ============================================================
// Types
// ============================================================

export type Verdict = 'allow' | 'allow-with-cosign' | 'escalate' | 'block';

export interface DecisionContext {
  decisionId: string;
  domain: string;                   // e.g. "energy.bess.dispatch"
  action: string;                   // e.g. "sell 8 MWh at €140/MWh on OPCOM DAM"
  proposedBy: string;               // e.g. "gpt-5.6"
  confidence: number;               // 0..1
  reversible: boolean;
  impactMagnitude: {
    unit: 'EUR' | 'MWh' | 'MW' | 'other';
    value: number;
  };
  sovereignty: {
    dataResidency: 'eu' | 'uk' | 'us' | 'any';
    subjectJurisdiction: 'RO' | 'EU' | 'UK' | 'US' | 'OTHER';
  };
  evidence: {
    sourceCount: number;
    lastRefreshMs: number;          // age of freshest data in ms
    consensusReached: boolean;
  };
  operator: {
    userId?: string;
    role: 'operator' | 'dispatcher' | 'auditor' | 'external';
  };
  metadata?: Record<string, unknown>;
}

export interface GateFinding {
  gateNumber: number;
  gateName: string;
  verdict: Verdict;
  reason: string;
  detail?: Record<string, unknown>;
}

export interface MI9Result {
  decisionId: string;
  verdict: Verdict;
  findings: GateFinding[];
  policyVersion: string;
  evaluatedAt: string;               // ISO
  humanCoSignRequired: boolean;
  escalationTarget?: string;
  blockReason?: string;
}

// ============================================================
// Policy schema
// ============================================================

interface Policy {
  version: string;
  description: string;
  gates: {
    sovereignty: {
      allowed_residencies: string[];
      required_for_jurisdictions: Record<string, string[]>;
    };
    risk_tier: {
      domain_tiers: Record<string, 'minimal' | 'limited' | 'high' | 'unacceptable'>;
      cosign_required_at_tier: string[];
      escalation_required_at_tier: string[];
    };
    reversibility: {
      irreversible_action_verdict: Verdict;
    };
    impact: {
      cosign_thresholds: { unit: string; value: number }[];
      escalation_thresholds: { unit: string; value: number }[];
      block_thresholds: { unit: string; value: number }[];
    };
    confidence: {
      minimum_autonomous: number;
      minimum_cosign: number;
    };
    evidence: {
      min_source_count: number;
      max_data_age_ms: number;
      consensus_required_for_domains: string[];
    };
    policy_compliance: {
      domain_specific_rules: Record<string, string[]>;
    };
    rate_limits: {
      autonomous_per_hour: number;
      cosign_per_hour: number;
    };
    fallback: {
      required_for_domains: string[];
    };
  };
}

let cachedPolicy: Policy | null = null;
let cachedPolicyVersion: string = 'unloaded';

export function loadPolicy(policyPath?: string): Policy {
  const resolved =
    policyPath ||
    process.env.MI9_POLICY_PATH ||
    path.resolve(__dirname, 'policies.yaml');
  const raw = fs.readFileSync(resolved, 'utf8');
  const policy = yaml.load(raw) as Policy;
  cachedPolicy = policy;
  cachedPolicyVersion = policy.version;
  logger.info(`Policy loaded: ${policy.version} from ${resolved}`);
  return policy;
}

function policy(): Policy {
  if (!cachedPolicy) return loadPolicy();
  return cachedPolicy;
}

// ============================================================
// Rate limiting (in-memory sliding window)
// ============================================================

const decisionsThisHour: { ts: number; verdict: Verdict }[] = [];

function pruneOldDecisions(): void {
  const cutoff = Date.now() - 60 * 60 * 1000;
  while (decisionsThisHour.length && decisionsThisHour[0].ts < cutoff) {
    decisionsThisHour.shift();
  }
}

function autonomousCount(): number {
  pruneOldDecisions();
  return decisionsThisHour.filter((d) => d.verdict === 'allow').length;
}

function cosignCount(): number {
  pruneOldDecisions();
  return decisionsThisHour.filter((d) => d.verdict === 'allow-with-cosign').length;
}

// ============================================================
// Individual gates
// ============================================================

function gateSovereignty(ctx: DecisionContext, p: Policy): GateFinding {
  const allowed = p.gates.sovereignty.allowed_residencies;
  const required =
    p.gates.sovereignty.required_for_jurisdictions[ctx.sovereignty.subjectJurisdiction] || [];

  if (!allowed.includes(ctx.sovereignty.dataResidency)) {
    return {
      gateNumber: 1,
      gateName: 'sovereignty',
      verdict: 'block',
      reason: `Data residency '${ctx.sovereignty.dataResidency}' not in allowed list.`,
      detail: { allowed, actual: ctx.sovereignty.dataResidency },
    };
  }
  if (required.length && !required.includes(ctx.sovereignty.dataResidency)) {
    return {
      gateNumber: 1,
      gateName: 'sovereignty',
      verdict: 'block',
      reason: `Jurisdiction '${ctx.sovereignty.subjectJurisdiction}' requires one of ${required.join(', ')}.`,
      detail: { required, actual: ctx.sovereignty.dataResidency },
    };
  }
  return {
    gateNumber: 1,
    gateName: 'sovereignty',
    verdict: 'allow',
    reason: `Data residency '${ctx.sovereignty.dataResidency}' acceptable for jurisdiction '${ctx.sovereignty.subjectJurisdiction}'.`,
  };
}

function gateRiskTier(ctx: DecisionContext, p: Policy): GateFinding {
  const tier = p.gates.risk_tier.domain_tiers[ctx.domain] || 'limited';
  if (tier === 'unacceptable') {
    return {
      gateNumber: 2,
      gateName: 'risk-tier',
      verdict: 'block',
      reason: `Domain '${ctx.domain}' classified as unacceptable-risk under EU AI Act.`,
      detail: { tier },
    };
  }
  if (p.gates.risk_tier.escalation_required_at_tier.includes(tier)) {
    return {
      gateNumber: 2,
      gateName: 'risk-tier',
      verdict: 'escalate',
      reason: `Domain '${ctx.domain}' at tier '${tier}' requires human escalation.`,
      detail: { tier },
    };
  }
  if (p.gates.risk_tier.cosign_required_at_tier.includes(tier)) {
    return {
      gateNumber: 2,
      gateName: 'risk-tier',
      verdict: 'allow-with-cosign',
      reason: `Domain '${ctx.domain}' at tier '${tier}' requires human co-sign.`,
      detail: { tier },
    };
  }
  return {
    gateNumber: 2,
    gateName: 'risk-tier',
    verdict: 'allow',
    reason: `Domain '${ctx.domain}' at tier '${tier}' autonomously actionable.`,
    detail: { tier },
  };
}

function gateReversibility(ctx: DecisionContext, p: Policy): GateFinding {
  if (!ctx.reversible) {
    return {
      gateNumber: 3,
      gateName: 'reversibility',
      verdict: p.gates.reversibility.irreversible_action_verdict,
      reason: 'Action is irreversible.',
    };
  }
  return {
    gateNumber: 3,
    gateName: 'reversibility',
    verdict: 'allow',
    reason: 'Action is reversible.',
  };
}

function gateImpact(ctx: DecisionContext, p: Policy): GateFinding {
  const { unit, value } = ctx.impactMagnitude;
  const abs = Math.abs(value);

  for (const t of p.gates.impact.block_thresholds) {
    if (t.unit === unit && abs >= t.value) {
      return {
        gateNumber: 4,
        gateName: 'impact-magnitude',
        verdict: 'block',
        reason: `Impact ${abs} ${unit} exceeds block threshold ${t.value} ${unit}.`,
        detail: { threshold: t.value, actual: abs },
      };
    }
  }
  for (const t of p.gates.impact.escalation_thresholds) {
    if (t.unit === unit && abs >= t.value) {
      return {
        gateNumber: 4,
        gateName: 'impact-magnitude',
        verdict: 'escalate',
        reason: `Impact ${abs} ${unit} exceeds escalation threshold ${t.value} ${unit}.`,
        detail: { threshold: t.value, actual: abs },
      };
    }
  }
  for (const t of p.gates.impact.cosign_thresholds) {
    if (t.unit === unit && abs >= t.value) {
      return {
        gateNumber: 4,
        gateName: 'impact-magnitude',
        verdict: 'allow-with-cosign',
        reason: `Impact ${abs} ${unit} exceeds co-sign threshold ${t.value} ${unit}.`,
        detail: { threshold: t.value, actual: abs },
      };
    }
  }
  return {
    gateNumber: 4,
    gateName: 'impact-magnitude',
    verdict: 'allow',
    reason: `Impact ${abs} ${unit} below all thresholds.`,
    detail: { actual: abs },
  };
}

function gateConfidence(ctx: DecisionContext, p: Policy): GateFinding {
  if (ctx.confidence < p.gates.confidence.minimum_cosign) {
    return {
      gateNumber: 5,
      gateName: 'confidence',
      verdict: 'escalate',
      reason: `Confidence ${ctx.confidence.toFixed(2)} below minimum ${p.gates.confidence.minimum_cosign}.`,
      detail: { minimum: p.gates.confidence.minimum_cosign, actual: ctx.confidence },
    };
  }
  if (ctx.confidence < p.gates.confidence.minimum_autonomous) {
    return {
      gateNumber: 5,
      gateName: 'confidence',
      verdict: 'allow-with-cosign',
      reason: `Confidence ${ctx.confidence.toFixed(2)} below autonomous floor ${p.gates.confidence.minimum_autonomous}.`,
      detail: { minimum: p.gates.confidence.minimum_autonomous, actual: ctx.confidence },
    };
  }
  return {
    gateNumber: 5,
    gateName: 'confidence',
    verdict: 'allow',
    reason: `Confidence ${ctx.confidence.toFixed(2)} above autonomous floor.`,
  };
}

function gateEvidence(ctx: DecisionContext, p: Policy): GateFinding {
  if (ctx.evidence.sourceCount < p.gates.evidence.min_source_count) {
    return {
      gateNumber: 6,
      gateName: 'evidence',
      verdict: 'escalate',
      reason: `Only ${ctx.evidence.sourceCount} sources; minimum ${p.gates.evidence.min_source_count} required.`,
    };
  }
  if (ctx.evidence.lastRefreshMs > p.gates.evidence.max_data_age_ms) {
    return {
      gateNumber: 6,
      gateName: 'evidence',
      verdict: 'allow-with-cosign',
      reason: `Data age ${Math.round(ctx.evidence.lastRefreshMs / 1000)}s exceeds fresh threshold ${Math.round(p.gates.evidence.max_data_age_ms / 1000)}s.`,
    };
  }
  if (
    p.gates.evidence.consensus_required_for_domains.includes(ctx.domain) &&
    !ctx.evidence.consensusReached
  ) {
    return {
      gateNumber: 6,
      gateName: 'evidence',
      verdict: 'escalate',
      reason: `Consensus required for domain '${ctx.domain}' but not reached.`,
    };
  }
  return {
    gateNumber: 6,
    gateName: 'evidence',
    verdict: 'allow',
    reason: `${ctx.evidence.sourceCount} sources; data ${Math.round(ctx.evidence.lastRefreshMs / 1000)}s old.`,
  };
}

function gatePolicyCompliance(ctx: DecisionContext, p: Policy): GateFinding {
  const rules = p.gates.policy_compliance.domain_specific_rules[ctx.domain] || [];
  return {
    gateNumber: 7,
    gateName: 'policy-compliance',
    verdict: 'allow',
    reason: rules.length
      ? `${rules.length} domain-specific rules attached to audit chain.`
      : 'No domain-specific rules apply.',
    detail: { rules },
  };
}

function gateRateLimits(_ctx: DecisionContext, p: Policy): GateFinding {
  const auto = autonomousCount();
  const cosign = cosignCount();
  if (auto >= p.gates.rate_limits.autonomous_per_hour) {
    return {
      gateNumber: 8,
      gateName: 'rate-limits',
      verdict: 'allow-with-cosign',
      reason: `Autonomous rate limit reached (${auto}/${p.gates.rate_limits.autonomous_per_hour} per hour).`,
    };
  }
  if (cosign >= p.gates.rate_limits.cosign_per_hour) {
    return {
      gateNumber: 8,
      gateName: 'rate-limits',
      verdict: 'escalate',
      reason: `Co-sign rate limit reached (${cosign}/${p.gates.rate_limits.cosign_per_hour} per hour).`,
    };
  }
  return {
    gateNumber: 8,
    gateName: 'rate-limits',
    verdict: 'allow',
    reason: `Within rate limits (autonomous ${auto}/${p.gates.rate_limits.autonomous_per_hour}, cosign ${cosign}/${p.gates.rate_limits.cosign_per_hour}).`,
  };
}

function gateFallback(ctx: DecisionContext, p: Policy): GateFinding {
  const domainNeedsFallback = p.gates.fallback.required_for_domains.includes(ctx.domain);
  if (domainNeedsFallback && !ctx.metadata?.fallbackAvailable) {
    return {
      gateNumber: 9,
      gateName: 'fallback',
      verdict: 'block',
      reason: `Domain '${ctx.domain}' requires a deterministic fallback plan; none declared.`,
    };
  }
  return {
    gateNumber: 9,
    gateName: 'fallback',
    verdict: 'allow',
    reason: domainNeedsFallback
      ? 'Deterministic fallback declared.'
      : 'Fallback not required for this domain.',
  };
}

// ============================================================
// Aggregation — strictest verdict wins
// ============================================================

const VERDICT_ORDER: Record<Verdict, number> = {
  allow: 0,
  'allow-with-cosign': 1,
  escalate: 2,
  block: 3,
};

function strictest(a: Verdict, b: Verdict): Verdict {
  return VERDICT_ORDER[a] >= VERDICT_ORDER[b] ? a : b;
}

// ============================================================
// Main entrypoint
// ============================================================

export function evaluate(ctx: DecisionContext): MI9Result {
  const p = policy();
  const findings: GateFinding[] = [
    gateSovereignty(ctx, p),
    gateRiskTier(ctx, p),
    gateReversibility(ctx, p),
    gateImpact(ctx, p),
    gateConfidence(ctx, p),
    gateEvidence(ctx, p),
    gatePolicyCompliance(ctx, p),
    gateRateLimits(ctx, p),
    gateFallback(ctx, p),
  ];

  let verdict: Verdict = 'allow';
  for (const f of findings) verdict = strictest(verdict, f.verdict);

  // Record for rate-limit accounting
  if (verdict === 'allow' || verdict === 'allow-with-cosign') {
    decisionsThisHour.push({ ts: Date.now(), verdict });
  }

  const result: MI9Result = {
    decisionId: ctx.decisionId,
    verdict,
    findings,
    policyVersion: cachedPolicyVersion,
    evaluatedAt: new Date().toISOString(),
    humanCoSignRequired: verdict === 'allow-with-cosign' || verdict === 'escalate',
    escalationTarget: verdict === 'escalate' ? 'human-dispatcher' : undefined,
    blockReason:
      verdict === 'block'
        ? findings.find((f) => f.verdict === 'block')?.reason
        : undefined,
  };

  logger.info(
    `Decision ${ctx.decisionId} → ${verdict} (${findings.filter((f) => f.verdict !== 'allow').length} non-allow findings)`
  );

  return result;
}

export function getPolicyVersion(): string {
  return cachedPolicyVersion;
}

export function resetRateLimits(): void {
  decisionsThisHour.length = 0;
}
