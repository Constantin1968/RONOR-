/**
 * Adaptive event pages (host evidence, 29.09.2026, run_f9dfe522b45f5adb4f4d): one
 * 100-event page carrying whole file observations exceeded the 256 KiB response
 * bound and ended the run with openhands_response_too_large. The page now shrinks;
 * the byte bound per response does not change.
 */
import { createNativeOpenHandsClient } from '../../src/runtime/automation/adapters/openhands-native';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const id = '11111111-1111-4111-8111-111111111111';
const envelope: OpenHandsExecutionEnvelope = {
  assignment_id: 'task-1', instruction: 'Run the declared tests only.',
  allowed_actions: ['read_repo', 'run_tests'], objective_hash: 'a'.repeat(64),
  deadline: '2099-01-01T00:00:00Z',
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const big = 'x'.repeat(300 * 1024);

describe('OpenHands adaptive event pages', () => {
  it('shrinks an oversized pending page and still evaluates the action', async () => {
    const limits: string[] = [];
    let accepted: boolean | undefined;
    const fetcher = jest.fn().mockImplementation((input: URL, init: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === '/api/conversations') return json({ id });
      if (url.pathname.endsWith('/events/respond_to_confirmation')) { accepted = JSON.parse(String(init.body)).accept; return json({ ok: true }); }
      if (url.pathname.endsWith('/events')) return json({ accepted: true });
      if (url.pathname.endsWith('/events/search')) {
        const limit = url.searchParams.get('limit') ?? '';
        limits.push(limit);
        if (Number(limit) > 25) return json({ items: [{ id: 'filler', kind: 'MessageEvent', text: big }] });
        return json({ items: [{ id: 'pending-now', kind: 'ActionEvent', action: { command: 'git status' } }] });
      }
      if (url.pathname.endsWith('/pause')) return json({ ok: true });
      return json(accepted === undefined
        ? { execution_status: 'waiting_for_confirmation', leaf_event_id: 'pending-now', cost_usd: 0.1 }
        : { execution_status: 'error', cost_usd: 0.1 });
    });
    const result = await createNativeOpenHandsClient({ pauseConfirmWindowMs: 0, pollIntervalMs: 0, baseUrl: 'https://hands.invalid', sessionApiKey: 'test', fetcher }).execute(envelope);
    expect(limits.slice(0, 3)).toEqual(['100', '50', '25']);
    expect(accepted).toBe(true);
    expect(result.summary).not.toBe('openhands_response_too_large');
  });

  it('still fails closed when even the smallest page exceeds the bound', async () => {
    const limits: string[] = [];
    const fetcher = jest.fn().mockImplementation((input: URL) => {
      const url = new URL(input);
      if (url.pathname === '/api/conversations') return json({ id });
      if (url.pathname.endsWith('/events/respond_to_confirmation')) return json({ ok: true });
      if (url.pathname.endsWith('/events')) return json({ accepted: true });
      if (url.pathname.endsWith('/events/search')) { limits.push(url.searchParams.get('limit') ?? ''); return json({ items: [{ id: 'filler', kind: 'MessageEvent', text: big }] }); }
      if (url.pathname.endsWith('/pause')) return json({ ok: true });
      return json({ execution_status: 'waiting_for_confirmation', leaf_event_id: 'pending-now', cost_usd: 0.1 });
    });
    const result = await createNativeOpenHandsClient({ pauseConfirmWindowMs: 0, pollIntervalMs: 0, baseUrl: 'https://hands.invalid', sessionApiKey: 'test', fetcher }).execute(envelope);
    expect(limits.slice(0, 4)).toEqual(['100', '50', '25', '10']);
    expect(result).toMatchObject({ ok: false, summary: 'openhands_response_too_large' });
    expect(fetcher.mock.calls.some(([url]) => new URL(url).pathname.endsWith('/events/respond_to_confirmation'))).toBe(false);
  });

  it('never shrinks on an error other than an oversized response', async () => {
    const limits: string[] = [];
    const fetcher = jest.fn().mockImplementation((input: URL) => {
      const url = new URL(input);
      if (url.pathname === '/api/conversations') return json({ id });
      if (url.pathname.endsWith('/events')) return json({ accepted: true });
      if (url.pathname.endsWith('/events/search')) { limits.push(url.searchParams.get('limit') ?? ''); return Promise.resolve(new Response('no', { status: 500 })); }
      if (url.pathname.endsWith('/pause')) return json({ ok: true });
      return json({ execution_status: 'waiting_for_confirmation', leaf_event_id: 'pending-now', cost_usd: 0.1 });
    });
    const result = await createNativeOpenHandsClient({ pauseConfirmWindowMs: 0, pollIntervalMs: 0, baseUrl: 'https://hands.invalid', sessionApiKey: 'test', fetcher }).execute(envelope);
    expect(limits).toEqual(['100']);
    expect(result.ok).toBe(false);
  });
});
