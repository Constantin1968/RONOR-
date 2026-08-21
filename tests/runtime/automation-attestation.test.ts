import { attestAutomationAdapters, clearAutomationAttestations, currentAutomationAttestation } from '../../src/runtime/automation/attestation';

const env = {
  RONOR_LANGGRAPH_URL: 'https://graph.invalid', RONOR_LANGGRAPH_TOKEN: 'graph-token',
  RONOR_OPENHANDS_URL: 'https://hands.invalid', RONOR_OPENHANDS_TOKEN: 'hands-token',
  RONOR_CODEX_VERIFIER_URL: 'https://codex.invalid', RONOR_CODEX_VERIFIER_TOKEN: 'codex-token',
  RONOR_ASSURANCE_URL: 'https://assurance.invalid', RONOR_ASSURANCE_TOKEN: 'assurance-token',
  RONOR_EVIDENCE_RUNNER_URL: 'http://automation-evidence-runner:3005', RONOR_EVIDENCE_RUNNER_TOKEN: 'evidence-token',
};

describe('automation endpoint attestation', () => {
  beforeEach(() => clearAutomationAttestations());
  it('requires five independently authenticated compatible protocols', async () => {
    const declarations: Record<string, { protocol: string; service_id: string; capabilities: string[] }> = {
      'graph.invalid': { protocol: 'ronor-langgraph/v1', service_id: 'langgraph', capabilities: ['plan'] },
      'hands.invalid': { protocol: 'ronor-openhands-bridge/v1', service_id: 'openhands-bridge', capabilities: ['execute', 'cancel'] },
      'codex.invalid': { protocol: 'ronor-codex-verifier/v1', service_id: 'codex-verifier', capabilities: ['verify'] },
      'assurance.invalid': { protocol: 'ronor-assurance/v1', service_id: 'victoria-assurance', capabilities: ['assure'] },
      'automation-evidence-runner': { protocol: 'ronor-evidence-runner/v1', service_id: 'automation-evidence-runner', capabilities: ['git-evidence', 'allowlisted-tests'] },
    };
    const fetcher = jest.fn((url: string | URL | Request, init?: RequestInit) => {
      const target = new URL(String(url));
      expect(target.pathname).toBe('/health');
      expect(init?.redirect).toBe('error');
      expect((init?.headers as Record<string, string>).authorization).toMatch(/^Bearer /);
      const declaration = declarations[target.hostname];
      return Promise.resolve(new Response(JSON.stringify({ ok: true, protocol: declaration.protocol, service_id: declaration.service_id, capabilities: declaration.capabilities }), { status: 200 }));
    });
    const now = new Date('2026-08-20T12:00:00Z');
    const result = await attestAutomationAdapters(env, fetcher, { now: () => now, ttlMs: 10_000 });
    expect(result.verified).toEqual({ langgraph: 'verified', openhands: 'verified', codex: 'verified', assurance: 'verified', evidence: 'verified' });
    expect(currentAutomationAttestation(env, new Date('2026-08-20T12:00:09Z'))?.verified).toEqual(result.verified);
    expect(currentAutomationAttestation(env, new Date('2026-08-20T12:00:10Z'))).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(5);
  });

  it('fails closed on a protocol mismatch without probing later authorities', async () => {
    const fetcher = jest.fn(() => Promise.resolve(new Response(JSON.stringify({ ok: true, protocol: 'wrong/v1' }), { status: 200 })));
    await expect(attestAutomationAdapters(env, fetcher)).rejects.toThrow('attestation_langgraph_protocol_mismatch');
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('never accepts a missing service credential even on loopback', async () => {
    await expect(attestAutomationAdapters({ ...env, RONOR_LANGGRAPH_URL: 'http://127.0.0.1:2024', RONOR_LANGGRAPH_TOKEN: '' }, jest.fn())).rejects.toThrow('attestation_langgraph_not_configured');
  });

  it('attests the exact internal service host but refuses any other plaintext host', async () => {
    const internalEnv = { ...env, RONOR_LANGGRAPH_URL: 'http://langgraph:2024' };
    const fetcher = jest.fn((url: string | URL | Request) => {
      expect(String(url)).toBe('http://langgraph:2024/health');
      return Promise.resolve(new Response(JSON.stringify({ ok: true, protocol: 'wrong/v1' })));
    });
    await expect(attestAutomationAdapters(internalEnv, fetcher)).rejects.toThrow('attestation_langgraph_protocol_mismatch');
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(attestAutomationAdapters({ ...env, RONOR_LANGGRAPH_URL: 'http://other:2024' }, jest.fn())).rejects.toThrow('attestation_endpoint_invalid');
  });

  it('refuses a service identity or capability mismatch and caches no readiness', async () => {
    const fetcher = jest.fn(() => Promise.resolve(new Response(JSON.stringify({
      ok: true, protocol: 'ronor-langgraph/v1', service_id: 'openhands-bridge', capabilities: ['plan'],
    }), { status: 200 })));
    await expect(attestAutomationAdapters(env, fetcher)).rejects.toThrow('attestation_langgraph_protocol_mismatch');
    expect(currentAutomationAttestation(env)).toBeNull();
  });

  it('refuses an OpenHands bridge that cannot cancel active execution', async () => {
    const fetcher = jest.fn((url: string | URL | Request) => {
      const hostname = new URL(String(url)).hostname;
      const declarations: Record<string, [string, string, string[]]> = {
        'graph.invalid': ['ronor-langgraph/v1', 'langgraph', ['plan']],
        'hands.invalid': ['ronor-openhands-bridge/v1', 'openhands-bridge', ['execute']],
      };
      const [protocol, service_id, capabilities] = declarations[hostname];
      return Promise.resolve(new Response(JSON.stringify({ ok: true, protocol, service_id, capabilities })));
    });
    await expect(attestAutomationAdapters(env, fetcher)).rejects.toThrow('attestation_openhands_protocol_mismatch');
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
