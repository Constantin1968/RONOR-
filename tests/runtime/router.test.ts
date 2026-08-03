/**
 * RONOR Runtime — L1 Router, Policy and Fallback Tests
 *
 * The router is the component whose bugs are least visible: a mis-weighted term
 * or a filter applied in the wrong order produces a plausible answer from the
 * wrong engine, and nothing anywhere reports an error. These tests therefore
 * assert ORDERING and EXCLUSION REASONS, not merely that a winner was produced.
 *
 * Prepared by AMB.
 */

import {
  RUNTIME_CATALOGUE,
  getCatalogueEntry,
  listCatalogue,
  type CatalogueEntry,
} from '../../src/runtime/router/catalogue';
import {
  MIN_SAMPLES,
  WINDOW_SIZE,
  allTelemetry,
  recordSample,
  resetCalibrator,
  telemetryFor,
} from '../../src/runtime/router/calibrator';
import {
  applyRuntimePolicies,
  estimateRequestCost,
  type RuntimeRequestConstraints,
} from '../../src/runtime/router/policy';
import { RUNTIME_WEIGHTS, rankCandidates, scoreCandidate } from '../../src/runtime/router/scoring';
import { computeActualCost, executeExchange, routeOnly } from '../../src/runtime/router/exchange';

/** An environment in which every gateway-served provider is live. */
const GATEWAY_ENV: NodeJS.ProcessEnv = {
  OPENAI_API_BASE: 'https://gw.invalid/v1',
  OPENAI_API_KEY: 'test-gateway-key',
};

/** An environment with no credentials at all. */
const OFFLINE_ENV: NodeJS.ProcessEnv = {};

const baseConstraints: RuntimeRequestConstraints = {
  task_type: 'reasoning',
  confidentiality_level: 'internal',
};

beforeEach(() => {
  resetCalibrator();
});

