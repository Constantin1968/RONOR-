/**
 * RONOR Runtime — L7 Ledger and Mission State Tests
 *
 * A ledger's value is entirely in its trustworthiness, so these tests target the
 * ways a ledger silently lies: pooling failed spend into an invisible total,
 * presenting inferred cost as measured cost, storing a prompt it promised not to
 * store, double-counting a mission's worker costs, or overwriting a contradicting
 * finding with the finding it contradicts.
 *
 * Prepared by AMB.
 */

import crypto from 'crypto';
import {
  attemptsFor,
  countWork,
  getWork,
  listWork,
  recentAttemptSamples,
  recordAttempts,
  recordWork,
} from '../../src/runtime/ledgers/work-ledger';
import {
  getCostSummary,
  getValueSummary,
  recordValue,
} from '../../src/runtime/ledgers/cost-ledger';
import {
  appendToMission,
  createMission,
  getMission,
  listMissions,
  setMissionStatus,
} from '../../src/runtime/mission/store';

function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

function baseWork(over: Partial<Parameters<typeof recordWork>[0]> = {}) {
  return {
    request_id: uid('req'),
    mission_id: null,
    operator_id: 'test-operator',
    api_key_id: 'key_test',
    task_type: 'analysis',
    confidentiality: 'internal' as const,
    surface: 'query' as const,
    agent_id: null,
    status: 'completed' as const,
    chosen_model_id: 'anthropic/claude-sonnet-4-6',
    chosen_provider: 'anthropic',
    transport: 'gateway',
    input_tokens: 1000,
    output_tokens: 500,
    usage_estimated: false,
    cost_usd: 0.0105,
    latency_ms: 1200,
    attempts: 1,
    fallback_used: false,
    citations_count: 2,
    mi9_verdict: 'allow',
    prompt: 'What is the capacity of the Rovinari power station?',
    ...over,
  };
}

