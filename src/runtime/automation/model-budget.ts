import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import type { ExecutionMandate } from './contracts';

// Catalog accounting, NOT an invoice. Cache/promotion discounts are deliberately
// not credited to the execution budget. No explicit-cache creation is admitted.
// https://www.alibabacloud.com/help/en/model-studio/qwen3-8-max
export const MODEL_RATE_CARD = {
  id: 'dashscope-intl-qwen3.8-max-20260902',
  model: 'qwen3.8-max', inputMicroUsd: 2, outputMicroUsd: 6,
} as const;
export interface ModelBudgetContext { run_id: string; accounted_cost_usd: number; }
export interface ModelBudgetClaims {
  audience: 'ronor-model-egress/v1'; budget_id: string; mission_id: string;
  role: 'author' | 'verifier'; ceiling_micro_usd: number; prior_micro_usd: number;
  expires_at: string; rate_card: typeof MODEL_RATE_CARD.id;
}
export class ModelBudgetError extends Error {}

/** Read-only settlement report for one budget. `settled_micro_usd` is the sum of
 * the amounts actually charged by the provider, which is what an interrupted run
 * really cost; it is not the reserved worst case and not an invoice. */
export interface BudgetSettlement {
  budget_id: string; settled_micro_usd: number; settled_reservations: number;
  pending_reservations: number; outstanding_micro_usd: number; frozen: boolean;
}
const BUDGET_QUERY_DOMAIN = 'ronor-budget-query/v1:';
/** Authorises a read-only settlement query. Deliberately not the dispatch token:
 * a settlement is read after the mandate has expired, when a dispatch token is
 * already worthless, and it must never admit a request to a provider. */
export function signBudgetQuery(budgetId: string, key: string): string {
  if (Buffer.byteLength(key) < 32 || !safeId(budgetId)) throw new ModelBudgetError('budget_query_invalid');
  return crypto.createHmac('sha256', key).update(`${BUDGET_QUERY_DOMAIN}${budgetId}`).digest('base64url');
}
export function verifyBudgetQuery(token: string, budgetId: string, key: string): boolean {
  try {
    if (typeof token !== 'string' || token.length > 256) return false;
    const expected = Buffer.from(signBudgetQuery(budgetId, key), 'base64url');
    const actual = Buffer.from(token, 'base64url');
    return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
  } catch { return false; }
}
const safeId = (v: unknown): v is string => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$/.test(v);
const integer = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

