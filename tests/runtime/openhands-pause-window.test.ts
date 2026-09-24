import {
  createNativeOpenHandsClient, CONTEXT_BOUNDS, PAUSE_CONFIRMATION, pauseConfirmWindowFromEnv,
} from '../../src/runtime/automation/adapters/openhands-native';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

/**
 * The pause confirmation window is measured on the clock and sized for the
 * latency actually observed on the host.
 *
 * Validation run run_f5319b1ff35f413786f0 (22 September 2026) requested a pause
 * that the agent served 55 s later, because a pause is honoured only between
 * steps and a step can be a model call. The previous window, 8 reads x 500 ms,
 * gave up after 4 s and reported 'openhands_pause_unconfirmed'.
 *
 * Every test here drives a simulated clock: sleep() advances it, so the tests
 * are instant and deterministic while still exercising wall-clock semantics.
 */
const conversationId = '33333333-3333-4333-8333-333333333333';
const json = (value: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(value), { status }));

const boundedLlm = {
  model: 'openai/qwen3.8-max', base_url: 'http://model-egress-proxy:3004/v1',
  max_input_tokens: CONTEXT_BOUNDS.maxInputTokens, max_message_chars: CONTEXT_BOUNDS.maxMessageChars,
  max_output_tokens: 4096, num_retries: 0, extra_headers: { 'x-ronor-budget': 'test-budget' },
};
const boundedAgent = {
  llm: boundedLlm,
  condenser: {
    kind: 'LLMSummarizingCondenser', max_size: CONTEXT_BOUNDS.condenserMaxSize,
    max_tokens: CONTEXT_BOUNDS.condenserMaxTokens, keep_first: 2,
    llm: { ...boundedLlm, usage_id: 'condenser' },
  },
};
const state = (status: string, tokens: number) => ({
  execution_status: status, agent: boundedAgent,
  workspace: { working_dir: '/workspace/project' },
  confirmation_policy: { kind: 'AlwaysConfirm' },
  stats: { usage_to_metrics: { agent: {
    model_name: 'openai/qwen3.8-max',
    accumulated_token_usage: { prompt_tokens: tokens, completion_tokens: 0 },
  } } },
});

/** A resumed conversation whose pause lands `settleAfterMs` after the request. */
function harness(settleAfterMs: number, windowMs?: number) {
  let clock = Date.parse('2026-09-22T08:17:21Z');
  let pauseRequestedAt: number | null = null;
  let confirmationReads = 0;
  const prologue = [
    () => json(state('paused', 100_000)), () => json({ success: true }),
    () => json(state('paused', 100_000)), () => json({ success: true }),
    // The work loop's single poll: the agent is mid-step.
    () => json(state('running', 100_000)),
  ];
  const fetcher = jest.fn((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    if (prologue.length) return prologue.shift()!();
    if (url.pathname.endsWith('/pause') && init?.method === 'POST') {
      pauseRequestedAt = clock;
      return json({ success: true });
    }
    if (url.pathname === `/api/conversations/${conversationId}`) {
      confirmationReads += 1;
      const settled = pauseRequestedAt !== null && clock - pauseRequestedAt >= settleAfterMs;
      return json(state(settled ? 'paused' : 'running', 110_000));
    }
    return json({ items: [] });
  });
  const client = createNativeOpenHandsClient({
    baseUrl: 'https://hands.invalid', sessionApiKey: 'test-session', fetcher,
    pollIntervalMs: 0, maxPolls: 1, catalogAccounting: true,
    ...(windowMs === undefined ? {} : { pauseConfirmWindowMs: windowMs }),
    now: () => clock,
    sleep: async (ms: number) => { clock += ms; },
    llm: { model: 'openai/qwen3.8-max', apiKey: 'test-key', baseUrl: 'http://model-egress-proxy:3004/v1' },
  });
  const envelope: OpenHandsExecutionEnvelope = {
    assignment_id: 'a1', instruction: 'Run tests.', allowed_actions: ['read_repo', 'run_tests'],
    objective_hash: 'c'.repeat(64), deadline: new Date(clock + 45 * 60_000).toISOString(),
    budget_token: 'test-budget', resume: { conversation_id: conversationId, accounted_cost_usd: 0.2 },
  };
  return {
    client, envelope, fetcher,
    elapsedSincePause: () => (pauseRequestedAt === null ? null : clock - pauseRequestedAt),
    confirmationReads: () => confirmationReads,
  };
}

