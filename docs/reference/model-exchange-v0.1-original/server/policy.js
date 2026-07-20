/**
 * RONOR Model Exchange v0.1 — Policy Engine
 * ------------------------------------------
 * Deterministic governance rules applied BEFORE routing. Policies filter the
 * registry down to the eligible set and can force ordering preferences.
 * Every rule evaluation is recorded so the Trace Ledger can show exactly
 * why each model was admitted or excluded.
 */

/**
 * @param {object} request  normalized unified request
 * @param {Array}  registry model registry entries
 * @returns {{ eligible: Array, evaluations: Array, rejected: boolean, rejectionReason: string|null }}
 */
export function applyPolicies(request, registry) {
  const evaluations = [];

  let candidates = registry.filter((m) => m.status !== "offline");

  // ---- Rule P1: Sovereign confidentiality → only sovereign engines -------
  if (request.confidentiality_level === "sovereign") {
    const before = candidates.map((m) => m.id);
    candidates = candidates.filter((m) => m.sovereignty_level >= 3);
    evaluations.push({
      rule: "P1_SOVEREIGN_ONLY",
      description:
        "confidentiality_level=sovereign → restrict to on-premises/sovereign engines (sovereignty_level >= 3)",
      excluded: before.filter((id) => !candidates.some((m) => m.id === id)),
      passed: candidates.map((m) => m.id),
    });
  }

  // ---- Rule P2: Capability match — task_type must be supported -----------
  // For exact task types (calculation/validation/lookup), generative engines
  // with 'reasoning' capability remain eligible as ESCALATION targets: if the
  // deterministic engine cannot handle the request, the router falls back.
  {
    const EXACT_TASKS = ["calculation", "validation", "lookup"];
    const before = candidates.map((m) => m.id);
    candidates = candidates.filter(
      (m) =>
        m.capabilities.includes(request.task_type) ||
        (EXACT_TASKS.includes(request.task_type) &&
          m.capabilities.includes("reasoning")),
    );
    evaluations.push({
      rule: "P2_CAPABILITY_MATCH",
      description: `task_type=${request.task_type} → engine must declare this capability (generative reasoning engines admitted as escalation fallback for exact tasks)`,
      excluded: before.filter((id) => !candidates.some((m) => m.id === id)),
      passed: candidates.map((m) => m.id),
    });
  }

  // ---- Rule P3: Deterministic-first for calculations ----------------------
  let deterministicFirst = false;
  if (request.task_type === "calculation") {
    deterministicFirst = true;
    evaluations.push({
      rule: "P3_DETERMINISTIC_FIRST",
      description:
        "task_type=calculation → deterministic engine takes routing priority over probabilistic models",
      excluded: [],
      passed: candidates.map((m) => m.id),
    });
  }

  // ---- Rule P4: Provider allow-list ---------------------------------------
  if (Array.isArray(request.allowed_providers) && request.allowed_providers.length > 0) {
    const allow = request.allowed_providers.map((p) => p.toLowerCase());
    const before = candidates.map((m) => m.id);
    candidates = candidates.filter(
      (m) =>
        allow.includes(m.provider.toLowerCase()) ||
        allow.includes(m.engine.toLowerCase()),
    );
    evaluations.push({
      rule: "P4_PROVIDER_ALLOWLIST",
      description: `allowed_providers=[${request.allowed_providers.join(", ")}] → exclude all others`,
      excluded: before.filter((id) => !candidates.some((m) => m.id === id)),
      passed: candidates.map((m) => m.id),
    });
  }

  // ---- Rule P5: Latency ceiling -------------------------------------------
  if (Number.isFinite(request.max_latency) && request.max_latency > 0) {
    const before = candidates.map((m) => m.id);
    candidates = candidates.filter((m) => m.latency_avg_ms <= request.max_latency);
    evaluations.push({
      rule: "P5_LATENCY_CEILING",
      description: `max_latency=${request.max_latency}ms → engine average latency must not exceed ceiling`,
      excluded: before.filter((id) => !candidates.some((m) => m.id === id)),
      passed: candidates.map((m) => m.id),
    });
  }

  // ---- Rule P6: Cost ceiling (estimated) ----------------------------------
  if (Number.isFinite(request.max_cost) && request.max_cost > 0) {
    const before = candidates.map((m) => m.id);
    candidates = candidates.filter(
      (m) => estimateCost(m, request) <= request.max_cost,
    );
    evaluations.push({
      rule: "P6_COST_CEILING",
      description: `max_cost=$${request.max_cost} → estimated request cost must not exceed budget`,
      excluded: before.filter((id) => !candidates.some((m) => m.id === id)),
      passed: candidates.map((m) => m.id),
    });
  }

  // ---- Rule P7: Evidence floor --------------------------------------------
  if (Number.isFinite(request.required_evidence_level) && request.required_evidence_level > 0) {
    const before = candidates.map((m) => m.id);
    candidates = candidates.filter(
      (m) => m.evidence_reliability >= request.required_evidence_level,
    );
    evaluations.push({
      rule: "P7_EVIDENCE_FLOOR",
      description: `required_evidence_level=${request.required_evidence_level} → engine evidence reliability must meet floor`,
      excluded: before.filter((id) => !candidates.some((m) => m.id === id)),
      passed: candidates.map((m) => m.id),
    });
  }

  const rejected = candidates.length === 0;
  return {
    eligible: candidates,
    evaluations,
    deterministicFirst,
    rejected,
    rejectionReason: rejected
      ? "No engine in the registry satisfies all policy constraints. Relax confidentiality_level, max_cost, max_latency, required_evidence_level or allowed_providers."
      : null,
  };
}

/** Rough per-request cost estimate used by the cost-ceiling policy. */
export function estimateCost(model, request) {
  const estInputTokens = Math.ceil((request.query?.length ?? 0) / 4) + 400; // + system prompt
  const estOutputTokens = 700;
  return (
    (estInputTokens / 1000) * model.cost_per_1k_input_tokens +
    (estOutputTokens / 1000) * model.cost_per_1k_output_tokens
  );
}
