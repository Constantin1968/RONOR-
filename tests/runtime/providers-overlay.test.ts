import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { AUTHOR_RATE_CARD, MODEL_RATE_CARD_SET, VERIFIER_RATE_CARD } from '../../src/runtime/automation/model-budget';

type Service = { environment?: Record<string, string>; secrets?: string[] };
const overlay = load(readFileSync(join(process.cwd(), 'docker-compose.development-providers.yml'), 'utf8')) as {
  services: Record<string, Service>; secrets: Record<string, { file: string }> };

describe('provider overlay: one provider per role', () => {
  it('pins every budgeted service to the same pair of rate cards', () => {
    for (const name of ['openhands-bridge', 'codex-verifier', 'model-egress-proxy'])
      expect(overlay.services[name].environment?.RONOR_MODEL_RATE_CARD).toBe(MODEL_RATE_CARD_SET);
  });
  it('puts the author on Anthropic and the verifier on OpenAI, at the catalog prices of their cards', () => {
    expect(overlay.services['openhands-agent'].environment?.LLM_MODEL).toBe(`openai/${AUTHOR_RATE_CARD.model}`);
    expect(overlay.services['openhands-bridge'].environment?.RONOR_OPENHANDS_LLM_MODEL).toBe(`openai/${AUTHOR_RATE_CARD.model}`);
    const verifier = overlay.services['codex-verifier'].environment!;
    expect(verifier.RONOR_CODEX_MODEL).toBe(VERIFIER_RATE_CARD.model);
    expect(Number(verifier.RONOR_CODEX_INPUT_USD_PER_MTOK)).toBe(VERIFIER_RATE_CARD.inputMicroUsd);
    expect(Number(verifier.RONOR_CODEX_OUTPUT_USD_PER_MTOK)).toBe(VERIFIER_RATE_CARD.outputMicroUsd);
    const proxy = overlay.services['model-egress-proxy'].environment!;
    expect(new URL(proxy.RONOR_MODEL_AUTHOR_BASE_URL).hostname).toBe(AUTHOR_RATE_CARD.host);
    expect(new URL(proxy.RONOR_MODEL_VERIFIER_BASE_URL).hostname).toBe(VERIFIER_RATE_CARD.host);
  });
  it('gives each provider its own secret file and never inlines a credential', () => {
    expect(overlay.services['model-egress-proxy'].secrets).toEqual(['model_author_upstream_token', 'model_verifier_upstream_token']);
    expect(overlay.secrets.model_author_upstream_token.file).not.toBe(overlay.secrets.model_verifier_upstream_token.file);
    expect(JSON.stringify(overlay)).not.toMatch(/sk-|api_key=|Bearer /);
  });
});