describe('L7 · work ledger', () => {
  it('records a request and reads it back', () => {
    const work = baseWork();
    recordWork(work);
    const read = getWork(work.request_id);
    expect(read).not.toBeNull();
    expect(read!.chosen_model_id).toBe('anthropic/claude-sonnet-4-6');
    expect(read!.cost_usd).toBeCloseTo(0.0105, 8);
  });

  it('stores a prompt DIGEST and never the prompt itself', () => {
    const prompt = 'A confidential question about a named counterparty in a live transaction.';
    const work = baseWork({ prompt });
    recordWork(work);
    const read = getWork(work.request_id)!;
    // The ledger is queried by dashboards and exported to auditors. Storing the
    // prompt would turn an operational record into a data-retention liability.
    expect(JSON.stringify(read)).not.toContain('counterparty');
    expect(read.prompt_digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces a stable digest for identical prompts', () => {
    const a = baseWork({ prompt: 'identical text' });
    const b = baseWork({ prompt: 'identical text' });
    recordWork(a);
    recordWork(b);
    // A stable digest lets an operator count repeats without seeing content.
    expect(getWork(a.request_id)!.prompt_digest).toBe(getWork(b.request_id)!.prompt_digest);
  });

  it('returns null for an unknown request rather than an empty row', () => {
    expect(getWork('req_nonexistent')).toBeNull();
  });

  it('lists most recent work first', () => {
    const older = baseWork();
    recordWork(older);
    const newer = baseWork();
    recordWork(newer);
    const listed = listWork(5);
    expect(listed[0].request_id).toBe(newer.request_id);
  });

  it('paginates without overlap', () => {
    for (let i = 0; i < 4; i += 1) recordWork(baseWork());
    const page1 = listWork(2, 0);
    const page2 = listWork(2, 2);
    expect(page1).toHaveLength(2);
    const ids = new Set([...page1, ...page2].map((w) => w.request_id));
    expect(ids.size).toBe(4);
  });

  it('counts rows monotonically', () => {
    const before = countWork();
    recordWork(baseWork());
    expect(countWork()).toBe(before + 1);
  });

  it('distinguishes measured from estimated token usage', () => {
    const measured = baseWork({ usage_estimated: false });
    const estimated = baseWork({ usage_estimated: true });
    recordWork(measured);
    recordWork(estimated);
    // SQLite has no boolean type; the column round-trips as 0/1. Asserting the
    // stored representation rather than a coerced one keeps the test honest about
    // what a consumer will actually receive from this API.
    expect(getWork(measured.request_id)!.usage_estimated).toBe(0);
    expect(getWork(estimated.request_id)!.usage_estimated).toBe(1);
  });

  it('records a governance rejection with zero spend', () => {
    const rejected = baseWork({
      status: 'rejected-governance',
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      chosen_model_id: null,
      mi9_verdict: 'block',
    });
    recordWork(rejected);
    const read = getWork(rejected.request_id)!;
    // A chain that logs only successes cannot answer what the system refused.
    expect(read.status).toBe('rejected-governance');
    expect(read.cost_usd).toBe(0);
  });

  it('attributes worker rows to an agent and a mission', () => {
    const missionId = uid('msn');
    const work = baseWork({
      surface: 'worker',
      agent_id: 'researcher',
      mission_id: missionId,
    });
    recordWork(work);
    const read = getWork(work.request_id)!;
    expect(read.agent_id).toBe('researcher');
    expect(read.mission_id).toBe(missionId);
  });
});

describe('L7 · provider attempts', () => {
  it('records every attempt including the failures', () => {
    const requestId = uid('req');
    recordWork(baseWork({ request_id: requestId, attempts: 2, fallback_used: true }));
    recordAttempts([
      {
        request_id: requestId,
        attempt_no: 1,
        model_id: 'openai/gpt-5.5',
        provider: 'openai',
        transport: 'gateway',
        ok: false,
        latency_ms: 900,
        input_tokens: 800,
        output_tokens: 0,
        cost_usd: 0.001,
        failure_kind: 'rate-limit',
        failure_message: 'HTTP 429',
        fallback_reason: 'primary rate-limited',
      },
      {
        request_id: requestId,
        attempt_no: 2,
        model_id: 'anthropic/claude-sonnet-4-6',
        provider: 'anthropic',
        transport: 'gateway',
        ok: true,
        latency_ms: 1100,
        input_tokens: 800,
        output_tokens: 400,
        cost_usd: 0.0084,
        failure_kind: null,
        failure_message: null,
        fallback_reason: null,
      },
    ]);
    const attempts = attemptsFor(requestId);
    expect(attempts).toHaveLength(2);
    // The failed attempt must be a row of its own, or its spend is invisible.
    // SQLite stores the boolean as 0/1.
    expect(attempts[0].ok).toBe(0);
    expect(attempts[0].failure_kind).toBe('rate-limit');
    expect(attempts[0].cost_usd).toBeGreaterThan(0);
    expect(attempts[1].ok).toBe(1);
  });

  it('orders attempts by sequence so a fallback chain reads in order', () => {
    const requestId = uid('req');
    recordWork(baseWork({ request_id: requestId }));
    recordAttempts([
      attempt(requestId, 2, 'b/2', false),
      attempt(requestId, 1, 'a/1', false),
      attempt(requestId, 3, 'c/3', true),
    ]);
    expect(attemptsFor(requestId).map((a) => a.attempt_no)).toEqual([1, 2, 3]);
  });

  it('returns an empty array for a request with no attempts', () => {
    expect(attemptsFor('req_none')).toEqual([]);
  });

  it('supplies successful samples for router calibration', () => {
    const requestId = uid('req');
    recordWork(baseWork({ request_id: requestId }));
    recordAttempts([
      attempt(requestId, 1, 'calib/model-x', true, 750),
      attempt(requestId, 2, 'calib/model-x', false, 5000),
    ]);
    const samples = recentAttemptSamples(500);
    const mine = samples.filter((s) => s.model_id === 'calib/model-x');
    expect(mine.length).toBeGreaterThanOrEqual(2);
    // Both outcomes are supplied: the calibrator needs the failure to compute a
    // success rate, and must exclude it from the latency percentile.
    expect(mine.some((s) => s.ok)).toBe(true);
    expect(mine.some((s) => !s.ok)).toBe(true);
  });
});

function attempt(
  requestId: string,
  n: number,
  modelId: string,
  ok: boolean,
  latency = 1000,
): Parameters<typeof recordAttempts>[0][number] {
  return {
    request_id: requestId,
    attempt_no: n,
    model_id: modelId,
    provider: modelId.split('/')[0],
    transport: 'gateway',
    ok,
    latency_ms: latency,
    input_tokens: 100,
    output_tokens: ok ? 50 : 0,
    cost_usd: ok ? 0.001 : 0.0002,
    failure_kind: ok ? null : 'server-error',
    failure_message: ok ? null : 'HTTP 500',
    fallback_reason: ok ? null : 'upstream failure',
  };
}

describe('L7 · cost-of-intelligence ledger', () => {
  it('separates measured spend from estimated spend', () => {
    recordWork(baseWork({ usage_estimated: false, cost_usd: 0.02 }));
    recordWork(baseWork({ usage_estimated: true, cost_usd: 0.03 }));
    const summary = getCostSummary();
    // A dashboard that pools these presents an inferred figure as a measured one.
    expect(summary.measured_cost_usd).toBeGreaterThan(0);
    expect(summary.estimated_cost_usd).toBeGreaterThan(0);
    expect(summary.total_cost_usd).toBeCloseTo(
      summary.measured_cost_usd + summary.estimated_cost_usd,
      6,
    );
  });

  it('surfaces wasted spend from failed attempts as a first-class figure', () => {
    const requestId = uid('req');
    recordWork(baseWork({ request_id: requestId, fallback_used: true, attempts: 2 }));
    recordAttempts([
      attempt(requestId, 1, 'waste/model', false, 800),
      attempt(requestId, 2, 'good/model', true, 900),
    ]);
    const summary = getCostSummary();
    // Spend on failures is the figure an operator most needs and is the one most
    // often pooled into an opaque total.
    expect(summary.wasted_cost_usd).toBeGreaterThan(0);
  });

  it('computes a fallback rate between zero and one', () => {
    const summary = getCostSummary();
    expect(summary.fallback_rate).toBeGreaterThanOrEqual(0);
    expect(summary.fallback_rate).toBeLessThanOrEqual(1);
  });

  it('breaks cost down by model from the ATTEMPTS table, not the work table', () => {
    // A model id unique to this run: the ledger is a persistent file shared with
    // every other test in the process, so a fixed id would make this assertion
    // depend on execution order.
    const modelId = `breakdown/${crypto.randomBytes(5).toString('hex')}`;
    const requestId = uid('req');
    recordWork(
      baseWork({
        request_id: requestId,
        chosen_model_id: modelId,
        chosen_provider: 'breakdown',
        cost_usd: 0.05,
      }),
    );
    // A work row alone must NOT appear in the per-model breakdown. The breakdown
    // is derived from attempts, because a request that succeeded on its second
    // engine spent money on two models and only the attempts table records both.
    // Attributing the whole cost to the winning model would make a failing
    // provider look free.
    expect(getCostSummary().by_model.some((m) => m.model_id === modelId)).toBe(false);

    recordAttempts([attempt(requestId, 1, modelId, true, 700)]);
    expect(getCostSummary().by_model.some((m) => m.model_id === modelId)).toBe(true);
  });

  it('attributes spend to every model in a fallback chain', () => {
    const requestId = uid('req');
    recordWork(baseWork({ request_id: requestId, fallback_used: true, attempts: 2 }));
    recordAttempts([
      attempt(requestId, 1, 'chain/primary', false, 400),
      attempt(requestId, 2, 'chain/secondary', true, 800),
    ]);
    const summary = getCostSummary();
    const primary = summary.by_model.find((m) => m.model_id === 'chain/primary');
    const secondary = summary.by_model.find((m) => m.model_id === 'chain/secondary');
    expect(primary).toBeDefined();
    expect(secondary).toBeDefined();
    // The failed primary carries a real cost and a zero success rate.
    expect(primary!.cost_usd).toBeGreaterThan(0);
    expect(primary!.success_rate).toBe(0);
    expect(secondary!.success_rate).toBe(1);
  });

  it('groups spend by provider', () => {
    const requestId = uid('req');
    recordWork(baseWork({ request_id: requestId }));
    recordAttempts([attempt(requestId, 1, 'providergroup/model-z', true, 600)]);
    const summary = getCostSummary();
    expect(summary.by_provider.some((p) => p.provider === 'providergroup')).toBe(true);
  });

  it('reports zero-cost sovereign work without dividing by zero', () => {
    recordWork(
      baseWork({
        chosen_model_id: 'ronor/deterministic-core',
        chosen_provider: 'deterministic',
        cost_usd: 0,
        input_tokens: 0,
        output_tokens: 0,
      }),
    );
    const summary = getCostSummary();
    expect(Number.isFinite(summary.total_cost_usd)).toBe(true);
    expect(Number.isFinite(summary.avg_cost_per_request_usd)).toBe(true);
  });

  it('honours a since filter', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const summary = getCostSummary(future);
    expect(summary.total_requests).toBe(0);
    expect(summary.total_cost_usd).toBe(0);
  });
});

