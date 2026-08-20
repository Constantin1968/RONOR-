import { automationAdapterStatus, configuredAutomationAdapters } from '../../src/runtime/automation/adapter-registry';
import { AutomationAdapterError, createAssuranceAdapter, createCodexVerifierAdapter, createLangGraphAdapter, createOpenHandsAdapter } from '../../src/runtime/automation/adapters/http';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const mandate = { mandate_id: 'm1', mission_id: 'mission1' } as ExecutionMandate;

describe('live automation adapter boundary', () => {
  it('fails closed until enabled and all four independent endpoints are configured', () => {
    expect(automationAdapterStatus({}).ready).toBe(false);
    expect(configuredAutomationAdapters({ RONOR_AUTOMATION_ENABLED: 'true', RONOR_LANGGRAPH_URL: 'https://graph.invalid' })).toBeNull();
    const env = {
      RONOR_AUTOMATION_ENABLED: 'true',
      RONOR_LANGGRAPH_URL: 'https://graph.invalid', RONOR_LANGGRAPH_TOKEN: 'graph-token',
      RONOR_OPENHANDS_URL: 'https://hands.invalid', RONOR_OPENHANDS_TOKEN: 'hands-token',
      RONOR_CODEX_VERIFIER_URL: 'https://codex.invalid', RONOR_CODEX_VERIFIER_TOKEN: 'codex-token',
      RONOR_ASSURANCE_URL: 'https://assurance.invalid', RONOR_ASSURANCE_TOKEN: 'assurance-token',
      RONOR_AUTOMATION_CAPABILITY_KEY: 'k'.repeat(32),
    };
    expect(automationAdapterStatus(env).ready).toBe(true);
    expect(configuredAutomationAdapters(env)).not.toBeNull();
  });

  it('refuses aliased implementer, verifier and assurance identities', () => {
    const env = {
      RONOR_AUTOMATION_ENABLED: 'true', RONOR_AUTOMATION_CAPABILITY_KEY: 'k'.repeat(32),
      RONOR_LANGGRAPH_URL: 'https://graph.invalid', RONOR_LANGGRAPH_TOKEN: 'graph-token',
      RONOR_OPENHANDS_URL: 'https://shared.invalid', RONOR_OPENHANDS_TOKEN: 'hands-token',
      RONOR_CODEX_VERIFIER_URL: 'https://shared.invalid', RONOR_CODEX_VERIFIER_TOKEN: 'codex-token',
      RONOR_ASSURANCE_URL: 'https://assurance.invalid', RONOR_ASSURANCE_TOKEN: 'assurance-token',
    };
    expect(automationAdapterStatus(env).ready).toBe(false);
    expect(automationAdapterStatus(env).adapters.codex).toBe('identity-conflict');
  });

  it('refuses plaintext remote endpoints', async () => {
    const adapter = createLangGraphAdapter({ baseUrl: 'http://remote.invalid', fetcher: jest.fn() });
    await expect(adapter.plan('objective')).rejects.toThrow('adapter_url_requires_https_or_loopback');
  });

  it('requires authentication for remote services and disables redirects', async () => {
    const remote = createLangGraphAdapter({ baseUrl: 'https://graph.invalid', fetcher: jest.fn() });
    await expect(remote.plan('objective')).rejects.toThrow('adapter_auth_required');
    const fetcher = jest.fn(() => response({ assignments: [{ id: 'a1', instruction: 'read', actions: ['read_repo'] }] }));
    await createLangGraphAdapter({ baseUrl: 'https://graph.invalid', token: 'session-token', fetcher }).plan('objective');
    expect((fetcher.mock.calls as unknown[][])[0][1]).toMatchObject({ redirect: 'error' });
  });

  it('rejects unknown actions, duplicate ids and unbounded plans', async () => {
    const make = (assignments: unknown[]) => createLangGraphAdapter({
      baseUrl: 'http://127.0.0.1:2024', fetcher: jest.fn(() => response({ assignments })),
    });
    await expect(make([{ id: 'a', instruction: 'x', actions: ['shell_anything'] }]).plan('x')).rejects.toThrow('langgraph_action_invalid');
    await expect(make([{ id: 'a', instruction: 'x', actions: ['read_repo'] }, { id: 'a', instruction: 'y', actions: ['run_tests'] }]).plan('x')).rejects.toThrow('langgraph_assignment_invalid');
    await expect(make(Array.from({ length: 26 }, (_, i) => ({ id: `a${i}`, instruction: 'x', actions: ['read_repo'] }))).plan('x')).rejects.toThrow('langgraph_assignment_count_invalid');
  });

  it('rejects oversized adapter responses before parsing them', async () => {
    const oversized = 'x'.repeat(256 * 1024 + 1);
    const fetcher = jest.fn(() => Promise.resolve(new Response(oversized, { status: 200 })));
    await expect(createLangGraphAdapter({ baseUrl: 'http://127.0.0.1:2024', fetcher }).plan('x')).rejects.toThrow('adapter_response_too_large');
  });

  it('propagates cooperative cancellation distinctly from timeout', async () => {
    const fetcher = jest.fn((_url: URL | Request | string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();
    const pending = createLangGraphAdapter({ baseUrl: 'http://127.0.0.1:2024', fetcher, timeoutMs: 10_000 }).plan('objective', controller.signal);
    controller.abort();
    await expect(pending).rejects.toThrow('adapter_cancelled');
  });

  it('normalises valid LangGraph, OpenHands and Codex responses', async () => {
    const graphFetch = jest.fn(() => response({ assignments: [{ id: 'a1', instruction: 'edit safely', actions: ['read_repo', 'run_tests'] }] }));
    const graph = createLangGraphAdapter({ baseUrl: 'https://graph.invalid', token: 'session-token', fetcher: graphFetch });
    const assignments = await graph.plan('objective');
    expect(assignments[0].actions).toEqual(['read_repo', 'run_tests']);
    expect(graphFetch).toHaveBeenCalledTimes(1);

    const handsFetch = jest.fn(() => response({ ok: true, summary: 'done', evidence: ['diff'], cost_usd: 0.01 }));
    const hands = createOpenHandsAdapter({ baseUrl: 'http://127.0.0.1:3000', capabilityKey: 'k'.repeat(32), fetcher: handsFetch });
    await expect(hands.execute(assignments[0], mandate)).resolves.toMatchObject({ ok: true, evidence: ['diff'] });
    const request = handsFetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(request[1].headers).toHaveProperty('x-ronor-capability');
    expect(request[1].body).not.toContain('workspace_root');
    expect(request[1].body).not.toContain('mandate_id');

    const codexFetch = jest.fn(() => response({ ok: true, summary: 'verified', evidence: ['tests'], cost_usd: 0, verdict: 'pass' }));
    const codex = createCodexVerifierAdapter({ baseUrl: 'https://codex.invalid', token: 'session-token', fetcher: codexFetch });
    await expect(codex.verify('mission1', { claims: ['tests:pass'], artifacts: [] })).resolves.toMatchObject({ verdict: 'pass' });
    expect((codexFetch.mock.calls[0] as unknown as [URL, RequestInit])[1].body).toContain('"artifacts":[]');

    const assuranceFetch = jest.fn(() => response({ ok: true, summary: 'assured independently', evidence: ['policy:pass'], cost_usd: 0, verdict: 'pass' }));
    const assurance = createAssuranceAdapter({ baseUrl: 'https://assurance.invalid', token: 'assurance-token', fetcher: assuranceFetch });
    const codexVerdict = { ok: true, verdict: 'pass' as const, summary: 'verified', evidence: ['tests'], cost_usd: 0 };
    await expect(assurance.accept('mission1', codexVerdict, { claims: ['tests:pass'], artifacts: [] })).resolves.toMatchObject({ verdict: 'pass' });
    expect((assuranceFetch.mock.calls[0] as unknown as [URL, RequestInit])[0].pathname).toBe('/v1/assure');
  });

  it('rejects malformed results without leaking response bodies', async () => {
    const adapter = createOpenHandsAdapter({ baseUrl: 'https://hands.invalid', token: 'session-token', capabilityKey: 'k'.repeat(32), fetcher: jest.fn(() => response({ token: 'secret' })) });
    await expect(adapter.execute({ id: 'a', instruction: 'x', actions: [] }, mandate)).rejects.toBeInstanceOf(AutomationAdapterError);
  });

  it('normalises immutable artifact references and rejects invalid digests', async () => {
    const valid = createOpenHandsAdapter({
      baseUrl: 'http://127.0.0.1:3000', capabilityKey: 'k'.repeat(32),
      fetcher: jest.fn(() => response({ ok: true, summary: 'done', evidence: [], cost_usd: 0, artifacts: [
        { kind: 'git_diff', sha256: 'a'.repeat(64), reference: 'run/a1/diff.patch', bytes: 42 },
      ] })),
    });
    await expect(valid.execute({ id: 'a1', instruction: 'x', actions: ['read_repo'] }, mandate)).resolves.toMatchObject({ artifacts: [{ kind: 'git_diff', bytes: 42 }] });
    const invalid = createOpenHandsAdapter({
      baseUrl: 'http://127.0.0.1:3000', capabilityKey: 'k'.repeat(32),
      fetcher: jest.fn(() => response({ ok: true, summary: 'done', evidence: [], cost_usd: 0, artifacts: [
        { kind: 'git_diff', sha256: 'not-a-digest', reference: '../escape', bytes: 1 },
      ] })),
    });
    await expect(invalid.execute({ id: 'a1', instruction: 'x', actions: ['read_repo'] }, mandate)).rejects.toThrow('adapter_artifacts_invalid');
  });
});
