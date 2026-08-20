import { automationAdapterStatus, configuredAutomationAdapters } from '../../src/runtime/automation/adapter-registry';
import { AutomationAdapterError, createCodexVerifierAdapter, createLangGraphAdapter, createOpenHandsAdapter } from '../../src/runtime/automation/adapters/http';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const mandate = { mandate_id: 'm1', mission_id: 'mission1' } as ExecutionMandate;

describe('live automation adapter boundary', () => {
  it('fails closed until enabled and all three endpoints are configured', () => {
    expect(automationAdapterStatus({}).ready).toBe(false);
    expect(configuredAutomationAdapters({ RONOR_AUTOMATION_ENABLED: 'true', RONOR_LANGGRAPH_URL: 'https://graph.invalid' })).toBeNull();
    const env = {
      RONOR_AUTOMATION_ENABLED: 'true',
      RONOR_LANGGRAPH_URL: 'https://graph.invalid', RONOR_LANGGRAPH_TOKEN: 'graph-token',
      RONOR_OPENHANDS_URL: 'https://hands.invalid', RONOR_OPENHANDS_TOKEN: 'hands-token',
      RONOR_CODEX_VERIFIER_URL: 'https://codex.invalid', RONOR_CODEX_VERIFIER_TOKEN: 'codex-token',
    };
    expect(automationAdapterStatus(env).ready).toBe(true);
    expect(configuredAutomationAdapters(env)).not.toBeNull();
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

  it('normalises valid LangGraph, OpenHands and Codex responses', async () => {
    const graphFetch = jest.fn(() => response({ assignments: [{ id: 'a1', instruction: 'edit safely', actions: ['read_repo', 'run_tests'] }] }));
    const graph = createLangGraphAdapter({ baseUrl: 'https://graph.invalid', token: 'session-token', fetcher: graphFetch });
    const assignments = await graph.plan('objective');
    expect(assignments[0].actions).toEqual(['read_repo', 'run_tests']);
    expect(graphFetch).toHaveBeenCalledTimes(1);

    const hands = createOpenHandsAdapter({ baseUrl: 'http://127.0.0.1:3000', fetcher: jest.fn(() => response({ ok: true, summary: 'done', evidence: ['diff'], cost_usd: 0.01 })) });
    await expect(hands.execute(assignments[0], mandate)).resolves.toMatchObject({ ok: true, evidence: ['diff'] });

    const codex = createCodexVerifierAdapter({ baseUrl: 'https://codex.invalid', token: 'session-token', fetcher: jest.fn(() => response({ ok: true, summary: 'verified', evidence: ['tests'], cost_usd: 0, verdict: 'pass' })) });
    await expect(codex.verify('mission1', ['diff'])).resolves.toMatchObject({ verdict: 'pass' });
  });

  it('rejects malformed results without leaking response bodies', async () => {
    const adapter = createOpenHandsAdapter({ baseUrl: 'https://hands.invalid', token: 'session-token', fetcher: jest.fn(() => response({ token: 'secret' })) });
    await expect(adapter.execute({ id: 'a', instruction: 'x', actions: [] }, mandate)).rejects.toBeInstanceOf(AutomationAdapterError);
  });
});
