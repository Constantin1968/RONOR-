import { createNativeOpenHandsClient } from '../../src/runtime/automation/adapters/openhands-native';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const envelope: OpenHandsExecutionEnvelope = {
  assignment_id: 'a1', instruction: 'Run tests.', allowed_actions: ['read_repo', 'run_tests'], objective_hash: 'a'.repeat(64), deadline: '2026-08-21T00:00:00Z',
};
const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));

describe('native OpenHands Agent Server client', () => {
  it('uses native authenticated conversation lifecycle and emits hashed event evidence', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: 'conv-1' }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ status: 'running' }))
      .mockImplementationOnce(() => json({ status: 'finished', cost_usd: 0.02 }))
      .mockImplementationOnce(() => json({ events: [{ type: 'message', content: 'done' }] }));
    const client = createNativeOpenHandsClient({ baseUrl: 'http://127.0.0.1:8000', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0, sleep: async () => undefined });
    const result = await client.execute(envelope);
    expect(result).toMatchObject({ ok: true, cost_usd: 0.02, artifacts: [{ kind: 'event_log', reference: 'conversations/conv-1/events' }] });
    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const call of fetcher.mock.calls) expect((call[1] as RequestInit).headers).toHaveProperty('X-Session-API-Key', 'session-key');
    expect((fetcher.mock.calls[0][1] as RequestInit).redirect).toBe('error');
  });

  it('pauses on bounded timeout and never deletes the conversation', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ id: 'conv-2' }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ state: 'running' }))
      .mockImplementationOnce(() => json({ paused: true }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, maxPolls: 1, pollIntervalMs: 0, sleep: async () => undefined });
    await expect(client.execute(envelope)).resolves.toMatchObject({ ok: false, summary: expect.stringContaining('paused') });
    const urls = fetcher.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain('https://hands.invalid/api/conversations/conv-2/pause');
    expect(fetcher.mock.calls.some((call) => (call[1] as RequestInit).method === 'DELETE')).toBe(false);
  });

  it('fails closed on missing session key and plaintext remote endpoints', () => {
    expect(() => createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: '' })).toThrow('openhands_session_key_required');
    expect(() => createNativeOpenHandsClient({ baseUrl: 'http://hands.invalid', sessionApiKey: 'key' })).toThrow('openhands_url_requires_https_or_loopback');
  });
});
