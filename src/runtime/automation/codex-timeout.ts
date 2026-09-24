// Deadline for one independent Codex verification, shared by the verifier service
// (its model call) and the controller (its HTTP call to the verifier).
//
// Run run_58d01d6c7ca8f02729e5 on 24 September 2026 passed the agent and isolated
// verification for all three assignments, then lost the Codex stage at exactly
// 120 s: both sides used a fixed 120_000 ms and the reasoning model had not yet
// answered, so the verdict was lost and the call charged at its worst case.
//
// The deadline is now bounded configuration. The controller waits a fixed margin
// longer than the verifier, so the verifier's own timeout is reported as a
// classified verifier failure and not as a lost transport. The run's signed
// runtime ceiling still cancels both, whichever comes first.
export const CODEX_TIMEOUT_DEFAULT_MS = 600_000;
export const CODEX_TIMEOUT_MIN_MS = 30_000;
export const CODEX_TIMEOUT_MAX_MS = 900_000;
export const CODEX_CONTROLLER_MARGIN_MS = 15_000;

export function codexTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.RONOR_CODEX_TIMEOUT_MS;
  if (raw === undefined || raw.trim() === '') return CODEX_TIMEOUT_DEFAULT_MS;
  if (!/^[0-9]{1,7}$/.test(raw.trim())) throw new Error('codex_timeout_invalid');
  const value = Number(raw.trim());
  if (value < CODEX_TIMEOUT_MIN_MS || value > CODEX_TIMEOUT_MAX_MS) throw new Error('codex_timeout_invalid');
  return value;
}

export function codexControllerTimeoutFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  return codexTimeoutFromEnv(env) + CODEX_CONTROLLER_MARGIN_MS;
}
