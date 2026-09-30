import { codexUsageDiagnostic, createOpenAIResponsesCodexEvaluator, parseVerdictText } from '../../src/runtime/automation/services/codex-evaluator';

const ok = { verdict: 'pass', summary: 'ok', evidence: ['tests:pass'] };
const reply = (body: Record<string, unknown>) => jest.fn(() => Promise.resolve(new Response(JSON.stringify({
  usage: { input_tokens: 1000, output_tokens: 100 }, ...body,
}), { status: 200, headers: { 'content-type': 'application/json' } })));
const make = (fetcher: jest.Mock) => createOpenAIResponsesCodexEvaluator({
  apiKey: 'fixture-key', model: 'qwen3.8-max', inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 1, fetcher,
});
const msg = (text: string) => [{ type: 'message', content: [{ type: 'output_text', text }] }];

describe('Codex verdict parsing (run_2cf9b7123d32b93f4d91, 30.09.2026)', () => {
  it('accepts exactly one fenced JSON block and nothing around it', async () => {
    for (const text of ['```json\n' + JSON.stringify(ok) + '\n```', '```\n' + JSON.stringify(ok) + '\n```', '  ```JSON\r\n' + JSON.stringify(ok) + '\r\n```\n']) {
      expect(parseVerdictText(text)).toEqual(ok);
      await expect(make(reply({ output: msg(text) })).evaluate({ missionId: 'm', claims: [], materials: [] }))
        .resolves.toMatchObject({ verdict: 'pass', evidence: ['tests:pass'] });
    }
  });

  it('keeps the exact object contract inside the fence', async () => {
    const text = '```json\n' + JSON.stringify({ ...ok, extra: 1 }) + '\n```';
    await expect(make(reply({ output: msg(text) })).evaluate({ missionId: 'm', claims: [], materials: [] }))
      .rejects.toThrow('codex_api_output_invalid');
  });

  it('asks for 32768 output tokens', async () => {
    const f = reply({ output: msg(JSON.stringify(ok)) });
    await make(f).evaluate({ missionId: 'm', claims: [], materials: [] });
    const [, init] = f.mock.calls[0] as unknown as [URL, RequestInit];
    expect(JSON.parse(String(init.body)).max_output_tokens).toBe(32768);
  });

  it('names a verdict cut by the output budget without echoing its content', async () => {
    const partial = '{"verdict":"pass","summary":"SECRET-FRAGMENT';
    const run = make(reply({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: msg(partial) }))
      .evaluate({ missionId: 'm', claims: [], materials: [] });
    await expect(run).rejects.toThrow('codex_api_output_truncated');
    await expect(run).rejects.not.toThrow('SECRET-FRAGMENT');
  });

  it('keeps not_json for complete responses that are not JSON', async () => {
    await expect(make(reply({ status: 'completed', output: msg('PASS') })).evaluate({ missionId: 'm', claims: [], materials: [] }))
      .rejects.toThrow('codex_api_output_not_json');
  });

  it('logs usage and reasoning tokens without any model text', () => {
    const line = codexUsageDiagnostic({ status: 'incomplete', usage: { input_tokens: 9000, output_tokens: 8192,
      output_tokens_details: { reasoning_tokens: 8000 } }, output: msg('SECRET-FRAGMENT') }, 15);
    expect(JSON.parse(line)).toEqual({ event: 'codex_usage', status: 'incomplete', max_output_tokens: 32768,
      input_tokens: 9000, output_tokens: 8192, reasoning_tokens: 8000, text_chars: 15 });
    expect(line).not.toContain('SECRET');
    expect(JSON.parse(codexUsageDiagnostic({ status: 'x y<script>', usage: 'bad' }, null))).toMatchObject({ status: null, reasoning_tokens: null });
  });
});
