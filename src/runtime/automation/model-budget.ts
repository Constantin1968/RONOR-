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

/** Durable integer accounting. An unresolved dispatch is never released by restart,
 * timeout, retry or by replaying a signed token carrying an older subtotal. */
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
      if (row.frozen || row.pending) throw new ModelBudgetError('budget_unresolved_dispatch');
      const spent = Math.max(row.spent, claims.prior_micro_usd);
      if (spent + amount > row.ceiling) throw new ModelBudgetError('budget_insufficient_before_dispatch');
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
  snapshot(id: string): { mission: string; ceiling: number; spent: number; frozen: number; pending: number } | null {
    return this.db.prepare(`SELECT mission,ceiling,spent,frozen,
      (SELECT COUNT(*) FROM model_reservations r WHERE r.budget=b.id AND r.state='pending') AS pending
      FROM model_budgets b WHERE id=?`).get(id) as ReturnType<ModelBudgetLedger['snapshot']> ?? null;
  }
  close(): void { this.db.close(); }
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
      if (Object.keys(m).some(k=>!['role','content','tool_calls','tool_call_id','name','reasoning_content','function_call'].includes(k)))
        throw new ModelBudgetError('budget_message_unsupported');
      const content = (m as Record<string,unknown>).content;
      if (!(content === null || typeof content === 'string' || Array.isArray(content) && content.every(c =>
        c && typeof c === 'object' && c.type === 'text' && typeof c.text === 'string' &&
        Object.keys(c).every(k=>['type','text'].includes(k))))) throw new ModelBudgetError('budget_nontext_refused');
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
