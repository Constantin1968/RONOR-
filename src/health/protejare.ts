/**
 * RONOR — L0 · Sănătate · Protejarea căii de sănătate
 * ───────────────────────────────────────────────────
 *
 * Two guards, extracted so they are TESTABLE rather than merely present.
 *
 * The fault they answer is specific. `/health` composes its answer from the
 * orchestrator, the sentinel plane and — since the mirroring work — a
 * synchronous read of the local audit chain. An exception anywhere in that
 * composition, inside an `async` Express handler, produces an unhandled
 * rejection and NO RESPONSE: the container probe waits, times out, and the
 * orchestrator restarts a runtime that was answering every other route
 * correctly. The outage is then manufactured entirely by the health check.
 *
 * The rule adopted here: a failure to DESCRIBE the runtime is reported as a
 * degradation with its reason, never as a thrown error and never as silence.
 * Being unable to measure is not the same as being unhealthy, and neither is it
 * the same as being healthy — so it is stated.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

/**
 * Run a health composition and convert any fault into a stated degradation.
 *
 * `laEroare` receives the reason and returns the body to send. The caller keeps
 * control of the shape of that body; this function only guarantees that one is
 * always produced.
 */
export async function compuneSauDegradat<T>(
  compune: () => Promise<T>,
  laEroare: (motiv: string) => T,
): Promise<T> {
  try {
    return await compune();
  } catch (err) {
    return laEroare(err instanceof Error ? err.message : String(err));
  }
}

/**
 * Read one measurement, or report that it could not be read.
 *
 * Returns `undefined` on failure rather than a plausible number: a fabricated
 * zero for the local chain length would be read as an empty chain, which is a
 * claim about the audit trail that a failed read cannot support. `laEroare` is
 * invoked so the fault is logged rather than swallowed.
 */
export function masoaraSauNecunoscut<T>(
  masoara: () => T,
  laEroare?: (motiv: string) => void,
): T | undefined {
  try {
    return masoara();
  } catch (err) {
    laEroare?.(err instanceof Error ? err.message : String(err));
    return undefined;
  }
}
