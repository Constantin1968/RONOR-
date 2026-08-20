import { attestAutomationAdapters } from '../../src/runtime/automation/attestation';

const env = {
  RONOR_LANGGRAPH_URL: 'https://graph.invalid', RONOR_LANGGRAPH_TOKEN: 'graph-token',
  RONOR_OPENHANDS_URL: 'https://hands.invalid', RONOR_OPENHANDS_TOKEN: 'hands-token',
  RONOR_CODEX_VERIFIER_URL: 'https://codex.invalid', RONOR_CODEX_VERIFIER_TOKEN: 'codex-token',
  RONOR_ASSURANCE_URL: 'https://assurance.invalid', RONOR_ASSURANCE_TOKEN: 'assurance-token',
};

describe('automation endpoint attestation', () => {
  it('requires four independently authenticated compatible protocols', async () => {
    const protocols: Record<string, string> = {
      'graph.invalid': 'ronor-langgraph/v1', 'hands.invalid': 'ronor-openhands-bridge/v1',
      'codex.invalid': 'ronor-codex-verifier/v1', 'assurance.invalid': 'ronor-assurance/v1',
    };
    const fetcher = jest.fn((url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(target.pathname).toBe('/health');
      expect(init?.redirect).toBe('error');
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
      return Promise.resolve(new Response(JSON.stringify({ ok: true, protocol: protocols[target.hostname] }), { status: 200 }));
    });
    await expect(attestAutomationAdapters(env, fetcher)).resolves.toEqual({ langgraph: 'verified', openhands: 'verified', codex: 'verified', assurance: 'verified' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it('fails closed on a protocol mismatch without probing later authorities', async () => {
    const fetcher = jest.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, protocol: 'wrong/v1' }), { status: 200 })));
    await expect(attestAutomationAdapters(env, fetcher)).rejects.toThrow('attestation_langgraph_protocol_mismatch');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never accepts a missing service credential even on loopback', async () => {
    await expect(attestAutomationAdapters({ ...env, RONOR_LANGGRAPH_URL: 'http://127.0.0.1:2024', RONOR_LANGGRAPH_TOKEN: '' }, jest.fn())).rejects.toThrow('attestation_langgraph_not_configured');
  });
});
