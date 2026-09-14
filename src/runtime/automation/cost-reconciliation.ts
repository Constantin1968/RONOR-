import { MODEL_RATE_CARD, signBudgetQuery } from './model-budget';
import { readBoundedVerificationJson } from './post-execution-verifier';

/** An observed cost is what the egress proxy actually settled with the provider
 * for one budget. It is deliberately kept apart from the reported cost, which a
 * verifier states about itself: a run that ended without reporting anything —
 * interrupted, cancelled, deadline exceeded — still spent money, and the ledger
 * is the only party that saw it. This is still catalogue arithmetic over provider
 * usage counters, not an invoice.
 */
export interface ObservedCost {
  observed_cost_usd: number;
  observed_cost_basis: 'egress-ledger-settled';
  settled_reservations: number;
  /** A dispatch whose outcome the proxy never saw. Its cost is not yet in the
   * settled sum, so the observed figure is a floor, not a total. */
  unresolved_dispatches: number;
  budget_frozen: boolean;
}

export interface CostReconciler {
  /** Best-effort: returns null when accounting is not configured, the budget is
   * unknown, or the proxy cannot be read. Never throws, never retries a write. */
  observe(budgetId: string, signal?: AbortSignal): Promise<ObservedCost | null>;
}

const MICRO_USD = 1_000_000;

export function createCostReconciler(config: {
  baseUrl?: string; key?: string; fetcher?: typeof fetch; timeoutMs?: number;
  expectedHost?: string;
}): CostReconciler {
  const fetcher = config.fetcher ?? fetch;
  const expectedHost = config.expectedHost ?? 'model-egress-proxy';
  let endpoint: URL | null = null;
  // A misconfigured endpoint disables observation instead of reaching an
  // unexpected host: this call carries a capability-derived signature.
  try {
    const url = new URL(config.baseUrl!);
    if (url.protocol === 'http:' && url.hostname === expectedHost && url.pathname === '/' &&
        !url.username && !url.password && !url.search && !url.hash) endpoint = url;
  } catch { endpoint = null; }
  const key = config.key ?? '';
  return {
    async observe(budgetId, signal) {
      if (!endpoint || Buffer.byteLength(key) < 32) return null;
      let token: string;
      try { token = signBudgetQuery(budgetId, key); } catch { return null; }
      try {
        const timeout = AbortSignal.timeout(config.timeoutMs ?? 5000);
        const response = await fetcher(new URL(`/budget/${encodeURIComponent(budgetId)}`, endpoint), {
          method: 'GET', redirect: 'error',
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
          headers: { 'x-ronor-budget-query': token },
        });
        if (!response.ok) return null;
        const body = await readBoundedVerificationJson(response, 4096) as Record<string, unknown>;
        if (body.ok !== true || body.protocol !== 'ronor-model-egress/v1' ||
            body.rate_card !== MODEL_RATE_CARD.id || body.budget_id !== budgetId) return null;
        const settled = body.settled_micro_usd;
        const settledCount = body.settled_reservations;
        const pending = body.pending_reservations;
        if (!Number.isSafeInteger(settled) || (settled as number) < 0 ||
            !Number.isSafeInteger(settledCount) || !Number.isSafeInteger(pending) ||
            typeof body.frozen !== 'boolean') return null;
        return {
          observed_cost_usd: (settled as number) / MICRO_USD,
          observed_cost_basis: 'egress-ledger-settled',
          settled_reservations: settledCount as number,
          unresolved_dispatches: pending as number,
          budget_frozen: body.frozen,
        };
      } catch { return null; }
    },
  };
}