export function signModelBudget(mandate: ExecutionMandate, context: ModelBudgetContext,
  role: ModelBudgetClaims['role'], key: string): string {
  if (Buffer.byteLength(key) < 32 || !safeId(context.run_id) || !safeId(mandate.mission_id) ||
      !Number.isFinite(context.accounted_cost_usd) || context.accounted_cost_usd < 0 ||
      !Number.isFinite(mandate.max_cost_usd) || mandate.max_cost_usd <= 0) throw new ModelBudgetError('budget_claims_invalid');
  const claims: ModelBudgetClaims = { audience: 'ronor-model-egress/v1', budget_id: context.run_id,
    mission_id: mandate.mission_id, role, ceiling_micro_usd: Math.floor(mandate.max_cost_usd * 1e6),
    prior_micro_usd: Math.ceil(context.accounted_cost_usd * 1e6), expires_at: mandate.expires_at,
    rate_card: MODEL_RATE_CARD.id };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${crypto.createHmac('sha256', key).update(payload).digest('base64url')}`;
}
export function verifyModelBudget(token: string, key: string, now = Date.now()): ModelBudgetClaims | null {
  try {
    if (Buffer.byteLength(key) < 32 || token.length > 4096) return null;
    const [payload, signature, extra] = token.split('.');
    if (!payload || !signature || extra) return null;
    const expected = crypto.createHmac('sha256', key).update(payload).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return null;
    const v = JSON.parse(Buffer.from(payload, 'base64url').toString()) as ModelBudgetClaims;
    if (v.audience !== 'ronor-model-egress/v1' || !safeId(v.budget_id) || !safeId(v.mission_id) ||
        !['author','verifier'].includes(v.role) || v.rate_card !== MODEL_RATE_CARD.id ||
        !integer(v.ceiling_micro_usd) || !v.ceiling_micro_usd || !integer(v.prior_micro_usd) ||
        v.prior_micro_usd >= v.ceiling_micro_usd || !Number.isFinite(Date.parse(v.expires_at)) ||
        Date.parse(v.expires_at) <= now) return null;
    return v;
  } catch { return null; }
}

/** Upper bound on dispatches that may be in flight against one budget at the same
 * time. Concurrency is admitted, unbounded concurrency is not: every outstanding
 * dispatch holds its worst-case amount against the ceiling until it settles. */
export const MAX_CONCURRENT_DISPATCH = 16;

/** Durable integer accounting. An unresolved dispatch is never released by restart,
 * timeout, retry or by replaying a signed token carrying an older subtotal.
 *
 * An *unresolved* dispatch is one whose outcome is unknown (`settle(_, null)`),
 * which freezes the budget permanently. That is not the same as an *outstanding*
 * dispatch, which is simply in flight: its worst-case amount is held against the
 * ceiling from the moment it is reserved, so several may be outstanding at once
 * without any possibility of exceeding the ceiling. */
export class ModelBudgetLedger {
  private readonly db: Database.Database;
  constructor(filename: string) {
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_budgets (
        id TEXT PRIMARY KEY, mission TEXT NOT NULL, ceiling INTEGER NOT NULL,
        spent INTEGER NOT NULL, frozen INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS model_reservations (
        id TEXT PRIMARY KEY, budget TEXT NOT NULL, amount INTEGER NOT NULL,
        state TEXT NOT NULL, actual INTEGER);`);
  }
  reserve(claims: ModelBudgetClaims, amount: number): string {
    if (!integer(amount) || amount < 1 || Date.parse(claims.expires_at) <= Date.now()) throw new ModelBudgetError('budget_reservation_invalid');
    return this.db.transaction(() => {
      this.db.prepare('INSERT OR IGNORE INTO model_budgets(id,mission,ceiling,spent) VALUES(?,?,?,?)')
        .run(claims.budget_id, claims.mission_id, claims.ceiling_micro_usd, claims.prior_micro_usd);
      const row = this.snapshot(claims.budget_id)!;
      if (row.mission !== claims.mission_id || row.ceiling !== claims.ceiling_micro_usd) throw new ModelBudgetError('budget_identity_mismatch');
      if (row.frozen) throw new ModelBudgetError('budget_unresolved_dispatch');
      if (row.pending >= MAX_CONCURRENT_DISPATCH) throw new ModelBudgetError('budget_dispatch_concurrency_exceeded');
      const spent = Math.max(row.spent, claims.prior_micro_usd);
      // Outstanding worst cases are held against the ceiling, so concurrent
      // dispatches can never collectively overspend it.
      if (spent + row.outstanding + amount > row.ceiling) throw new ModelBudgetError('budget_insufficient_before_dispatch');
      this.db.prepare('UPDATE model_budgets SET spent=? WHERE id=?').run(spent, claims.budget_id);
      const id = crypto.randomUUID();
      this.db.prepare("INSERT INTO model_reservations(id,budget,amount,state) VALUES(?,?,?,'pending')").run(id, claims.budget_id, amount);
      return id;
    }).immediate();
  }
  settle(reservation: string, actual: number | null): void {
    if (actual !== null && !integer(actual)) throw new ModelBudgetError('budget_usage_invalid');
    this.db.transaction(() => {
      const row = this.db.prepare('SELECT * FROM model_reservations WHERE id=?').get(reservation) as {
        budget: string; amount: number; state: string;
      } | undefined;
      if (!row || row.state !== 'pending') throw new ModelBudgetError('budget_settlement_invalid');
      if (actual === null) {
        this.db.prepare('UPDATE model_budgets SET frozen=1 WHERE id=?').run(row.budget);
        return; // Reservation and liability remain durable.
      }
      this.db.prepare("UPDATE model_reservations SET state='settled',actual=? WHERE id=?").run(actual, reservation);
      this.db.prepare('UPDATE model_budgets SET spent=spent+?, frozen=MAX(frozen,?) WHERE id=?')
        .run(actual, actual > row.amount ? 1 : 0, row.budget);
    }).immediate();
  }
  snapshot(id: string): { mission: string; ceiling: number; spent: number; frozen: number; pending: number; outstanding: number } | null {
    return this.db.prepare(`SELECT mission,ceiling,spent,frozen,
      (SELECT COUNT(*) FROM model_reservations r WHERE r.budget=b.id AND r.state='pending') AS pending,
      (SELECT COALESCE(SUM(amount),0) FROM model_reservations r WHERE r.budget=b.id AND r.state='pending') AS outstanding
      FROM model_budgets b WHERE id=?`).get(id) as ReturnType<ModelBudgetLedger['snapshot']> ?? null;
  }
  /** Settled reality for one budget, or null when the budget is unknown. Reading
   * never changes accounting: an unresolved dispatch stays frozen and unreported. */
  settlement(id: string): BudgetSettlement | null {
    if (!safeId(id)) return null;
    const budget = this.db.prepare('SELECT frozen FROM model_budgets WHERE id=?').get(id) as { frozen: number } | undefined;
    if (!budget) return null;
    const settled = this.db.prepare(
      "SELECT COALESCE(SUM(actual),0) AS total, COUNT(*) AS count FROM model_reservations WHERE budget=? AND state='settled'")
      .get(id) as { total: number; count: number };
    const pending = this.db.prepare(
      "SELECT COALESCE(SUM(amount),0) AS total, COUNT(*) AS count FROM model_reservations WHERE budget=? AND state='pending'")
      .get(id) as { total: number; count: number };
    return { budget_id: id, settled_micro_usd: settled.total, settled_reservations: settled.count,
      pending_reservations: pending.count, outstanding_micro_usd: pending.total, frozen: budget.frozen === 1 };
  }
  close(): void { this.db.close(); }
}

