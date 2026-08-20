import { automationAdapterStatus, configuredAutomationAdapters } from '../../src/runtime/automation/adapter-registry';
import { AutomationAdapterError, createCodexVerifierAdapter, createLangGraphAdapter, createOpenHandsAdapter } from '../../src/runtime/automation/adapters/http';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';

const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const mandate = { mandate_id: 'm1', mission_id: 'mission1' } as ExecutionMandate;

describe('live automation adapter boundary', () => {
  it('fails closed until enabled and all three endpoints are configured', () => {
    expect(automationAdapterStatus({}).ready).toBe(false);
    expect(configuredAutomationAdapters({ RONOR_AUTOMATION_ENABLED: 'true', RONOR_LANGGRAPH_URL: 'https://graph.invalid' })).toBeNull();
    const env = { RONOR_AUTOMATION_ENABLED: 'true', RONOR_LANGGRAPH_URL: 'https://graph.invalid', RONOR_OPENHANDS_URL: 'https://hands.invalid', RONOR_CODEX_VERIFIER_URL: 'https://codex.invalid' };
    expect(automationAdapterStatus(env).ready).toBe(true);
    expect(configuredAutomationAdapters(env)).not.toBeNull();
  });

  it('refuses plaintext remote endpoints', async () => {
    const adapter = createLangGraphAdapter({ baseUrl: 'http://remote.invalid', fetcher: jest.fn() });
    await expect(adapter.plan('objective')).rejects.toThrow('adapter_url_requires_https_or_loopback');
  });

  it('normalises valid LangGraph, OpenHands and Codex responses', async () => {
    const graphFetch = jest.fn(() => response({ assignments: [{ id: 'a1', instruction: 'edit safely', actions: ['read_repo', 'run_tests'] }] }));
    const graph = createLangGraphAdapter({ baseUrl: 'https://graph.invalid', fetcher: graphFetch });
    const assignments = await graph.plan('objective');
    expect(assignments[0].actions).toEqual(['read_repo', 'run_tests']);
    expect(graphFetch).toHaveBeenCalledTimes(1);

    const hands = createOpenHandsAdapter({ baseUrl: 'http://127.0.0.1:3000', fetcher: jest.fn(() => response({ ok: true, summary: 'done', evidence: ['diff'], cost_usd: 0.01 })) });
    await expect(hands.execute(assignments[0], mandate)).resolves.toMatchObject({ ok: true, evidence: ['diff'] });

    const codex = createCodexVerifierAdapter({ baseUrl: 'https://codex.invalid', fetcher: jest.fn(() => response({ ok: true, summary: 'verified', evidence: ['tests'], cost_usd: 0, verdict: 'pass' })) });
    await expect(codex.verify('mission1', ['diff'])).resolves.toMatchObject({ verdict: 'pass' });
  });

  it('rejects malformed results without leaking response bodies', async () => {
    const adapter = createOpenHandsAdapter({ baseUrl: 'https://hands.invalid', fetcher: jest.fn(() => response({ token: 'secret' })) });
    await expect(adapter.execute({ id: 'a', instruction: 'x', actions: [] }, mandate)).rejects.toBeInstanceOf(AutomationAdapterError);
  });
});