describe('pause confirmation window, measured on the clock', () => {
  it('accepts the pause the host actually served, 55 s after the request', async () => {
    // Discrimination: under the former 8 x 500 ms window this pause is
    // reported as 'openhands_pause_unconfirmed'.
    const h = harness(55_000);
    const result = await h.client.execute(h.envelope);
    expect(result.summary).not.toBe('openhands_pause_unconfirmed');
    expect(result.summary).toBe('openhands_poll_limit_paused');
    expect(result.cost_usd).not.toBeNull();
    expect(h.elapsedSincePause()).toBeGreaterThanOrEqual(55_000);
  });

  it('defaults to three times the observed latency', () => {
    expect(PAUSE_CONFIRMATION.windowMs).toBe(180_000);
    expect(PAUSE_CONFIRMATION.windowMs).toBeGreaterThanOrEqual(3 * 55_000);
  });

  it('gives up once the window is spent, and never waits materially longer', async () => {
    const h = harness(Number.POSITIVE_INFINITY);
    const result = await h.client.execute(h.envelope);
    expect(result.summary).toBe('openhands_pause_unconfirmed');
    expect(h.elapsedSincePause()).toBeGreaterThanOrEqual(PAUSE_CONFIRMATION.windowMs);
    expect(h.elapsedSincePause()).toBeLessThanOrEqual(PAUSE_CONFIRMATION.windowMs + PAUSE_CONFIRMATION.intervalMs);
    // Bounded reads: the window is not a busy loop.
    expect(h.confirmationReads()).toBeLessThanOrEqual(PAUSE_CONFIRMATION.windowMs / PAUSE_CONFIRMATION.intervalMs + 1);
  });

  it('honours an operator window without changing the default', async () => {
    const h = harness(55_000, 30_000);
    const result = await h.client.execute(h.envelope);
    expect(result.summary).toBe('openhands_pause_unconfirmed');
    expect(h.elapsedSincePause()).toBeLessThanOrEqual(30_000 + PAUSE_CONFIRMATION.intervalMs);
  });

  it('refuses before anything is billable when the deadline leaves no room to pause', async () => {
    const h = harness(0);
    const tooShort = { ...h.envelope, deadline: new Date(Date.parse('2026-09-22T08:17:21Z') + PAUSE_CONFIRMATION.windowMs).toISOString() };
    const result = await h.client.execute(tooShort);
    expect(result).toMatchObject({ ok: false, summary: 'openhands_deadline_leaves_no_pause_window', cost_usd: 0 });
    expect(h.fetcher).not.toHaveBeenCalled();
  });
});

describe('RONOR_OPENHANDS_PAUSE_CONFIRM_WINDOW_MS', () => {
  it('falls back to the default when unset', () => {
    expect(pauseConfirmWindowFromEnv(undefined)).toBe(PAUSE_CONFIRMATION.windowMs);
    expect(pauseConfirmWindowFromEnv('')).toBe(PAUSE_CONFIRMATION.windowMs);
  });
  it('accepts a value inside the closed range', () => {
    expect(pauseConfirmWindowFromEnv('240000')).toBe(240_000);
  });
  it.each(['abc', '-1', '1e5', '4999', '900001', '180000.5', ' 180000'])('refuses %p instead of guessing', (value) => {
    expect(() => pauseConfirmWindowFromEnv(value)).toThrow('openhands_pause_window_invalid');
  });
});
