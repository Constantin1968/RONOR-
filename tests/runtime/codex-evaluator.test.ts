import { createOpenAIResponsesCodexEvaluator } from '../../src/runtime/automation/services/codex-evaluator';
import type { VerifiedMaterial } from '../../src/runtime/automation/services/verification-authorities';

const material: VerifiedMaterial = { artifact: { kind: 'test_report', sha256: 'a'.repeat(64), reference: 'run/test.json', bytes: 15 }, content: '{"passed":true}' };
const response = (text: string, usage: unknown = { input_tokens: 1000, output_tokens: 100 }) => Promise.resolve(new Response(JSON.stringify({
  output: [{ type: 'message', content: [{ type: 'output_text', text }] }], usage,
}), { status: 200, headers: { 'content-type': 'application/json' } }));

describe('OpenAI Responses Codex evaluator', () => {
  it('uses strict structured output, no tools and no response storage', async () => {
    const fetcher = jest.fn(() => response(JSON.stringify({ verdict: 'pass', summary: 'verified', evidence: ['tests:pass'] })));
    const evaluator = createOpenAIResponsesCodexEvaluator({ apiKey: 'not-a-real-key', model: 'configured-codex-model', inputUsdPerMillionTokens: 2, outputUsdPerMillionTokens: 8, fetcher });
    const verdict = await evaluator.evaluate({ missionId: 'mission-1', claims: ['tests:pass'], materials: [material] });
    expect(verdict).toEqual({ verdict: 'pass', summary: 'verified', evidence: ['tests:pass'], cost_usd: 0.0028 });
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(url.href).toBe('https://api.openai.com/v1/responses'); expect(init.redirect).toBe('error');
    expect(body).toMatchObject({ model: 'configured-codex-model', store: false, tools: [], text: { format: { type: 'json_schema', strict: true } } });
    expect(JSON.stringify(body)).not.toContain('not-a-real-key');
  });

  it('fails closed when usage or structured output is missing', async () => {
    const missingUsage = createOpenAIResponsesCodexEvaluator({ apiKey: 'key', model: 'model', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, fetcher: jest.fn(() => response(JSON.stringify({ verdict: 'pass', summary: 'x', evidence: [] }), {})) });
    await expect(missingUsage.evaluate({ missionId: 'm1', claims: [], materials: [material] })).rejects.toThrow('codex_api_usage_missing');
    const invalid = createOpenAIResponsesCodexEvaluator({ apiKey: 'key', model: 'model', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, fetcher: jest.fn(() => response('{"verdict":"pass"}')) });
    await expect(invalid.evaluate({ missionId: 'm1', claims: [], materials: [material] })).rejects.toThrow('codex_api_output_invalid');
  });

  it('refuses oversized evidence instead of truncating verification context', async () => {
    const fetcher = jest.fn();
    const evaluator = createOpenAIResponsesCodexEvaluator({ apiKey: 'key', model: 'model', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, fetcher });
    await expect(evaluator.evaluate({ missionId: 'm1', claims: [], materials: [{ ...material, content: 'x'.repeat(400_001) }] })).rejects.toThrow('codex_evidence_context_too_large');
    expect(fetcher).not.toHaveBeenCalled();
  });
});
