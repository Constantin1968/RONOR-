import { createNativeOpenHandsClient } from '../../src/runtime/automation/adapters/openhands-native';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const conversationId = '11111111-1111-4111-8111-111111111111';
const envelope: OpenHandsExecutionEnvelope = {
  assignment_id: 'a1', instruction: 'Run tests.', allowed_actions: ['read_repo', 'run_tests'], objective_hash: 'a'.repeat(64), deadline: '2026-08-21T00:00:00Z',
};
const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));

describe('native OpenHands Agent Server client', () => {
  it('uses the official authenticated conversation lifecycle and emits hashed event evidence', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'running' }))
      .mockImplementationOnce(() => json({ execution_status: 'finished', cost_usd: 0.02 }))
      .mockImplementationOnce(() => json({ items: [{ kind: 'MessageEvent', content: 'done' }] }));
    const client = createNativeOpenHandsClient({ baseUrl: 'http://127.0.0.1:8000', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0, sleep: async () => undefined });
    const result = await client.execute(envelope);
    expect(result).toMatchObject({ ok: true, cost_usd: 0.02, artifacts: [{ kind: 'event_log', reference: `api/conversations/${conversationId}/events/search` }] });
    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const call of fetcher.mock.calls) expect((call[1] as RequestInit).headers).toHaveProperty('X-Session-API-Key', 'session-key');
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:8000/api/conversations');
    expect(JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body))).toEqual({
      workspace: { kind: 'LocalWorkspace', working_dir: '/workspace/project' },
      confirmation_policy: { kind: 'AlwaysConfirm' }, max_iterations: 100,
    });
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toEqual({
      role: 'user', content: [{ type: 'text', text: 'Run tests.' }], run: true,
    });
    expect((fetcher.mock.calls[0][1] as RequestInit).redirect).toBe('error');
  });

  it('accepts a safe pending action through the bounded confirmation policy', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'waiting_for_confirmation' }))
      .mockImplementationOnce(() => json({ items: [{ kind: 'ActionEvent', action: { command: 'git status --short' } }] }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'finished' }))
      .mockImplementationOnce(() => json({ items: [] }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0, sleep: async () => undefined });
    await expect(client.execute(envelope)).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(String((fetcher.mock.calls[4][1] as RequestInit).body))).toMatchObject({ accept: true });
  });

  it('rejects and pauses a forbidden pending action before execution', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'waiting_for_confirmation' }))
      .mockImplementationOnce(() => json({ items: [{ kind: 'ActionEvent', action: { command: 'git push origin HEAD' } }] }))
      .mockImplementationOnce(() => json({ accepted: false }))
      .mockImplementationOnce(() => json({ paused: true }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0, sleep: async () => undefined });
    await expect(client.execute(envelope)).resolves.toMatchObject({ ok: false, summary: expect.stringContaining('git_push_forbidden') });
    expect(JSON.parse(String((fetcher.mock.calls[4][1] as RequestInit).body))).toMatchObject({ accept: false });
    expect(String(fetcher.mock.calls[5][0])).toBe(`https://hands.invalid/api/conversations/${conversationId}/pause`);
  });

  it('pauses on bounded timeout and never deletes the conversation', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'running' }))
      .mockImplementationOnce(() => json({ paused: true }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, maxPolls: 1, pollIntervalMs: 0, sleep: async () => undefined });
    await expect(client.execute(envelope)).resolves.toMatchObject({ ok: false, summary: expect.stringContaining('paused') });
    const urls = fetcher.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(`https://hands.invalid/api/conversations/${conversationId}/pause`);
    expect(fetcher.mock.calls.some((call) => (call[1] as RequestInit).method === 'DELETE')).toBe(false);
  });

  it('propagates cancellation to Agent Server and pauses an active conversation', async () => {
    const controller = new AbortController();
    let pollingStarted!: () => void;
    const polling = new Promise<void>((resolve) => { pollingStarted = resolve; });
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        pollingStarted();
        init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      }))
      .mockImplementationOnce(() => json({ paused: true }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0 });
    const execution = client.execute(envelope, controller.signal);
    await polling;
    controller.abort();
    await expect(execution).rejects.toThrow('openhands_cancelled');
    expect(String(fetcher.mock.calls[3][0])).toBe(`https://hands.invalid/api/conversations/${conversationId}/pause`);
    expect((fetcher.mock.calls[2][1] as RequestInit).signal).toBe(controller.signal);
  });

  it('uses the authenticated official health endpoint', async () => {
    const fetcher = jest.fn(() => json({ ok: true }));
    const client = createNativeOpenHandsClient({ baseUrl: 'http://127.0.0.1:8000', sessionApiKey: 'session-key', fetcher });
    await expect(client.health()).resolves.toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:8000/health');
    expect(init.headers).toHaveProperty('X-Session-API-Key', 'session-key');
  });

  it('fails closed on missing session key and plaintext remote endpoints', () => {
    expect(() => createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: '' })).toThrow('openhands_session_key_required');
    expect(() => createNativeOpenHandsClient({ baseUrl: 'http://hands.invalid', sessionApiKey: 'key' })).toThrow('openhands_url_requires_https_or_trusted_service');
  });

  it('admits only an explicitly named plaintext service on the isolated network', async () => {
    const fetcher = jest.fn(() => json({ ok: true }));
    const client = createNativeOpenHandsClient({
      baseUrl: 'http://openhands-agent:8000', sessionApiKey: 'session-key',
      plaintextServiceHosts: ['openhands-agent'], fetcher,
    });
    await expect(client.health()).resolves.toBe(true);
    const [healthUrl] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(healthUrl)).toBe('http://openhands-agent:8000/health');
    expect(() => createNativeOpenHandsClient({
      baseUrl: 'http://other-agent:8000', sessionApiKey: 'session-key', plaintextServiceHosts: ['openhands-agent'],
    })).toThrow('openhands_url_requires_https_or_trusted_service');
    expect(() => createNativeOpenHandsClient({
      baseUrl: 'http://openhands-agent:8000/path?redirect=x', sessionApiKey: 'session-key', plaintextServiceHosts: ['openhands-agent'],
    })).toThrow('openhands_url_invalid');
  });
});
