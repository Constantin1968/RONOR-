import { readBoundedVerificationJson } from './post-execution-verifier';

/** A cancelled or interrupted verification does not stop being dangerous the
 * moment its own promise settles: the evidence runner may still be finishing an
 * isolated test inside the worktree, and a model dispatch may still be in flight
 * with the provider. The admission barrier is therefore retained until the
 * signed deadline, which is safe but wasteful — a verification cancelled after
 * one second blocks the workspace for the rest of its mandate.
 *
 * This is the proof that lets the barrier be released early instead. It asks the
 * evidence runner whether it is still executing anything. That service already
 * refuses a second existing-commit verification with `evidence_runner_busy`, and
 * clears that flag only after its bounded test has actually terminated, so its
 * own answer is the authority on whether the worktree is quiet. There is no
 * inference and no timeout heuristic: an unreachable or ambiguous answer proves
 * nothing and leaves the barrier standing.
 */
export interface BarrierQuiescence {
  /** True only when the evidence runner positively reports itself idle. Never
   * throws; any doubt whatsoever returns false and the barrier is retained. */
  proveWorktreeIdle(signal?: AbortSignal): Promise<boolean>;
}

export function createBarrierQuiescence(config: {
  baseUrl?: string; token?: string; fetcher?: typeof fetch; timeoutMs?: number;
  expectedHost?: string;
}): BarrierQuiescence {
  const fetcher = config.fetcher ?? fetch;
  const expectedHost = config.expectedHost ?? 'automation-evidence-runner';
  let endpoint: URL | null = null;
  // A misconfigured endpoint disables the proof rather than sending a service
  // token to an unexpected host.
  try {
    const url = new URL(config.baseUrl!);
    if (url.protocol === 'http:' && url.hostname === expectedHost && url.pathname === '/' &&
        !url.username && !url.password && !url.search && !url.hash) endpoint = url;
  } catch { endpoint = null; }
  const token = config.token ?? '';
  return {
    async proveWorktreeIdle(signal) {
      if (!endpoint || Buffer.byteLength(token) < 32) return false;
      try {
        const timeout = AbortSignal.timeout(config.timeoutMs ?? 5000);
        const response = await fetcher(new URL('/health', endpoint), {
          method: 'GET', redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { authorization: `Bearer ${token}` },
        });
        if (!response.ok) return false;
        const body = await readBoundedVerificationJson(response, 4096) as Record<string, unknown>;
        // An older evidence runner does not report the field at all. Absence is
        // not idleness: it must say so explicitly.
        return body.ok === true && body.protocol === 'ronor-evidence-runner/v1' &&
          body.service_id === 'automation-evidence-runner' &&
          body.existing_verification_busy === false;
      } catch { return false; }
    },
  };
}
