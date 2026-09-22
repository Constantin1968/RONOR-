import { createNativeOpenHandsClient, CONTEXT_BOUNDS } from '../../src/runtime/automation/adapters/openhands-native';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const conversationId = '22222222-2222-4222-8222-222222222222';
const envelope: OpenHandsExecutionEnvelope = {
  assignment_id: 'a1', instruction: 'Run tests.', allowed_actions: ['read_repo', 'run_tests'],
  objective_hash: 'b'.repeat(64), deadline: new Date(Date.now() + 120_000).toISOString(),
};
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

describe('pause confirmation settles asynchronously', () => {
  /**
   * Regression guard for the defect that masked every other stop reason.
   *
   * POST /pause is accepted while the agent is still finishing an approved
   * action, so execution_status does not settle in the same tick. The previous
   * implementation read state once, microseconds after the POST, and treated a
   * still-running status as a failed pause. A successful pause was reported as
   * 'openhands_pause_unconfirmed', and the genuine stop reason was discarded.
   *
   * Discrimination: the server here reports 'running' on the first read and
   * 'paused' only on the third. A single-read implementation necessarily fails
   * this test; an implementation that re-polls a bounded window necessarily
   * passes it. This test therefore cannot pass on the unfixed code.
   */
  it('accepts a pause that settles on a later read instead of demanding instant proof', async () => {
    const fetcher = jest.fn()
      // Startup handshake for a resumed conversation.
      .mockImplementationOnce(() => json(state('paused', 100_000)))
      .mockImplementationOnce(() => json({ success: true }))
      .mockImplementationOnce(() => json(state('paused', 100_000)))
      .mockImplementationOnce(() => json({ success: true }))
      // Deadline reached while the agent is mid-action.
      .mockImplementationOnce(() => json(state('running', 100_000)))
      // POST /pause is accepted.
      .mockImplementationOnce(() => json({ success: true }))
      // The status has not settled yet: this is the read the old code trusted.
      .mockImplementationOnce(() => json(state('running', 110_000)))
      .mockImplementationOnce(() => json(state('running', 110_000)))
      // Third confirmation read: the pause has landed.
      .mockImplementationOnce(() => json(state('paused', 110_000)))
      .mockImplementationOnce(() => json({ items: [] }));

    const client = createNativeOpenHandsClient({
      baseUrl: 'https://hands.invalid', sessionApiKey: 'test-session', fetcher,
      pollIntervalMs: 0, pauseConfirmIntervalMs: 0, sleep: async () => undefined,
      maxPolls: 1, catalogAccounting: true,
      llm: { model: 'openai/qwen3.8-max', apiKey: 'test-key', baseUrl: 'http://model-egress-proxy:3004/v1' },
    });

    const result = await client.execute({
      ...envelope, budget_token: 'test-budget',
      resume: { conversation_id: conversationId, accounted_cost_usd: 0.2 },
    });

    // The stop reason must not be replaced by the pause-confirmation failure.
    expect(result.summary).not.toBe('openhands_pause_unconfirmed');
    // Cost must still be accounted from the settled read, not discarded.
    expect(result.cost_usd).not.toBeNull();

    const paths = fetcher.mock.calls.map((c) => new URL(c[0] as string).pathname);
    expect(paths.filter((p) => p.endsWith('/pause'))).toHaveLength(1);
    // Proof the window was actually used: more than one state read after pause.
    expect(paths.lastIndexOf(`/api/conversations/${conversationId}`))
      .toBeGreaterThan(paths.indexOf(`/api/conversations/${conversationId}/pause`) + 1);
  });

  it('keeps the context bounds identical across agent, resume check and condenser', () => {
    expect(CONTEXT_BOUNDS.maxInputTokens).toBeGreaterThan(20_000);
    expect(CONTEXT_BOUNDS.condenserMaxTokens).toBeGreaterThan(16_000);
    // The condenser must trigger before the agent's own input ceiling, or it
    // would never get a chance to summarise.
    expect(CONTEXT_BOUNDS.condenserMaxTokens).toBeLessThan(CONTEXT_BOUNDS.maxInputTokens);
  });
});
