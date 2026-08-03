/**
 * RONOR — L0 · Telegram Interface · Configuration
 * ───────────────────────────────────────────────
 * Every operational decision the bridge makes is derived from this one resolved
 * object. Nothing downstream reads `process.env` directly.
 *
 * Two properties of this module matter more than its contents:
 *
 *   · IT FAILS CLOSED. An absent token, an empty allowlist or an approver who is
 *     not also an allowlisted user are all REFUSALS, not warnings. A bridge into
 *     a governed runtime that answers whoever finds the bot handle is not a
 *     governed runtime, and the cheapest place to stop that is before the first
 *     poll.
 *
 *   · IT VALIDATES ONCE, AT BOOT. Parsing an allowlist per message would let a
 *     malformed value survive until the moment it is needed — which is the moment
 *     an operator is waiting on an answer.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

export type TelegramMode = 'polling' | 'webhook';

export interface TelegramConfig {
  /** Bot token from @BotFather. The token IS the bot; treat as a credential. */
  botToken: string;
  mode: TelegramMode;
  /** Absolute HTTPS URL Telegram will POST updates to. Webhook mode only. */
  webhookUrl: string | null;
  /**
   * Value asserted in `X-Telegram-Bot-Api-Secret-Token`. Telegram echoes it on
   * every webhook delivery, and an update arriving without it is discarded. It
   * is what distinguishes a genuine delivery from anyone who guessed the path.
   */
  webhookSecret: string | null;
  /** Base URL of the RONOR runtime. Inside compose this is http://ronor:3000. */
  apiBaseUrl: string;
  /** Operator key presented as `Authorization: Bearer`. Needs query+read+agent. */
  apiKey: string;
  /** Numeric Telegram user ids permitted to speak to the bridge at all. */
  allowedUserIds: ReadonlySet<number>;
  /** Subset of the above whose /approve or /reject settles a co-sign request. */
  approverUserIds: ReadonlySet<number>;
  /** Chat receiving unsolicited co-sign requests and alerts. */
  controlChatId: string | null;
  /** Minutes a pending approval stays actionable before it expires. */
  approvalTtlMinutes: number;
  /** Hard ceiling on one outbound message; longer output is chunked. */
  maxMessageChars: number;
  /** Long-poll timeout in seconds passed to getUpdates. */
  pollTimeoutSeconds: number;
  /** Per-user request ceiling per minute at the bridge. */
  rateLimitPerMinute: number;
}

export class TelegramConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelegramConfigError';
  }
}

function parseIdList(raw: string | undefined, field: string): Set<number> {
  const out = new Set<number>();
  if (!raw) return out;
  for (const part of raw.split(',')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const n = Number(trimmed);
    // Rejected rather than skipped. A typo in an allowlist that is silently
    // dropped produces a bridge that refuses the very operator it was
    // configured for, and the log line explaining why is one nobody reads until
    // after the incident.
    if (!Number.isInteger(n) || n === 0) {
      throw new TelegramConfigError(
        `${field} contains '${trimmed}', which is not a Telegram numeric user id. ` +
          'Use the numeric id (from @userinfobot), not the @handle.',
      );
    }
    out.add(n);
  }
  return out;
}