/** Prompt-cache marker emitted by the OpenHands SDK (1.42.1) both inside a text
 * block and, for tool results, at message level. It carries no content and no
 * capability; admitting it does not widen what may be sent to the provider. */
function ephemeralCacheControl(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 1 && (value as Record<string, unknown>).type === 'ephemeral';
}
/** Anthropic extended-thinking blocks the SDK replays on assistant turns.
 * Text and signature only: no images, no tool payloads, no remote references. */
function thinkingBlocksOnly(value: unknown): boolean {
  if (!Array.isArray(value) || !value.length) return false;
  return value.every((block) => {
    if (!block || typeof block !== 'object' || Array.isArray(block)) return false;
    const b = block as Record<string, unknown>;
    if (b.type === 'thinking')
      return typeof b.thinking === 'string' &&
        (b.signature === undefined || b.signature === null || typeof b.signature === 'string') &&
        Object.keys(b).every(k => ['type', 'thinking', 'signature'].includes(k));
    if (b.type === 'redacted_thinking')
      return typeof b.data === 'string' && Object.keys(b).every(k => ['type', 'data'].includes(k));
    return false;
  });
}
function textContentBlock(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const c = value as Record<string, unknown>;
  if (c.type !== 'text' || typeof c.text !== 'string') return false;
  if (!Object.keys(c).every(k => ['type', 'text', 'cache_control'].includes(k))) return false;
  return !('cache_control' in c) || ephemeralCacheControl(c.cache_control);
}

export interface ReservedModelRequest { payload: Record<string, unknown>; inputBound: number; outputBound: number; reserveMicroUsd: number; }
/** Text-only conservative reservation, not a claim of exact tokenization.
 * JSON bytes plus a deliberately generous template allowance bound admitted
 * application payloads. Any provider overrun is recorded and freezes the budget.
 * A provider-side billing cap is still needed for an unconditional invoice cap. */