describe('L7 · value tracking', () => {
  it('records a value row against a request', () => {
    const requestId = uid('req');
    recordWork(baseWork({ request_id: requestId }));
    recordValue({
      request_id: requestId,
      mission_id: null,
      cost_usd: 0.02,
      premium_cost_usd: 0.02,
      quality_delta: 0,
      verified_confidence: 78,
    });
    const summary = getValueSummary();
    expect(summary.requests_valued).toBeGreaterThan(0);
  });

  it('returns finite figures on an empty or sparse ledger', () => {
    const summary = getValueSummary();
    expect(Number.isFinite(summary.total_cost_usd)).toBe(true);
    expect(Number.isFinite(summary.avg_verified_confidence)).toBe(true);
  });
});

describe('L2 · mission state', () => {
  it('creates a mission in the open state', () => {
    const mission = createMission({
      title: 'Balancing market review',
      objective: 'Assess BESS arbitrage economics in Romania',
      operatorId: 'test-operator',
    });
    expect(mission.mission_id).toMatch(/^msn_/);
    expect(mission.status).toBe('open');
    expect(getMission(mission.mission_id)!.objective).toContain('BESS');
  });

  it('advances status through the lifecycle', () => {
    const mission = createMission({ title: 't', objective: 'o', operatorId: null });
    setMissionStatus(mission.mission_id, 'executing');
    expect(getMission(mission.mission_id)!.status).toBe('executing');
    setMissionStatus(mission.mission_id, 'complete');
    expect(getMission(mission.mission_id)!.status).toBe('complete');
  });

  it('accumulates spend across appends rather than overwriting it', () => {
    const mission = createMission({ title: 't', objective: 'o', operatorId: null });
    appendToMission({ missionId: mission.mission_id, costUsd: 0.01 });
    appendToMission({ missionId: mission.mission_id, costUsd: 0.02 });
    // Overwriting would understate mission spend, which is the figure a budget
    // control depends on.
    expect(getMission(mission.mission_id)!.cost_usd).toBeCloseTo(0.03, 6);
  });

  it('appends findings without discarding earlier ones', () => {
    const mission = createMission({ title: 't', objective: 'o', operatorId: null });
    appendToMission({
      missionId: mission.mission_id,
      findings: [
        { at: new Date().toISOString(), source: 'researcher', statement: 'capacity is 1320 MW', confidence: 80, citations: [] },
      ],
    });
    appendToMission({
      missionId: mission.mission_id,
      findings: [
        { at: new Date().toISOString(), source: 'curator', statement: 'capacity is 1720 MW', confidence: 60, citations: [] },
      ],
    });
    const state = getMission(mission.mission_id)!.state;
    // A contradicting finding must sit ALONGSIDE the one it contradicts. Replacing
    // it would erase the disagreement, which is precisely the signal an analyst
    // needs to see.
    expect(state.findings).toHaveLength(2);
    expect(state.findings.map((f) => f.statement)).toEqual(
      expect.arrayContaining(['capacity is 1320 MW', 'capacity is 1720 MW']),
    );
  });

  it('links contributing requests to the mission', () => {
    const mission = createMission({ title: 't', objective: 'o', operatorId: null });
    appendToMission({ missionId: mission.mission_id, requestId: 'req_one' });
    appendToMission({ missionId: mission.mission_id, requestId: 'req_two' });
    expect(getMission(mission.mission_id)!.state.request_ids).toEqual(['req_one', 'req_two']);
  });

  it('records decisions with their rationale', () => {
    const mission = createMission({ title: 't', objective: 'o', operatorId: null });
    appendToMission({
      missionId: mission.mission_id,
      decision: { decision: 'proceed', rationale: 'evidence is sufficient', request_id: 'req_x' },
    });
    expect(getMission(mission.mission_id)!.state.decisions[0].decision).toBe('proceed');
  });

  it('ignores an append to an unknown mission rather than throwing', () => {
    // A ledger write must never crash a mission that has already done real work.
    expect(() => appendToMission({ missionId: 'msn_ghost', costUsd: 1 })).not.toThrow();
  });

  it('lists missions most recent first', () => {
    const a = createMission({ title: 'first', objective: 'o', operatorId: null });
    const b = createMission({ title: 'second', objective: 'o', operatorId: null });
    const listed = listMissions(10).map((m) => m.mission_id);
    expect(listed.indexOf(b.mission_id)).toBeLessThan(listed.indexOf(a.mission_id));
  });

  it('returns null for an unknown mission', () => {
    expect(getMission('msn_nope')).toBeNull();
  });
});