function parseIntWithDefault(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/**
 * Resolve and validate the bridge configuration.
 *
 * `env` is a parameter rather than a global read so that tests can state an
 * environment explicitly instead of mutating the process's own.
 */
export function loadTelegramConfig(env: NodeJS.ProcessEnv = process.env): TelegramConfig {
  const botToken = (env.TELEGRAM_BOT_TOKEN ?? '').trim();
  if (!botToken) {
    throw new TelegramConfigError(
      'TELEGRAM_BOT_TOKEN is not set. Obtain one from @BotFather and place it in .env.production.',
    );
  }
  // Shape check only: `<digits>:<35 chars>`. It catches a truncated paste or a
  // quoted value, which are the two ways this variable is actually wrong. It
  // does NOT validate the token against Telegram — that happens on the first
  // getMe call, and reporting a network result as a config error would be a lie
  // about where the fault is.
  if (!/^\d{6,}:[A-Za-z0-9_-]{30,}$/.test(botToken)) {
    throw new TelegramConfigError(
      'TELEGRAM_BOT_TOKEN does not have the shape <bot_id>:<secret>. Check for stray quotes or a truncated paste.',
    );
  }

  const allowedUserIds = parseIdList(env.TELEGRAM_ALLOWED_USER_IDS, 'TELEGRAM_ALLOWED_USER_IDS');
  if (allowedUserIds.size === 0) {
    throw new TelegramConfigError(
      'TELEGRAM_ALLOWED_USER_IDS is empty, so the bridge would answer nobody — or, if the check were relaxed, anybody. ' +
        'Set at least one numeric Telegram user id.',
    );
  }

  const approverUserIds = parseIdList(env.TELEGRAM_APPROVER_USER_IDS, 'TELEGRAM_APPROVER_USER_IDS');
  if (approverUserIds.size === 0) {
    throw new TelegramConfigError(
      'TELEGRAM_APPROVER_USER_IDS is empty. Without an approver, a Gate 1/2 co-sign request can never be settled and every ' +
        'governed request requiring one would hang until it expired.',
    );
  }
  // An approver outside the allowlist can never send a message the bridge will
  // read, so their authority is unexercisable. That is a configuration error,
  // not a subtlety to be discovered during an incident.
  for (const id of approverUserIds) {
    if (!allowedUserIds.has(id)) {
      throw new TelegramConfigError(
        `Approver ${id} is not in TELEGRAM_ALLOWED_USER_IDS. An approver the bridge ignores cannot approve anything.`,
      );
    }
  }

  const apiKey = (env.RONOR_TELEGRAM_API_KEY ?? env.RONOR_API_KEY ?? '').trim();
  if (!apiKey) {
    throw new TelegramConfigError(
      'RONOR_TELEGRAM_API_KEY is not set. The bridge is an ordinary API client and needs its own operator key ' +
        'carrying the query, read and agent scopes — not the admin key.',
    );
  }

  const mode: TelegramMode = env.TELEGRAM_MODE === 'webhook' ? 'webhook' : 'polling';
  const webhookUrl = (env.TELEGRAM_WEBHOOK_URL ?? '').trim() || null;
  const webhookSecret = (env.TELEGRAM_WEBHOOK_SECRET ?? '').trim() || null;

  if (mode === 'webhook') {
    if (!webhookUrl) {
      throw new TelegramConfigError('TELEGRAM_MODE=webhook requires TELEGRAM_WEBHOOK_URL.');
    }
    if (!webhookUrl.startsWith('https://')) {
      throw new TelegramConfigError('TELEGRAM_WEBHOOK_URL must be https — Telegram will not deliver to plain http.');
    }
    if (!webhookSecret || webhookSecret.length < 16) {
      throw new TelegramConfigError(
        'TELEGRAM_MODE=webhook requires a TELEGRAM_WEBHOOK_SECRET of at least 16 characters. Without it, any party that ' +
          'discovers the path can inject operator commands.',
      );
    }
  }

  const apiBaseUrl = (env.RONOR_API_BASE_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');

  return {
    botToken,
    mode,
    webhookUrl,
    webhookSecret,
    apiBaseUrl,
    apiKey,
    allowedUserIds,
    approverUserIds,
    controlChatId: (env.TELEGRAM_CONTROL_CHAT_ID ?? '').trim() || null,
    approvalTtlMinutes: parseIntWithDefault(env.TELEGRAM_APPROVAL_TTL_MINUTES, 60, 1, 1440),
    // 4096 is Telegram's hard limit. 3800 leaves room for the governance footer
    // the bridge appends to every answer, so a long answer is chunked rather
    // than rejected by the API after the runtime has already been paid for it.
    maxMessageChars: parseIntWithDefault(env.TELEGRAM_MAX_MESSAGE_CHARS, 3800, 500, 4000),
    pollTimeoutSeconds: parseIntWithDefault(env.TELEGRAM_POLL_TIMEOUT_SECONDS, 30, 1, 50),
    rateLimitPerMinute: parseIntWithDefault(env.TELEGRAM_RATE_LIMIT_PER_MINUTE, 20, 1, 600),
  };
}

/** Redacted view, safe to log at boot. */
export function describeConfig(config: TelegramConfig): Record<string, unknown> {
  return {
    mode: config.mode,
    api_base_url: config.apiBaseUrl,
    // Length and presence only. A prefix of a bot token still identifies the
    // bot, and a log is not a place a credential should be recoverable from.
    bot_token: `present (${config.botToken.length} chars)`,
    api_key: `present (${config.apiKey.length} chars)`,
    allowed_users: config.allowedUserIds.size,
    approvers: config.approverUserIds.size,
    control_chat: config.controlChatId ? 'set' : 'absent',
    approval_ttl_minutes: config.approvalTtlMinutes,
    rate_limit_per_minute: config.rateLimitPerMinute,
  };
}