export function reserveModelRequest(path: string, body: Buffer): ReservedModelRequest {
  let payload: Record<string, unknown>;
  try { payload = JSON.parse(body.toString()); } catch { throw new ModelBudgetError('budget_payload_invalid'); }
  if (!payload || Array.isArray(payload) || payload.model !== MODEL_RATE_CARD.model ||
      payload.stream === true || payload.previous_response_id || payload.conversation ||
      payload.background === true || payload.n !== undefined && payload.n !== 1)
    throw new ModelBudgetError('budget_payload_unsupported');
  const allowed = path === '/v1/chat/completions'
    ? ['model','messages','tools','tool_choice','parallel_tool_calls','max_tokens','max_completion_tokens','stream','temperature','top_p','stop','presence_penalty','frequency_penalty','seed','n','enable_thinking','reasoning_effort','response_format']
    : ['model','input','instructions','tools','store','text','max_output_tokens','stream','temperature','top_p','reasoning','enable_thinking'];
  if (Object.keys(payload).some(k => !allowed.includes(k))) throw new ModelBudgetError('budget_payload_unsupported');
  const tools = Array.isArray(payload.tools) ? payload.tools : [];
  const toolKeys = path === '/v1/chat/completions' ? ['type','function'] : ['type','name','description','parameters','strict'];
  if (tools.some(t => !t || typeof t !== 'object' || (t as Record<string,unknown>).type !== 'function' ||
      Object.keys(t).some(k=>!toolKeys.includes(k)))) throw new ModelBudgetError('budget_remote_tool_refused');
  let messages = 1;
  if (path === '/v1/chat/completions') {
    if (!Array.isArray(payload.messages) || !payload.messages.length) throw new ModelBudgetError('budget_payload_invalid');
    messages = payload.messages.length;
    for (const m of payload.messages) {
      if (!m || typeof m !== 'object') throw new ModelBudgetError('budget_payload_invalid');
      const message = m as Record<string, unknown>;
      if (Object.keys(message).some(k=>!['role','content','tool_calls','tool_call_id','name','reasoning_content','function_call','cache_control','thinking_blocks'].includes(k)))
        throw new ModelBudgetError('budget_message_unsupported');
      if ('cache_control' in message && !ephemeralCacheControl(message.cache_control))
        throw new ModelBudgetError('budget_message_unsupported');
      if ('thinking_blocks' in message && !thinkingBlocksOnly(message.thinking_blocks))
        throw new ModelBudgetError('budget_message_unsupported');
      const content = message.content;
      // An assistant tool-call turn legitimately omits content (SDK drops empty text).
      if (content === undefined) {
        if (!Array.isArray(message.tool_calls) || !message.tool_calls.length)
          throw new ModelBudgetError('budget_nontext_refused');
        continue;
      }
      if (!(content === null || typeof content === 'string' ||
        Array.isArray(content) && content.every(textContentBlock))) throw new ModelBudgetError('budget_nontext_refused');
    }
  } else if (typeof payload.input !== 'string') throw new ModelBudgetError('budget_nontext_refused');
  const outputField = path === '/v1/chat/completions' ? 'max_tokens' : 'max_output_tokens';
  const requested = payload[outputField] ?? payload.max_completion_tokens ?? 4096;
  if (!integer(requested) || requested < 1) throw new ModelBudgetError('budget_output_limit_invalid');
  const outputBound = Math.min(requested, 4096);
  delete payload.max_completion_tokens;
  payload[outputField] = outputBound;
  const inputBound = body.byteLength + 8192 + (messages + tools.length) * 1024;
  if (inputBound > 250_000) throw new ModelBudgetError('budget_context_too_large');
  return { payload, inputBound, outputBound,
    reserveMicroUsd: inputBound * MODEL_RATE_CARD.inputMicroUsd + outputBound * MODEL_RATE_CARD.outputMicroUsd };
}
export function modelResponseCharge(body: Buffer): number | null {
  try {
    const value = JSON.parse(body.toString()) as { usage?: Record<string,unknown> };
    const input = value.usage?.input_tokens ?? value.usage?.prompt_tokens;
    const output = value.usage?.output_tokens ?? value.usage?.completion_tokens;
    if (!integer(input) || !integer(output)) return null;
    const result = input * MODEL_RATE_CARD.inputMicroUsd + output * MODEL_RATE_CARD.outputMicroUsd;
    return integer(result) ? result : null;
  } catch { return null; }
}
