import {
  CODEX_CONTROLLER_MARGIN_MS, CODEX_TIMEOUT_DEFAULT_MS, CODEX_TIMEOUT_MAX_MS, CODEX_TIMEOUT_MIN_MS,
  codexControllerTimeoutFromEnv, codexTimeoutFromEnv,
} from '../../src/runtime/automation/codex-timeout';

describe('Codex verification deadline', () => {
  it('defaults above the 120 s that lost run_58d01d6c7ca8f02729e5', () => {
    expect(codexTimeoutFromEnv({})).toBe(CODEX_TIMEOUT_DEFAULT_MS);
    expect(CODEX_TIMEOUT_DEFAULT_MS).toBeGreaterThan(120_000);
    expect(codexTimeoutFromEnv({ RONOR_CODEX_TIMEOUT_MS: '' })).toBe(CODEX_TIMEOUT_DEFAULT_MS);
  });

  it('accepts bounded values', () => {
    expect(codexTimeoutFromEnv({ RONOR_CODEX_TIMEOUT_MS: String(CODEX_TIMEOUT_MIN_MS) })).toBe(CODEX_TIMEOUT_MIN_MS);
    expect(codexTimeoutFromEnv({ RONOR_CODEX_TIMEOUT_MS: String(CODEX_TIMEOUT_MAX_MS) })).toBe(CODEX_TIMEOUT_MAX_MS);
  });

  it.each(['29999', '900001', '-1', '1e6', '600000ms', 'Infinity', '0x927c0', '12345678'])(
    'fails closed on an out-of-bound or malformed value (case %#)', value => {
      expect(() => codexTimeoutFromEnv({ RONOR_CODEX_TIMEOUT_MS: value })).toThrow('codex_timeout_invalid');
    });

  it('makes the controller wait longer than the verifier', () => {
    const env = { RONOR_CODEX_TIMEOUT_MS: '300000' };
    expect(codexControllerTimeoutFromEnv(env)).toBe(300_000 + CODEX_CONTROLLER_MARGIN_MS);
    expect(codexControllerTimeoutFromEnv(env)).toBeGreaterThan(codexTimeoutFromEnv(env));
  });
});