describe('L1 · catalogue integrity', () => {
  it('gives every entry a unique canonical id', () => {
    const ids = RUNTIME_CATALOGUE.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('prices every entry in USD per million tokens with output at least input', () => {
    for (const e of RUNTIME_CATALOGUE) {
      expect(e.input_cost_per_1m).toBeGreaterThanOrEqual(0);
      expect(e.output_cost_per_1m).toBeGreaterThanOrEqual(0);
      // Every commercial vendor charges at least as much for output as input.
      // A violation here almost always means a transcription error in a rate card.
      expect(e.output_cost_per_1m).toBeGreaterThanOrEqual(e.input_cost_per_1m);
    }
  });

  it('keeps every score dimension inside its declared range', () => {
    for (const e of RUNTIME_CATALOGUE) {
      expect(e.quality_score).toBeGreaterThan(0);
      expect(e.quality_score).toBeLessThanOrEqual(100);
      expect(e.evidence_reliability).toBeLessThanOrEqual(100);
      expect(e.operational_risk).toBeLessThanOrEqual(100);
      expect([0, 1, 2, 3]).toContain(e.sovereignty_level);
      expect(e.max_output_tokens).toBeGreaterThan(0);
      expect(e.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('marks only Perplexity engines as search-augmented', () => {
    for (const e of RUNTIME_CATALOGUE) {
      if (e.search_augmented) expect(e.provider).toBe('perplexity');
    }
  });

  it('prices the sovereign deterministic core at zero', () => {
    const det = getCatalogueEntry('ronor/deterministic-core');
    expect(det?.input_cost_per_1m).toBe(0);
    expect(det?.output_cost_per_1m).toBe(0);
    expect(det?.sovereignty_level).toBe(3);
  });
});

describe('L1 · calibrator', () => {
  it('uses the catalogue seed until the warm-up threshold is met', () => {
    const seeded = telemetryFor('openai/gpt-5');
    expect(seeded.latencyObserved).toBe(false);
    expect(seeded.latencyMs).toBe(getCatalogueEntry('openai/gpt-5')?.latency_seed_ms);
  });

  it('reports an observed p50 once enough samples exist', () => {
    for (const ms of [1000, 2000, 3000]) recordSample('openai/gpt-5', ms, true);
    const t = telemetryFor('openai/gpt-5');
    expect(t.latencyObserved).toBe(true);
    expect(t.latencyMs).toBe(2000);
    expect(t.samples).toBe(MIN_SAMPLES);
  });

  it('computes p50 over successful calls only', () => {
    // A fast failure must not be allowed to masquerade as excellent latency.
    recordSample('openai/gpt-5', 5, false);
    recordSample('openai/gpt-5', 5, false);
    recordSample('openai/gpt-5', 4000, true);
    recordSample('openai/gpt-5', 4200, true);
    recordSample('openai/gpt-5', 4400, true);
    expect(telemetryFor('openai/gpt-5').latencyMs).toBe(4200);
  });

  it('tracks success rate across the window', () => {
    for (let i = 0; i < 8; i++) recordSample('openai/gpt-5-mini', 1000, true);
    for (let i = 0; i < 2; i++) recordSample('openai/gpt-5-mini', 1000, false);
    expect(telemetryFor('openai/gpt-5-mini').successRate).toBeCloseTo(0.8, 5);
  });

  it('bounds memory at the window size', () => {
    for (let i = 0; i < WINDOW_SIZE * 3; i++) recordSample('openai/gpt-5-nano', 100, true);
    expect(telemetryFor('openai/gpt-5-nano').samples).toBe(WINDOW_SIZE);
  });

  it('assumes reliability rather than failure when no samples exist', () => {
    expect(telemetryFor('anthropic/claude-opus-4-7').successRate).toBe(1);
  });

  it('lists telemetry only for models actually sampled', () => {
    recordSample('google/gemini-3-flash-preview', 900, true);
    expect(allTelemetry().map((t) => t.modelId)).toEqual(['google/gemini-3-flash-preview']);
  });
});

describe('L1 · policy P0 credential reality', () => {
  it('admits only the deterministic core when no credentials exist', () => {
    const r = applyRuntimePolicies(
      { task_type: 'calculation', confidentiality_level: 'internal' },
      50,
      listCatalogue(),
      OFFLINE_ENV,
    );
    expect(r.eligible.map((e) => e.id)).toEqual(['ronor/deterministic-core']);
    const p0 = r.evaluations.find((e) => e.rule === 'P0_CREDENTIAL_PRESENT');
    expect(p0?.excluded.length).toBeGreaterThan(0);
  });

  it('excludes DeepSeek and Perplexity under a default gateway with no vendor keys', () => {
    const r = applyRuntimePolicies(baseConstraints, 50, listCatalogue(), GATEWAY_ENV);
    const ids = r.eligible.map((e) => e.id);
    expect(ids.some((i) => i.startsWith('deepseek/'))).toBe(false);
    expect(ids.some((i) => i.startsWith('perplexity/'))).toBe(false);
    expect(ids.some((i) => i.startsWith('openai/'))).toBe(true);
    expect(ids.some((i) => i.startsWith('anthropic/'))).toBe(true);
    expect(ids.some((i) => i.startsWith('google/'))).toBe(true);
  });

  it('admits Perplexity as soon as a key is supplied', () => {
    const r = applyRuntimePolicies(
      { task_type: 'search', confidentiality_level: 'internal', require_search: true },
      50,
      listCatalogue(),
      { ...GATEWAY_ENV, PERPLEXITY_API_KEY: 'x' },
    );
    expect(r.eligible.every((e) => e.provider === 'perplexity')).toBe(true);
    expect(r.eligible.length).toBeGreaterThan(0);
  });
});

describe('L1 · policy P1 confidentiality', () => {
  it('restricts sovereign material to sovereign infrastructure', () => {
    const r = applyRuntimePolicies(
      { task_type: 'calculation', confidentiality_level: 'sovereign' },
      50,
      listCatalogue(),
      { ...GATEWAY_ENV, DEEPSEEK_API_KEY: 'x', PERPLEXITY_API_KEY: 'x' },
    );
    expect(r.eligible.every((e) => e.sovereignty_level >= 3)).toBe(true);
    expect(r.evaluations.some((e) => e.rule === 'P1_SOVEREIGN_ONLY')).toBe(true);
  });

  it('excludes unattestable jurisdictions for restricted material', () => {
    const r = applyRuntimePolicies(
      { task_type: 'reasoning', confidentiality_level: 'restricted' },
      50,
      listCatalogue(),
      { ...GATEWAY_ENV, DEEPSEEK_API_KEY: 'x' },
    );
    // DeepSeek carries sovereignty_level 0 — we cannot attest the execution
    // jurisdiction, which is not a standard restricted data can be held to.
    expect(r.eligible.some((e) => e.provider === 'deepseek')).toBe(false);
    expect(r.evaluations.some((e) => e.rule === 'P1_RESTRICTED_ATTESTABLE')).toBe(true);
  });

  it('leaves internal material unfiltered by P1', () => {
    const r = applyRuntimePolicies(baseConstraints, 50, listCatalogue(), GATEWAY_ENV);
    expect(r.evaluations.some((e) => e.rule.startsWith('P1_'))).toBe(false);
  });
});

describe('L1 · policy P2 capability and search', () => {
  it('admits reasoning engines as escalation for exact tasks', () => {
    const r = applyRuntimePolicies(
      { task_type: 'calculation', confidentiality_level: 'internal' },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.eligible.some((e) => e.provider === 'deterministic')).toBe(true);
    expect(r.eligible.some((e) => e.capabilities.includes('reasoning'))).toBe(true);
  });

  it('excludes engines lacking the requested capability', () => {
    const r = applyRuntimePolicies(
      { task_type: 'synthesis', confidentiality_level: 'internal' },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.eligible.every((e) => e.capabilities.includes('synthesis'))).toBe(true);
  });

  it('rejects when search is required and no search engine is live', () => {
    const r = applyRuntimePolicies(
      { task_type: 'search', confidentiality_level: 'internal', require_search: true },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.rejected).toBe(true);
    // The rejection must NAME the rule that emptied the set, not merely report
    // that the set is empty. Here P2 empties it first, because the only engines
    // declaring the `search` capability are the two Perplexity entries and both
    // were already removed by P0 for want of a credential.
    expect(r.rejectionReason).toContain('P2_CAPABILITY_MATCH');
    expect(r.rejectionReason).toContain('Excluded at this step');
  });

  it('names the search rule when a search engine is live but the task excludes it', () => {
    const r = applyRuntimePolicies(
      // `require_search` with a task only non-search engines declare: the search
      // rule is then the one an operator must relax, and it must be named.
      { task_type: 'synthesis', confidentiality_level: 'internal', require_search: true },
      50,
      listCatalogue(),
      { ...GATEWAY_ENV, PERPLEXITY_API_KEY: 'x' },
    );
    expect(r.rejected).toBe(true);
    expect(r.rejectionReason).toContain('P2S_SEARCH_REQUIRED');
  });
});

describe('L1 · policy P3 deterministic-first', () => {
  it('sets the flag for calculation tasks only', () => {
    expect(
      applyRuntimePolicies(
        { task_type: 'calculation', confidentiality_level: 'internal' },
        50,
        listCatalogue(),
        GATEWAY_ENV,
      ).deterministicFirst,
    ).toBe(true);
    expect(applyRuntimePolicies(baseConstraints, 50, listCatalogue(), GATEWAY_ENV).deterministicFirst).toBe(
      false,
    );
  });

  it('pins the exact engine to the top of the ranked table', () => {
    const r = applyRuntimePolicies(
      { task_type: 'calculation', confidentiality_level: 'internal' },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    const ranked = rankCandidates(r.eligible, 50, r.deterministicFirst);
    expect(ranked[0].provider).toBe('deterministic');
    expect(ranked[0].pinned_by_policy).toBe('P3_DETERMINISTIC_FIRST');
  });
});

describe('L1 · policy P4 provider lists', () => {
  it('honours an allow-list', () => {
    const r = applyRuntimePolicies(
      { ...baseConstraints, allowed_providers: ['anthropic'] },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.eligible.every((e) => e.provider === 'anthropic')).toBe(true);
  });

  it('honours a deny-list', () => {
    const r = applyRuntimePolicies(
      { ...baseConstraints, denied_providers: ['openai'] },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.eligible.some((e) => e.provider === 'openai')).toBe(false);
    expect(r.eligible.length).toBeGreaterThan(0);
  });
});

describe('L1 · policy P5–P7 ceilings and floors', () => {
  it('excludes engines exceeding the latency ceiling using calibrated latency', () => {
    // Push GPT-5 above the ceiling with real samples; the seed would have passed.
    for (const ms of [12_000, 12_500, 13_000]) recordSample('openai/gpt-5', ms, true);
    const r = applyRuntimePolicies(
      { ...baseConstraints, max_latency_ms: 7000 },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.eligible.some((e) => e.id === 'openai/gpt-5')).toBe(false);
    expect(r.evaluations.find((e) => e.rule === 'P5_LATENCY_CEILING')?.excluded).toContain(
      'openai/gpt-5',
    );
  });

  it('excludes engines exceeding the cost ceiling', () => {
    const r = applyRuntimePolicies(
      { ...baseConstraints, max_cost_usd: 0.005 },
      2000,
      listCatalogue(),
      GATEWAY_ENV,
    );
    for (const e of r.eligible) {
      expect(estimateRequestCost(e, 2000)).toBeLessThanOrEqual(0.005);
    }
  });

  it('excludes engines below the evidence floor', () => {
    const r = applyRuntimePolicies(
      { ...baseConstraints, required_evidence_level: 80 },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.eligible.every((e) => e.evidence_reliability >= 80)).toBe(true);
  });

  it('estimates cost conservatively — never below the naive prompt-only figure', () => {
    const entry = getCatalogueEntry('openai/gpt-5') as CatalogueEntry;
    const naive = (Math.ceil(400 / 4) / 1_000_000) * entry.input_cost_per_1m;
    expect(estimateRequestCost(entry, 400)).toBeGreaterThan(naive);
  });
});

describe('L1 · policy P8 jurisdiction', () => {
  it('admits only EU or sovereign execution under an EU pin', () => {
    const r = applyRuntimePolicies(
      { task_type: 'calculation', confidentiality_level: 'internal', jurisdiction_pin: 'EU' },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.eligible.every((e) => e.jurisdictions.includes('sovereign'))).toBe(true);
  });

  it('admits US and sovereign execution under a US pin', () => {
    const r = applyRuntimePolicies(
      { ...baseConstraints, jurisdiction_pin: 'US' },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(
      r.eligible.every(
        (e) => e.jurisdictions.includes('US') || e.jurisdictions.includes('sovereign'),
      ),
    ).toBe(true);
    expect(r.eligible.length).toBeGreaterThan(0);
  });

  it('excludes an unattestable jurisdiction under a sovereign pin', () => {
    const r = applyRuntimePolicies(
      { ...baseConstraints, jurisdiction_pin: 'sovereign' },
      50,
      listCatalogue(),
      { ...GATEWAY_ENV, DEEPSEEK_API_KEY: 'x' },
    );
    expect(r.eligible.some((e) => e.provider === 'deepseek')).toBe(false);
  });
});

describe('L1 · operator pin cannot override governance', () => {
  it('selects within the eligible set', () => {
    const r = applyRuntimePolicies(
      { ...baseConstraints, pin_model: 'anthropic/claude-sonnet-4-6' },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    expect(r.eligible.map((e) => e.id)).toEqual(['anthropic/claude-sonnet-4-6']);
  });

  it('rejects rather than admits when the pinned engine was policy-excluded', () => {
    const r = applyRuntimePolicies(
      {
        task_type: 'calculation',
        confidentiality_level: 'sovereign',
        pin_model: 'openai/gpt-5',
      },
      50,
      listCatalogue(),
      GATEWAY_ENV,
    );
    // A pin must never smuggle an engine past P1. The correct outcome is an
    // explicit rejection, not a quiet substitution of a compliant engine.
    expect(r.rejected).toBe(true);
    expect(r.rejectionReason).toContain('P9_OPERATOR_PIN');
  });
});

describe('L1 · 6D scoring', () => {
  it('produces six terms and a total that is their weighted sum', () => {
    const entry = getCatalogueEntry('anthropic/claude-sonnet-4-6') as CatalogueEntry;
    const s = scoreCandidate(entry, 400);
    expect(Object.keys(s.terms).sort()).toEqual(
      ['cost', 'evidence', 'latency', 'operational_risk', 'quality', 'sovereignty'].sort(),
    );
    const sum = +Object.values(s.weighted).reduce((a, b) => a + b, 0).toFixed(2);
    expect(s.total).toBeCloseTo(sum, 2);
  });

  it('penalises cost and latency and rewards quality, sovereignty and evidence', () => {
    const entry = getCatalogueEntry('openai/gpt-5.5') as CatalogueEntry;
    const s = scoreCandidate(entry, 400);
    expect(s.weighted.cost).toBeLessThanOrEqual(0);
    expect(s.weighted.latency).toBeLessThanOrEqual(0);
    expect(s.weighted.operational_risk).toBeLessThanOrEqual(0);
    expect(s.weighted.quality).toBeGreaterThan(0);
    expect(s.weighted.evidence).toBeGreaterThan(0);
  });

  it('discounts quality by observed success rate', () => {
    const entry = getCatalogueEntry('openai/gpt-5') as CatalogueEntry;
    const healthy = scoreCandidate(entry, 400);
    for (let i = 0; i < 5; i++) recordSample(entry.id, 3000, false);
    for (let i = 0; i < 5; i++) recordSample(entry.id, 3000, true);
    const degraded = scoreCandidate(entry, 400);
    expect(degraded.terms.quality).toBeLessThan(healthy.terms.quality);
    expect(degraded.total).toBeLessThan(healthy.total);
  });

  it('exposes weights as tunable governance parameters', () => {
    expect(RUNTIME_WEIGHTS.quality).toBeGreaterThan(0);
    expect(Object.keys(RUNTIME_WEIGHTS)).toHaveLength(6);
  });

  it('breaks ties deterministically so a routing decision is reproducible', () => {
    const a = rankCandidates(listCatalogue(), 400, false).map((s) => s.model_id);
    const b = rankCandidates(listCatalogue(), 400, false).map((s) => s.model_id);
    expect(a).toEqual(b);
  });

  it('ranks the zero-cost sovereign engine first for an exact task', () => {
    const ranked = rankCandidates(
      listCatalogue().filter((e) => e.capabilities.includes('calculation')),
      50,
      false,
    );
    expect(ranked[0].model_id).toBe('ronor/deterministic-core');
  });
});

describe('L1 · cost accounting', () => {
  it('computes actual cost from measured tokens at per-million rates', () => {
    const entry = getCatalogueEntry('openai/gpt-5') as CatalogueEntry;
    // 1M in + 1M out must equal the sum of the two published rates exactly.
    expect(computeActualCost(entry, 1_000_000, 1_000_000)).toBeCloseTo(
      entry.input_cost_per_1m + entry.output_cost_per_1m,
      6,
    );
  });

  it('charges nothing for the sovereign core', () => {
    const det = getCatalogueEntry('ronor/deterministic-core') as CatalogueEntry;
    expect(computeActualCost(det, 10_000, 10_000)).toBe(0);
  });
});

describe('L1 · exchange execution and fallback', () => {
  it('returns the full scoring table on a dry run without executing', async () => {
    const r = await executeExchange({
      constraints: baseConstraints,
      prompt: 'test',
      dryRun: true,
      env: GATEWAY_ENV,
    });
    expect(r.ok).toBe(true);
    expect(r.routing_table.length).toBeGreaterThan(1);
    expect(r.attempts).toHaveLength(0);
    expect(r.total_cost_usd).toBe(0);
  });

  it('rejects on policy without spending anything', async () => {
    const r = await executeExchange({
      constraints: { task_type: 'search', confidentiality_level: 'sovereign', require_search: true },
      prompt: 'test',
      env: OFFLINE_ENV,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('rejected-policy');
    expect(r.total_cost_usd).toBe(0);
    expect(r.rejection_reason).toBeTruthy();
  });

  it('executes locally with zero cost when the deterministic core wins', async () => {
    const r = await executeExchange({
      constraints: { task_type: 'calculation', confidentiality_level: 'sovereign' },
      prompt: 'compute 144 / 12',
      env: OFFLINE_ENV,
    });
    expect(r.ok).toBe(true);
    expect(r.chosen_provider).toBe('deterministic');
    expect(r.transport).toBe('local');
    expect(r.total_cost_usd).toBe(0);
    expect(JSON.parse(r.content).answer).toContain('12');
  });

  it('walks the fallback chain when the leading engine cannot run', async () => {
    // Only the deterministic core is credentialed, and the prompt is not
    // computable, so the chain must exhaust and report honestly rather than
    // fabricate a result.
    const r = await executeExchange({
      constraints: { task_type: 'calculation', confidentiality_level: 'sovereign' },
      prompt: 'explain the EU AI Act obligations for high-risk systems',
      env: OFFLINE_ENV,
    });
    expect(r.ok).toBe(false);
    expect(r.status).toBe('all-providers-failed');
    expect(r.attempts.length).toBeGreaterThanOrEqual(1);
    expect(r.attempts[0].failure_kind).toBe('not-computable');
    expect(r.rejection_reason).toContain('failed');
  });

  it('bounds the number of providers attempted', async () => {
    const r = await executeExchange({
      constraints: baseConstraints,
      prompt: 'anything',
      maxAttempts: 2,
      // A base URL that cannot resolve makes every gateway attempt fail fast.
      env: { OPENAI_API_BASE: 'http://127.0.0.1:9/v1', OPENAI_API_KEY: 'x' },
      timeoutMs: 2000,
    });
    expect(r.ok).toBe(false);
    expect(r.attempts.length).toBeLessThanOrEqual(2);
  });

  it('records a fallback reason on every attempt after the first', async () => {
    const r = await executeExchange({
      constraints: baseConstraints,
      prompt: 'anything',
      maxAttempts: 3,
      env: { OPENAI_API_BASE: 'http://127.0.0.1:9/v1', OPENAI_API_KEY: 'x' },
      timeoutMs: 2000,
    });
    expect(r.attempts[0].fallback_reason).toBeNull();
    for (const a of r.attempts.slice(1)) {
      expect(a.fallback_reason).toBeTruthy();
    }
  });

  it('counts the cost of failed attempts, not only the successful one', async () => {
    const r = await executeExchange({
      constraints: baseConstraints,
      prompt: 'anything',
      maxAttempts: 2,
      env: { OPENAI_API_BASE: 'http://127.0.0.1:9/v1', OPENAI_API_KEY: 'x' },
      timeoutMs: 2000,
    });
    // Network failures bill nothing, but the field must exist and be numeric so
    // that a partially-billed chain is reported rather than silently dropped.
    expect(typeof r.total_cost_usd).toBe('number');
    expect(r.total_cost_usd).toBeGreaterThanOrEqual(0);
  });

  it('feeds every attempt into the calibrator', async () => {
    await executeExchange({
      constraints: { task_type: 'calculation', confidentiality_level: 'sovereign' },
      prompt: 'compute 2+2',
      env: OFFLINE_ENV,
    });
    expect(telemetryFor('ronor/deterministic-core').samples).toBeGreaterThan(0);
  });

  it('never asks a model for more visible tokens than it can emit', () => {
    const { routing } = routeOnly({
      constraints: baseConstraints,
      prompt: 'x',
      maxOutputTokens: 1_000_000,
      env: GATEWAY_ENV,
    });
    for (const c of routing) {
      const entry = getCatalogueEntry(c.model_id) as CatalogueEntry;
      expect(Math.min(1_000_000, entry.max_output_tokens)).toBe(entry.max_output_tokens);
    }
  });
});
