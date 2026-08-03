/**
 * RONOR — L0 · Telegram Interface · Types
 * ───────────────────────────────────────
 * The subset of the Telegram Bot API surface this bridge relies on, plus the
 * bridge's own domain types.
 *
 * These are hand-declared rather than pulled from a vendor typings package on
 * purpose. The bridge touches six methods and four object shapes; taking a
 * dependency that models the entire API — several hundred types tracking a
 * surface that changes monthly — would add supply-chain exposure and version
 * churn to a governed runtime in exchange for types nobody here uses.
 *
 * Every field is declared exactly as the API documents it: `optional` in the
 * documentation means optional here. A field narrowed to required because it is
 * "always there in practice" is a runtime crash waiting for the first update
 * that omits it.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

// ---------------------------------------------------------------------------
// Telegram Bot API — inbound
// ---------------------------------------------------------------------------

export interface TelegramUser {
  id: number;
  is_bot: boolean;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

export interface TelegramChat {
  id: number;
  type: 'private' | 'group' | 'supergroup' | 'channel';
  title?: string;
  username?: string;
}

export interface TelegramMessage {
  message_id: number;
  from?: TelegramUser;
  chat: TelegramChat;
  /** Unix seconds. */
  date: number;
  text?: string;
  reply_to_message?: TelegramMessage;
  entities?: Array<{ type: string; offset: number; length: number }>;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramApiResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
  error_code?: number;
  parameters?: { retry_after?: number; migrate_to_chat_id?: number };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
}

export interface SendMessageParams {
  chat_id: number | string;
  text: string;
  parse_mode?: 'HTML' | 'MarkdownV2';
  disable_web_page_preview?: boolean;
  reply_to_message_id?: number;
  reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
}

// ---------------------------------------------------------------------------
// Bridge domain types
// ---------------------------------------------------------------------------

export type CommandName =
  | 'start'
  | 'help'
  | 'status'
  | 'query'
  | 'mission'
  | 'approve'
  | 'reject'
  | 'pending'
  | 'unknown';

export interface ParsedCommand {
  name: CommandName;
  /** Everything after the command word, trimmed. Empty string when absent. */
  argument: string;
  /** The literal command as received, for the unknown-command message. */
  raw: string;
}

/**
 * A request held at an MI9 co-sign gate.
 *
 * The full original request is retained, not a reference to it. When an approver
 * settles the gate the runtime is called again with EXACTLY what was governed —
 * a stored identifier that had to be re-expanded from elsewhere could resolve to
 * a request whose parameters had since changed, and the approval would then
 * authorise something other than what was shown.
 */
export interface PendingApproval {
  approvalId: string;
  /** `query` or `mission` — determines which endpoint settles it. */
  kind: 'query' | 'mission';
  /** The runtime request id of the governed attempt that raised the gate. */
  requestId: string;
  /** Verbatim text the operator submitted. */
  payload: string;
  /** Telegram user who submitted it. */
  requestedByUserId: number;
  requestedByName: string;
  /** Chat the request arrived in, so the outcome returns to the same thread. */
  chatId: number;
  /** Telegram message id of the co-sign prompt, for editing on settlement. */
  promptMessageId: number | null;
  /** MI9 verdict string, e.g. `allow-with-cosign`. */
  verdict: string;
  /** Gate findings that demanded the co-sign, gate number included. */
  gateFindings: Array<{ gate: number; name: string; verdict: string; reason: string }>;
  /** ISO 8601. */
  createdAt: string;
  /** ISO 8601. After this instant the approval is refused as expired. */
  expiresAt: string;
  status: 'pending' | 'approved' | 'rejected' | 'expired';
  /** Set on settlement. */
  settledByUserId: number | null;
  settledAt: string | null;
  /** Optional reason supplied with /reject. */
  settlementNote: string | null;
  /** Audit record id of the governed attempt that raised the gate. */
  auditRecordId: string | null;
}

// ---------------------------------------------------------------------------
// RONOR runtime response shapes (the fields the bridge reads)
// ---------------------------------------------------------------------------
//
// Declared structurally rather than imported from src/runtime/api/pipeline.ts.
// The bridge is an HTTP CLIENT of the runtime: in the compose deployment it runs
// in a separate container and may be pointed at a different RONOR version
// entirely. Importing the server's internal types would create a compile-time
// coupling that the wire does not have, and would make a field the server
// renamed look like a bridge type error rather than the protocol change it is.

export interface RuntimeGovernanceBlock {
  verdict: string;
  human_cosign_required: boolean;
  block_reason: string | null;
  findings: Array<{ gate: number; name: string; verdict: string; reason: string }>;
}

export interface RuntimeQueryResponse {
  ok: boolean;
  request_id: string;
  status: string;
  answer: string;
  citations: Array<{ title: string; url?: string; snippet?: string }>;
  classification?: { domain?: string; task_type?: string; confidentiality?: string };
  routing: {
    chosen_model_id: string | null;
    chosen_provider: string | null;
    fallback_used: boolean;
  };
  governance: RuntimeGovernanceBlock;
  knowledge: { used: boolean; available: boolean; results: number; degradation: number | null };
  economics: { cost_usd: number; latency_ms: number; input_tokens: number; output_tokens: number };
  provenance: { request_id: string; audit_record_id: string | null; audit_chain_hash: string | null };
  rejection_reason: string | null;
}

export interface RuntimeMissionResponse {
  ok: boolean;
  request_id: string;
  mission_id: string;
  status: string;
  objective: string;
  synthesis: string;
  gaps: string[];
  confidence: number;
  citations: Array<{ title: string; url?: string }>;
  tasks: Array<{ task_id: string; agent_id: string; ok: boolean; cost_usd: number; error: string | null }>;
  governance: {
    verdict: string;
    human_cosign_required: boolean;
    block_reason: string | null;
    audit_record_id: string | null;
    audit_chain_hash: string | null;
  };
  economics: { total_cost_usd: number; budget_exhausted: boolean; tasks_executed: number; tasks_planned: number };
  reason: string | null;
}

export interface RuntimeStatusResponse {
  ok: boolean;
  runtime: string;
  policy_version: string;
  providers: { total: number; invocable: number; key_absent: string[] };
  knowledge: { enabled: boolean; degradationLevel?: number; reason?: string | null };
  agents: Array<{ id: string; name: string; status: string }>;
  economics: {
    total_requests: number;
    total_cost_usd: number;
    wasted_cost_usd: number;
    fallback_rate: number;
  };
  audit_chain: { records: number; head_hash: string | null };
  security_findings: string[];
  generated_at: string;
}

export interface RuntimeHealthResponse {
  status: 'ready' | 'degraded';
  live: boolean;
  policy_version: string;
  providers: { total: number; invocable: number; generative_invocable: number };
  audit_chain: { records: number; head_hash: string | null };
  security_findings: string[];
}
