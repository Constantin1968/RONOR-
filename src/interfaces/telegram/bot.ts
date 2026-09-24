/**
 * RONOR — L0 · Telegram Interface · Bot Handler
 * ──────────────────────────────────────────────
 * The operator interface to the RONOR sovereign runtime over Telegram.
 *
 * Commands
 * ────────
 *   /start                  — welcome and capability summary
 *   /help                   — command reference
 *   /status                 — live runtime status (providers, economics, audit chain)
 *   /query <text>           — governed single-turn query through the runtime
 *   /mission <objective>    — multi-agent mission dispatch
 *   /pending                — list pending co-sign requests
 *   /approve [id] [note]    — settle the latest (or named) co-sign request: approved
 *   /reject  [id] [reason]  — settle the latest (or named) co-sign request: rejected
 *
 * Gate 1/2 approval flow
 * ──────────────────────
 * When the runtime returns `governance.human_cosign_required = true`, the bot:
 *   1. Stores the full original request in the approval store with a TTL.
 *   2. Sends a co-sign prompt to the operator (and to the control chat if set).
 *   3. Waits for /approve or /reject from an authorised approver.
 *   4. On approval: releases the immutable result of a read-only query, or asks
 *      the runtime to consume a one-time server-side mission settlement.
 *   5. On rejection: notifies the requester and records the decision.
 *   6. On expiry: the approval is refused and the requester is notified.
 *
 * Mission settlements are bound to the runtime API key, expire quickly, and are
 * consumed before execution so retries cannot replay an approved side effect.
 *
 * Security
 * ────────
 *   · Only numeric user ids in TELEGRAM_ALLOWED_USER_IDS are answered.
 *   · Only numeric user ids in TELEGRAM_APPROVER_USER_IDS can settle gates.
 *   · Per-user rate limiting is enforced before any runtime call.
 *   · No secret is ever sent in a Telegram message.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import { createLogger } from '../../utils/logger';
import type { TelegramConfig } from './config';
import { TelegramApiClient } from './telegram-api';
import { RonorRuntimeClient } from './ronor-client';
import {
  createApproval,
  findLatestPending,
  findLatestPendingForUser,
  getApproval,
  listPendingApprovals,
  pruneApprovals,
  settleApproval,
} from './approval-store';
import { TradingClient } from './energy-trading/trading-client';
import {
  authoriseTradingCommand,
  tradingBucketFor,
  isTradeCoSigner,
  describeRole,
  type RoleAssignment,
  type TradingCommandBucket,
} from './energy-trading/roles';
import {
  cmdEnergyStatus,
  cmdEnergyReport,
  cmdDay,
  cmdPl,
  cmdBrief,
  cmdFeedback,
  cmdCorrect,
  cmdTradeRequest,
  settleTradeTicket,
  cmdDispute,
  cmdUploadCaseHint,
  handleUploadCasePayload,
  cmdHistory,
  tradingTrainerOnboarding,
} from './energy-trading/handlers';
import type {
  CommandName,
  ParsedCommand,
  PendingApproval,
  RuntimeMissionResponse,
  RuntimeQueryResponse,
  TelegramMessage,
  TelegramUpdate,
} from './types';

const logger = createLogger('RONOR:Telegram:Bot');

// ---------------------------------------------------------------------------
// Per-user rate limiter (in-process, per instance)
// ---------------------------------------------------------------------------

const rateLimitCounters = new Map<number, { count: number; windowStart: number }>();

function isRateLimited(userId: number, limitPerMinute: number): boolean {
  const now = Date.now();
  const entry = rateLimitCounters.get(userId) ?? { count: 0, windowStart: now };
  if (now - entry.windowStart > 60_000) {
    entry.count = 0;
    entry.windowStart = now;
  }
  entry.count++;
  rateLimitCounters.set(userId, entry);
  return entry.count > limitPerMinute;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function esc(text: string): string {
  // Escape HTML special characters for parse_mode=HTML.
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function governanceFooter(
  verdict: string,
  cosignRequired: boolean,
  costUsd: number,
  latencyMs: number,
  model: string | null,
  auditHash: string | null,
): string {
  const lines: string[] = [
    '',
    '─────────────────────────',
    `<b>Governance:</b> ${esc(verdict)}${cosignRequired ? ' ⚠️ co-sign' : ''}`,
    `<b>Model:</b> ${esc(model ?? 'unknown')}`,
    `<b>Cost:</b> $${costUsd.toFixed(6)} · <b>Latency:</b> ${(latencyMs / 1000).toFixed(1)}s`,
  ];
  if (auditHash) {
    lines.push(`<b>Audit:</b> <code>${esc(auditHash.slice(0, 16))}…</code>`);
  }
  return lines.join('\n');
}

function formatQueryResponse(r: RuntimeQueryResponse): string {
  const answer = esc(r.answer || r.rejection_reason || '(no answer)');
  const footer = governanceFooter(
    r.governance.verdict,
    r.governance.human_cosign_required,
    r.economics.cost_usd,
    r.economics.latency_ms,
    r.routing.chosen_model_id,
    r.provenance.audit_chain_hash,
  );
  return answer + footer;
}

function formatMissionResponse(r: RuntimeMissionResponse): string {
  const lines: string[] = [];
  const statusEmoji = r.status === 'complete' ? '✅' : r.status === 'partial' ? '⚠️' : '❌';
  lines.push(`${statusEmoji} <b>Mission ${r.status.toUpperCase()}</b>`);
  lines.push(`<b>ID:</b> <code>${esc(r.mission_id)}</code>`);
  lines.push('');
  lines.push(esc(r.synthesis || r.reason || '(no synthesis)'));
  if (r.gaps.length > 0) {
    lines.push('');
    lines.push('<b>Gaps:</b>');
    r.gaps.slice(0, 5).forEach((g) => lines.push(`• ${esc(g)}`));
  }
  if (r.citations.length > 0) {
    lines.push('');
    lines.push('<b>Citations:</b>');
    r.citations.slice(0, 3).forEach((c) => {
      const link = c.url ? ` (<a href="${esc(c.url)}">${esc(c.title)}</a>)` : ` ${esc(c.title)}`;
      lines.push(`•${link}`);
    });
  }
  const footer = governanceFooter(
    r.governance.verdict,
    r.governance.human_cosign_required,
    r.economics.total_cost_usd,
    r.economics.tasks_executed > 0 ? 0 : 0,
    null,
    r.governance.audit_record_id,
  );
  return lines.join('\n') + footer;
}

function formatCosignPrompt(approval: PendingApproval, ttlMinutes: number): string {
  const lines: string[] = [
    '🔐 <b>GATE CO-SIGN REQUIRED</b>',
    '',
    `<b>Kind:</b> ${esc(approval.kind)}`,
    `<b>Requested by:</b> ${esc(approval.requestedByName)} (${approval.requestedByUserId})`,
    `<b>Verdict:</b> <code>${esc(approval.verdict)}</code>`,
    `<b>Expires:</b> ${new Date(approval.expiresAt).toUTCString()}`,
    `<b>Approval ID:</b> <code>${esc(approval.approvalId)}</code>`,
    '',
    '<b>Request:</b>',
    `<blockquote>${esc(approval.payload.slice(0, 800))}${approval.payload.length > 800 ? '…' : ''}</blockquote>`,
  ];
  if (approval.gateFindings.length > 0) {
    lines.push('');
    lines.push('<b>Gate findings:</b>');
    approval.gateFindings.forEach((f) => {
      lines.push(`• Gate ${f.gate} <i>${esc(f.name)}</i>: ${esc(f.verdict)} — ${esc(f.reason)}`);
    });
  }
  lines.push('');
  lines.push(
    `Reply <b>/approve ${approval.approvalId}</b> to authorise or <b>/reject ${approval.approvalId} &lt;reason&gt;</b> to refuse.`,
  );
  lines.push(`This request expires in ${ttlMinutes} minutes.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Command parser
// ---------------------------------------------------------------------------

function parseCommand(text: string): ParsedCommand {
  const trimmed = text.trim();
  const match = trimmed.match(/^\/([a-zA-Z0-9_]+)(?:@\S+)?(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { name: 'unknown', argument: trimmed, raw: trimmed };
  }
  const cmd = match[1].toLowerCase();
  const argument = (match[2] ?? '').trim();
  const knownCommands: CommandName[] = [
    'start', 'help', 'status', 'query', 'mission', 'approve', 'reject', 'pending',
    // Energy trading arm commands. When the trading module is disabled the
    // dispatcher refuses them with a clean message; parsing them here anyway
    // is what lets that refusal be specific ("trading arm not enabled") rather
    // than generic ("unknown command").
    'energy_status', 'energy_report', 'day', 'pl', 'brief',
    'trade_request', 'upload_case', 'feedback', 'correct', 'dispute', 'history',
  ];
  const name: CommandName = (knownCommands.includes(cmd as CommandName) ? cmd : 'unknown') as CommandName;
  return { name, argument, raw: trimmed };
}

// ---------------------------------------------------------------------------
// Bot class
// ---------------------------------------------------------------------------

export class RonorTelegramBot {
  private readonly tg: TelegramApiClient;
  private readonly ronor: RonorRuntimeClient;
  private readonly config: TelegramConfig;
  private readonly trading: TradingClient | null;
  private pollOffset = 0;
  private running = false;
  private pruneInterval: NodeJS.Timeout | null = null;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.tg = new TelegramApiClient(config.botToken);
    this.ronor = new RonorRuntimeClient(config.apiBaseUrl, config.apiKey);
    // The trading client is instantiated only when the module is enabled.
    // Instantiating with placeholder values would let a malformed request
    // through the type system and only fail on the first HTTP attempt — by
    // which point the operator has waited on nothing.
    this.trading = config.energyTrading.enabled
      ? new TradingClient({
          baseUrl: config.energyTrading.baseUrl,
          apiToken: config.energyTrading.apiToken,
        })
      : null;
  }

  // Per-chat/user tracking for /upload_case: the first message with the
  // command sets a pending intent; the next document or text from the same
  // (chatId, userId) is routed to handleUploadCasePayload. TTL keeps stale
  // intents from catching an unrelated later document.
  private readonly pendingUploadCase = new Map<string, { day: string; createdAt: number }>();
  private readonly UPLOAD_CASE_TTL_MS = 10 * 60_000;

  private todayIsoCet(): string {
    // The arm and RO grid work in CET; keep a common day format across bot
    // and arm rather than mixing local sandbox time with arm-side clock.
    const d = new Date();
    // Compute Europe/Bucharest date without a full timezone library — the day
    // boundary is what matters, not sub-second precision.
    const s = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Europe/Bucharest',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(d);
    return s;
  }

  // -------------------------------------------------------------------------
  // Trading role helpers
  // -------------------------------------------------------------------------

  /** Return the trading role for a user, or undefined if none. */
  private roleOf(userId: number): RoleAssignment | undefined {
    return this.config.energyTrading.roleMap.get(userId);
  }

  /**
   * Gate a trading command. Returns null when the command may proceed;
   * otherwise returns the message to send the user explaining the refusal.
   */
  private gateTrading(
    userId: number,
    bucket: TradingCommandBucket,
  ): { proceed: true } | { proceed: false; text: string } {
    if (!this.config.energyTrading.enabled || this.trading === null) {
      return {
        proceed: false,
        text: '⛔ The energy trading arm is not enabled on this bridge. Set TRADING_ARM_BASE_URL in .env.production and restart.',
      };
    }
    const decision = authoriseTradingCommand(bucket, this.roleOf(userId));
    if (!decision.allowed) {
      return { proceed: false, text: `⛔ ${decision.reason ?? 'Not authorised for this command.'}` };
    }
    return { proceed: true };
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async start(): Promise<void> {
    const me = await this.tg.getMe();
    logger.info(`bot authenticated as @${me.username} (id=${me.id})`);

    if (this.config.mode === 'webhook') {
      if (!this.config.webhookUrl) throw new Error('webhookUrl required for webhook mode');
      await this.tg.setWebhook({
        url: this.config.webhookUrl,
        secret_token: this.config.webhookSecret ?? undefined,
        allowed_updates: ['message', 'callback_query'],
        drop_pending_updates: true,
      });
      logger.info(`webhook set: ${this.config.webhookUrl}`);
    } else {
      await this.tg.deleteWebhook({ drop_pending_updates: false });
      logger.info('long-polling mode active');
      this.running = true;
      this.pruneInterval = setInterval(() => pruneApprovals(), 5 * 60_000);
      void this.pollLoop();
    }
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.pruneInterval) clearInterval(this.pruneInterval);
    logger.info('bot stopped');
  }

  /** Process a single update — the entry point for webhook mode. */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    try {
      if (update.message) {
        await this.handleMessage(update.message);
      } else if (update.callback_query) {
        const cq = update.callback_query;
        if (cq.message) {
          await this.handleCallbackQuery(
            cq.id,
            cq.from.id,
            `${cq.from.first_name}${cq.from.last_name ? ' ' + cq.from.last_name : ''}`,
            cq.message.chat.id,
            cq.data ?? '',
          );
        }
      }
    } catch (err) {
      logger.error('unhandled error in handleUpdate:', err);
    }
  }

  // -------------------------------------------------------------------------
  // Long-poll loop
  // -------------------------------------------------------------------------

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const updates = await this.tg.getUpdates(this.pollOffset, this.config.pollTimeoutSeconds);
        for (const update of updates) {
          this.pollOffset = update.update_id + 1;
          await this.handleUpdate(update);
        }
      } catch (err) {
        logger.error('poll error:', err);
        await new Promise((r) => setTimeout(r, 5_000));
      }
    }
  }

  // -------------------------------------------------------------------------
  // Message dispatch
  // -------------------------------------------------------------------------

  private async handleMessage(msg: TelegramMessage): Promise<void> {
    const userId = msg.from?.id;
    const chatId = msg.chat.id;
    const text = msg.text ?? '';
    const hasDocument = msg.document !== undefined;
    const hasPhoto = msg.photo !== undefined && msg.photo.length > 0;

    // A message with only a document/photo has no `text` field; we still want
    // to look at it, because /upload_case may have primed a pending intent.
    if (!userId) return;
    if (!hasDocument && !hasPhoto && (msg.text === undefined || text.trim().length === 0)) return;

    // Conversational mode: plain text (no / prefix) is treated as /query.
    // Auth and rate-limit checks still run below before the query is forwarded.
    const isPlainText = !hasDocument && !hasPhoto && !text.startsWith('/');

    if (!this.config.allowedUserIds.has(userId)) {
      logger.warn(`rejected message from unauthorised user ${userId}`);
      await this.tg.sendMessage({
        chat_id: chatId,
        text: '⛔ You are not authorised to use this interface.',
      });
      return;
    }

    if (isRateLimited(userId, this.config.rateLimitPerMinute)) {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: `⏱ Rate limit reached. You may send ${this.config.rateLimitPerMinute} commands per minute.`,
      });
      return;
    }

    // /upload_case pending intent: if the previous command from this user was
    // /upload_case, route the next document / text / photo to the handler and
    // clear the intent. TTL guards against a stray later document being
    // interpreted as case data.
    const uploadKey = `${chatId}:${userId}`;
    const pendingUpload = this.pendingUploadCase.get(uploadKey);
    if (pendingUpload && Date.now() - pendingUpload.createdAt <= this.UPLOAD_CASE_TTL_MS) {
      // A slash-command interrupts the upload flow — don't hijack it.
      if (hasDocument || hasPhoto || (text && !text.startsWith('/'))) {
        this.pendingUploadCase.delete(uploadKey);
        await this.handleUploadCaseMessage(chatId, userId, msg, pendingUpload.day);
        return;
      }
    } else if (pendingUpload) {
      // Stale intent — discard.
      this.pendingUploadCase.delete(uploadKey);
    }

    // Documents/photos without a pending intent: politely note the correct flow.
    if (hasDocument || hasPhoto) {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: 'Send /upload_case first, then attach the .xlsx or .csv (or paste text) as your next message.',
      });
      return;
    }

    // Conversational passthrough: route plain text directly to query handler.
    if (isPlainText) {
      logger.info(`conversational query from user ${userId} in chat ${chatId}`);
      await this.cmdQuery(chatId, msg.message_id, userId, msg.from?.first_name ?? 'Operator', text.trim());
      return;
    }
    const cmd = parseCommand(text);
    logger.info(`command /${cmd.name} from user ${userId} in chat ${chatId}`);

    switch (cmd.name) {
      case 'start': {
        // On /start, if the user holds the trading_trainer role, greet them
        // with the trainer-specific onboarding instead of the generic help.
        // Sovereign and observer still see the generic help.
        const role = this.roleOf(userId);
        if (role && role.role === 'trading_trainer') {
          const userName = msg.from?.first_name ?? 'Operator';
          await this.tg.sendMessage({
            chat_id: chatId,
            text: tradingTrainerOnboarding(userName),
            parse_mode: 'HTML',
            disable_web_page_preview: true,
          });
        } else {
          await this.cmdHelp(chatId);
        }
        break;
      }
      case 'help':
        await this.cmdHelp(chatId);
        break;
      case 'status':
        await this.cmdStatus(chatId, msg.message_id);
        break;
      case 'query':
        await this.cmdQuery(chatId, msg.message_id, userId, msg.from?.first_name ?? 'Operator', cmd.argument);
        break;
      case 'mission':
        await this.cmdMission(chatId, msg.message_id, userId, msg.from?.first_name ?? 'Operator', cmd.argument);
        break;
      case 'pending':
        await this.cmdPending(chatId, userId);
        break;
      case 'approve':
        await this.cmdApprove(chatId, msg.message_id, userId, cmd.argument);
        break;
      case 'reject':
        await this.cmdReject(chatId, msg.message_id, userId, cmd.argument);
        break;
      case 'energy_status':
      case 'energy_report':
      case 'day':
      case 'pl':
      case 'brief':
      case 'trade_request':
      case 'upload_case':
      case 'feedback':
      case 'correct':
      case 'dispute':
      case 'history':
        await this.cmdTrading(chatId, msg, userId, cmd.name, cmd.argument);
        break;
      default:
        await this.tg.sendMessage({
          chat_id: chatId,
          text: `❓ Unknown command: <code>${esc(cmd.raw.slice(0, 40))}</code>\n\nSend /help for the command list.`,
          parse_mode: 'HTML',
        });
    }
  }

  // -------------------------------------------------------------------------
  // Callback query (inline keyboard buttons)
  // -------------------------------------------------------------------------

  private async handleCallbackQuery(
    callbackQueryId: string,
    userId: number,
    userName: string,
    chatId: number,
    data: string,
  ): Promise<void> {
    await this.tg.answerCallbackQuery({ callback_query_id: callbackQueryId });

    if (!this.config.approverUserIds.has(userId)) {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: '⛔ Only authorised approvers can settle co-sign requests.',
      });
      return;
    }

    const [action, approvalId] = data.split(':');
    if (!approvalId || (action !== 'approve' && action !== 'reject')) return;

    if (action === 'approve') {
      await this.doApprove(chatId, userId, approvalId, null);
    } else {
      await this.doReject(chatId, userId, approvalId, null);
    }
  }

  // -------------------------------------------------------------------------
  // /upload_case follow-up: route the next document / text from the primed
  // (chatId, userId) to the arm. Refuse images/PDFs per Muse's Decizia 2.
  // -------------------------------------------------------------------------

  private async handleUploadCaseMessage(
    chatId: number,
    userId: number,
    msg: TelegramMessage,
    day: string,
  ): Promise<void> {
    const gate = this.gateTrading(userId, 'contribute');
    if (!gate.proceed) {
      await this.tg.sendMessage({ chat_id: chatId, text: gate.text, parse_mode: 'HTML' });
      return;
    }
    const client = this.trading!;
    const assignment = this.roleOf(userId)!;
    const userName = `${msg.from?.first_name ?? 'Operator'}${msg.from?.last_name ? ' ' + msg.from.last_name : ''}`;
    const ctx = { userId, userName, assignment, client };

    if (msg.photo && msg.photo.length > 0) {
      const text = await handleUploadCasePayload(ctx, { kind: 'image', day });
      await this.tg.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
      return;
    }

    if (msg.document) {
      const doc = msg.document;
      const filename = doc.file_name ?? 'unnamed';
      const mime = (doc.mime_type ?? '').toLowerCase();
      const lower = filename.toLowerCase();
      const isImage = mime.startsWith('image/') || /\.(png|jpe?g|gif|webp|heic|heif|bmp|tiff?)$/i.test(lower);
      const isPdf = mime === 'application/pdf' || lower.endsWith('.pdf');
      const isFile =
        lower.endsWith('.xlsx') ||
        lower.endsWith('.xls') ||
        lower.endsWith('.csv') ||
        lower.endsWith('.json') ||
        mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
        mime === 'text/csv' ||
        mime === 'application/json';

      let payloadText: string;
      if (isImage) {
        payloadText = await handleUploadCasePayload(ctx, { kind: 'image', filename, day });
      } else if (isPdf) {
        payloadText = await handleUploadCasePayload(ctx, { kind: 'pdf', filename, day });
      } else if (isFile) {
        try {
          const { bytes } = await this.tg.downloadFile(doc.file_id);
          payloadText = await handleUploadCasePayload(ctx, {
            kind: 'file',
            bytes,
            filename,
            day,
          });
        } catch (err) {
          logger.error('failed to download upload_case document', err);
          payloadText = `⛔ Failed to download attachment: ${(err as Error).message}`;
        }
      } else {
        payloadText = await handleUploadCasePayload(ctx, { kind: 'unsupported', filename, day });
      }
      await this.tg.sendMessage({ chat_id: chatId, text: payloadText, parse_mode: 'HTML' });
      return;
    }

    const pasted = (msg.text ?? '').trim();
    if (pasted.length === 0) {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: 'No attachment or text found. Send /upload_case again then attach the .xlsx / .csv or paste the numbers.',
      });
      return;
    }
    const text = await handleUploadCasePayload(ctx, { kind: 'text', text: pasted, day });
    await this.tg.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML' });
  }

  // -------------------------------------------------------------------------
  // Energy trading commands
  // -------------------------------------------------------------------------
  //
  // All trading commands funnel through this dispatcher: it enforces the role
  // gate before every call and formats the arm's response for Telegram. A
  // trainer who is refused a command sees a specific reason, not a silent
  // ignore. The base allowlist has already run by the time we get here — the
  // outer gate is unchanged.
  private async cmdTrading(
    chatId: number,
    msg: TelegramMessage,
    userId: number,
    command: CommandName,
    argument: string,
  ): Promise<void> {
    const bucket = tradingBucketFor(command);
    if (bucket === null) {
      // Should never happen — handleMessage narrows CommandName to the trading
      // set before dispatching here. If it does, the switch and the map have
      // drifted; fail loud rather than silent.
      logger.error(`cmdTrading called with non-trading command: ${command}`);
      return;
    }
    const gate = this.gateTrading(userId, bucket);
    if (!gate.proceed) {
      await this.tg.sendMessage({ chat_id: chatId, text: gate.text, parse_mode: 'HTML' });
      return;
    }
    // this.trading is guaranteed non-null when gate.proceed is true.
    const client = this.trading!;
    const assignment = this.roleOf(userId)!;
    const userName = `${msg.from?.first_name ?? 'Operator'}${msg.from?.last_name ? ' ' + msg.from.last_name : ''}`;
    const ctx = { userId, userName, assignment, client };

    let text: string;
    switch (command) {
      case 'energy_status':
        text = await cmdEnergyStatus(ctx);
        break;
      case 'energy_report':
        text = await cmdEnergyReport(ctx, argument);
        break;
      case 'day':
        text = await cmdDay(ctx, argument);
        break;
      case 'pl':
        text = await cmdPl(ctx, argument);
        break;
      case 'brief':
        text = await cmdBrief(ctx, argument);
        break;
      case 'feedback':
        text = await cmdFeedback(ctx, argument);
        break;
      case 'correct':
        text = await cmdCorrect(ctx, argument);
        break;
      case 'upload_case': {
        const hint = cmdUploadCaseHint(argument);
        text = hint.text;
        // Track the pending upload so the next document / text from this chat
        // is routed to handleUploadCasePayload. Keyed by chatId + userId to
        // avoid one operator's upload catching another's next document.
        this.pendingUploadCase.set(`${chatId}:${userId}`, {
          day: hint.day ?? this.todayIsoCet(),
          createdAt: Date.now(),
        });
        break;
      }
      case 'dispute':
        text = await cmdDispute(ctx, argument);
        break;
      case 'history':
        text = await cmdHistory(ctx, argument);
        break;
      case 'trade_request': {
        const r = await cmdTradeRequest(ctx, argument);
        text = r.text;
        // If the arm returned a ticket, immediately raise a co-sign gate
        // bound to it. The sovereign settles the gate with /approve or
        // /reject and the bot then calls /api/settle on the arm.
        if (r.ticketId) {
          createApproval({
            approvalId: r.ticketId, // arm's ticket id doubles as the approval id
            kind: 'trade',
            tradeTicketId: r.ticketId,
            tradeIds: r.proposedTradeIds ?? [],
            requestId: r.ticketId,
            runtimeApprovalId: null,
            heldResponse: null,
            payload: argument,
            requestedByUserId: userId,
            requestedByName: userName,
            chatId,
            promptMessageId: null,
            verdict: 'trade-cosign-required',
            gateFindings: [
              {
                gate: 0,
                name: 'energy-trading:trade-cosign',
                verdict: 'block-until-approved',
                reason: 'Every trade request from a trading_trainer requires a sovereign co-sign before settlement.',
              },
            ],
            ttlMinutes: this.config.approvalTtlMinutes,
            auditRecordId: null,
          });
          // If a control chat is set, notify it too so approvals do not depend
          // on the sovereign being in the same chat the trainer used.
          if (this.config.controlChatId && String(chatId) !== this.config.controlChatId) {
            await this.tg.sendMessage({
              chat_id: this.config.controlChatId,
              text:
                `🔔 <b>Trade co-sign requested</b>\n` +
                `by ${esc(userName)} (${esc(describeRole(assignment))})\n` +
                `ticket: <code>${esc(r.ticketId)}</code>\n\n` +
                `Settle with <code>/approve ${r.ticketId}</code> or <code>/reject ${r.ticketId} [reason]</code>.`,
              parse_mode: 'HTML',
            }).catch((e) => logger.warn('control chat notify failed:', e));
          }
        }
        break;
      }
      default: {
        // Exhaustiveness — any new trading command must be added above.
        text = `❓ Trading command ${command} is not implemented on the bridge yet.`;
      }
    }

    await this.tg.sendChunked(chatId, text, this.config.maxMessageChars);
  }

  // -------------------------------------------------------------------------
  // /help
  // -------------------------------------------------------------------------

  private async cmdHelp(chatId: number): Promise<void> {
    const text = [
      '🤖 <b>RONOR Sovereign Runtime — Operator Interface</b>',
      '',
      '<b>Commands</b>',
      '/status — runtime health, providers, economics',
      '/query &lt;text&gt; — governed single-turn query',
      '/mission &lt;objective&gt; — multi-agent mission dispatch',
      '/pending — list pending co-sign requests',
      '/approve [id] [note] — approve the latest (or named) co-sign request',
      '/reject [id] [reason] — reject the latest (or named) co-sign request',
      '',
      ...(this.config.energyTrading.enabled
        ? [
            '<b>Energy Trading Arm</b> (role-gated)',
            '/energy_status — arm state',
            '/energy_report [prompt] — operator brief',
            '/day YYYY-MM-DD — top corridors for a day',
            '/pl [day] — proof-of-optimisation summary',
            '/brief &lt;question&gt; — free-form question to the arm',
            '/trade_request corridor=... day=... hour=... volume=... side=... — initiate a trade (requires sovereign co-sign)',
            '/upload_case [day=YYYY-MM-DD] — upload an ops .xlsx/.csv, or paste text (no OCR)',
            '/feedback &lt;text&gt; — record trainer feedback',
            '/correct &lt;text&gt; — record a correction against arm reasoning',
            '/dispute ticket:trade [day=YYYY-MM-DD] [reason] — open a dispute for a nominated trade',
            '/history day=YYYY-MM-DD — re-run the arm for a given day (reads bids + disputes)',
            '',
          ]
        : []),
      '<b>Gate 1/2 approval flow</b>',
      'When MI9 governance requires a co-sign, RONOR sends you a prompt. Reply with /approve or /reject. The request expires if not settled within the configured TTL. Trade requests use the same flow but settle against the trading arm.',
      '',
      '<i>Prepared by AMB · Mayleven Ecosystem</i>',
    ].join('\n');
    await this.tg.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true });
  }

  // -------------------------------------------------------------------------
  // /status
  // -------------------------------------------------------------------------

  private async cmdStatus(chatId: number, replyToMessageId: number): Promise<void> {
    const thinking = await this.tg.sendMessage({
      chat_id: chatId,
      text: '⏳ Fetching runtime status…',
      reply_to_message_id: replyToMessageId,
    });

    try {
      const s = await this.ronor.status();
      const readyEmoji = s.providers.invocable > 0 ? '🟢' : '🔴';
      const lines: string[] = [
        `${readyEmoji} <b>RONOR Runtime Status</b>`,
        '',
        `<b>Runtime:</b> ${esc(s.runtime)}`,
        `<b>Policy:</b> ${esc(s.policy_version)}`,
        `<b>Providers:</b> ${s.providers.invocable}/${s.providers.total} invocable`,
        s.providers.key_absent.length > 0
          ? `<b>Keys absent:</b> ${esc(s.providers.key_absent.join(', '))}`
          : '',
        '',
        `<b>Knowledge plane:</b> ${s.knowledge.enabled ? 'enabled' : 'disabled'}`,
        `<b>Agents:</b> ${s.agents.map((a) => `${esc(a.name)} (${esc(a.status)})`).join(', ')}`,
        '',
        `<b>Economics</b>`,
        `Requests: ${s.economics.total_requests}`,
        `Total cost: $${s.economics.total_cost_usd.toFixed(6)}`,
        `Wasted cost: $${s.economics.wasted_cost_usd.toFixed(6)}`,
        `Fallback rate: ${(s.economics.fallback_rate * 100).toFixed(1)}%`,
        '',
        `<b>Audit chain:</b> ${s.audit_chain.records} records`,
        s.audit_chain.head_hash
          ? `Head: <code>${esc(s.audit_chain.head_hash.slice(0, 16))}…</code>`
          : '',
        s.security_findings.length > 0
          ? `\n⚠️ <b>Security findings:</b>\n${s.security_findings.map((f) => `• ${esc(f)}`).join('\n')}`
          : '',
        '',
        `<i>Generated at ${esc(s.generated_at)}</i>`,
      ].filter(Boolean);

      await this.tg.editMessageText({
        chat_id: chatId,
        message_id: thinking.message_id,
        text: lines.join('\n'),
        parse_mode: 'HTML',
      });
    } catch (err) {
      logger.error('/status error:', err);
      await this.tg.editMessageText({
        chat_id: chatId,
        message_id: thinking.message_id,
        text: `❌ Could not reach the runtime: ${esc(String(err))}`,
        parse_mode: 'HTML',
      });
    }
  }

  // -------------------------------------------------------------------------
  // /query
  // -------------------------------------------------------------------------

  private async cmdQuery(
    chatId: number,
    replyToMessageId: number,
    userId: number,
    userName: string,
    queryText: string,
  ): Promise<void> {
    if (!queryText) {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: 'Usage: /query &lt;your question&gt;',
        parse_mode: 'HTML',
        reply_to_message_id: replyToMessageId,
      });
      return;
    }

    const thinking = await this.tg.sendMessage({
      chat_id: chatId,
      text: '⏳ Routing query through RONOR governance…',
      reply_to_message_id: replyToMessageId,
    });

    try {
      const { httpStatus, response } = await this.ronor.query({
        query: queryText,
        operator_id: `tg:${userId}`,
        use_knowledge: true,
      });

      if (response.governance.human_cosign_required) {
        await this.handleCosignRequired(
          'query',
          chatId,
          userId,
          userName,
          queryText,
          response,
          thinking.message_id,
        );
        return;
      }

      const text = formatQueryResponse(response);
      await this.tg.editMessageText({
        chat_id: chatId,
        message_id: thinking.message_id,
        text: text.slice(0, this.config.maxMessageChars),
        parse_mode: 'HTML',
      });

      // If the answer was truncated, send the overflow as additional chunks.
      if (text.length > this.config.maxMessageChars) {
        await this.tg.sendChunked(chatId, text.slice(this.config.maxMessageChars), this.config.maxMessageChars);
      }

      if (httpStatus === 422) {
        logger.warn(`query refused by governance: ${response.rejection_reason}`);
      }
    } catch (err) {
      logger.error('/query error:', err);
      await this.tg.editMessageText({
        chat_id: chatId,
        message_id: thinking.message_id,
        text: `❌ Runtime error: ${esc(String(err))}`,
        parse_mode: 'HTML',
      });
    }
  }

  // -------------------------------------------------------------------------
  // /mission
  // -------------------------------------------------------------------------

  private async cmdMission(
    chatId: number,
    replyToMessageId: number,
    userId: number,
    userName: string,
    objective: string,
  ): Promise<void> {
    if (!objective) {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: 'Usage: /mission &lt;objective&gt;\n\nExample: /mission Analyse the Q2 BESS dispatch efficiency and identify cost reduction opportunities.',
        parse_mode: 'HTML',
        reply_to_message_id: replyToMessageId,
      });
      return;
    }

    const thinking = await this.tg.sendMessage({
      chat_id: chatId,
      text: '🚀 Dispatching multi-agent mission through RONOR governance…\n<i>(This may take several minutes.)</i>',
      parse_mode: 'HTML',
      reply_to_message_id: replyToMessageId,
    });

    try {
      const { httpStatus, response } = await this.ronor.dispatchMission({
        objective,
        operator_id: `tg:${userId}`,
        use_knowledge: true,
        require_evidence: true,
      });

      if (response.governance.human_cosign_required) {
        await this.handleCosignRequired(
          'mission',
          chatId,
          userId,
          userName,
          objective,
          response,
          thinking.message_id,
        );
        return;
      }

      const text = formatMissionResponse(response);
      await this.tg.editMessageText({
        chat_id: chatId,
        message_id: thinking.message_id,
        text: text.slice(0, this.config.maxMessageChars),
        parse_mode: 'HTML',
      });

      if (text.length > this.config.maxMessageChars) {
        await this.tg.sendChunked(chatId, text.slice(this.config.maxMessageChars), this.config.maxMessageChars);
      }

      if (httpStatus !== 200) {
        logger.warn(`mission returned HTTP ${httpStatus}: ${response.reason}`);
      }
    } catch (err) {
      logger.error('/mission error:', err);
      await this.tg.editMessageText({
        chat_id: chatId,
        message_id: thinking.message_id,
        text: `❌ Mission error: ${esc(String(err))}`,
        parse_mode: 'HTML',
      });
    }
  }

  // -------------------------------------------------------------------------
  // /pending
  // -------------------------------------------------------------------------

  private async cmdPending(chatId: number, userId: number): Promise<void> {
    const pending = listPendingApprovals();
    if (pending.length === 0) {
      await this.tg.sendMessage({ chat_id: chatId, text: '✅ No pending co-sign requests.' });
      return;
    }
    const lines = ['<b>Pending co-sign requests:</b>', ''];
    for (const a of pending) {
      const expiresIn = Math.max(0, Math.round((new Date(a.expiresAt).getTime() - Date.now()) / 60_000));
      lines.push(
        `• <code>${esc(a.approvalId)}</code> — ${esc(a.kind)} by ${esc(a.requestedByName)} — expires in ${expiresIn}m`,
      );
      lines.push(`  <i>${esc(a.payload.slice(0, 100))}${a.payload.length > 100 ? '…' : ''}</i>`);
    }
    lines.push('');
    lines.push('Use /approve &lt;id&gt; or /reject &lt;id&gt; &lt;reason&gt; to settle.');
    await this.tg.sendMessage({
      chat_id: chatId,
      text: lines.join('\n'),
      parse_mode: 'HTML',
    });
  }

  // -------------------------------------------------------------------------
  // /approve
  // -------------------------------------------------------------------------

  private async cmdApprove(chatId: number, replyToMessageId: number, userId: number, argument: string): Promise<void> {
    if (!this.config.approverUserIds.has(userId)) {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: '⛔ You are not authorised to approve co-sign requests.',
        reply_to_message_id: replyToMessageId,
      });
      return;
    }
    const parts = argument.split(/\s+/);
    const approvalId = parts[0] || null;
    const note = parts.slice(1).join(' ') || null;
    await this.doApprove(chatId, userId, approvalId, note);
  }

  private async doApprove(chatId: number, userId: number, approvalId: string | null, note: string | null): Promise<void> {
    const approval = approvalId
      ? getApproval(approvalId)
      : findLatestPending();

    if (!approval || approval.status !== 'pending') {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: approvalId
          ? `❓ No pending approval found with id <code>${esc(approvalId)}</code>.`
          : '❓ No pending co-sign requests.',
        parse_mode: 'HTML',
      });
      return;
    }

    // Trade approvals require the sovereign role AND membership of
    // TELEGRAM_TRADING_APPROVERS (when non-empty). This is the second gate on
    // top of the base approver check that already ran in cmdApprove. A base
    // approver who is not a trade co-signer can approve everything ELSE, just
    // not trades — which is the correct model when trading is delegated to a
    // subset of the approver group.
    if (approval.kind === 'trade') {
      const isBaseApprover = this.config.approverUserIds.has(userId);
      const canCoSignTrade = isTradeCoSigner(
        userId,
        isBaseApprover,
        this.roleOf(userId),
        this.config.energyTrading.tradingApprovers,
      );
      if (!canCoSignTrade) {
        await this.tg.sendMessage({
          chat_id: chatId,
          text: '⛔ You are approved for RONOR gates but not authorised to co-sign a TRADE. Only the sovereign role (or a user listed in TELEGRAM_TRADING_APPROVERS) may settle a trade ticket.',
          parse_mode: 'HTML',
        });
        return;
      }
    }

    // Keep the local gate pending until the runtime action succeeds. A
    // transient failure can therefore be retried without issuing a new gate.
    if (!(await this.completeApproved(approval))) return;

    const settled = settleApproval(approval.approvalId, 'approved', userId, note);
    if (!settled) {
      await this.tg.sendMessage({ chat_id: chatId, text: '⚠️ Could not settle the approval (already settled or expired).' });
      return;
    }

    await this.tg.sendMessage({
      chat_id: chatId,
      text: `✅ Approval <code>${esc(approval.approvalId)}</code> granted. Executing through the one-time runtime settlement…`,
      parse_mode: 'HTML',
    });

    // Notify the original requester if they are in a different chat.
    if (approval.chatId !== chatId) {
      await this.tg.sendMessage({
        chat_id: approval.chatId,
        text: `✅ Your ${esc(approval.kind)} request has been approved. Executing after settlement…`,
        parse_mode: 'HTML',
      }).catch((e) => logger.warn('could not notify requester:', e));
    }

  }

  // -------------------------------------------------------------------------
  // /reject
  // -------------------------------------------------------------------------

  private async cmdReject(chatId: number, replyToMessageId: number, userId: number, argument: string): Promise<void> {
    if (!this.config.approverUserIds.has(userId)) {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: '⛔ You are not authorised to reject co-sign requests.',
        reply_to_message_id: replyToMessageId,
      });
      return;
    }
    const parts = argument.split(/\s+/);
    const approvalId = parts[0] || null;
    const reason = parts.slice(1).join(' ') || null;
    await this.doReject(chatId, userId, approvalId, reason);
  }

  private async doReject(chatId: number, userId: number, approvalId: string | null, reason: string | null): Promise<void> {
    const approval = approvalId
      ? getApproval(approvalId)
      : findLatestPending();

    // Trade rejections cancel the arm-side ticket so the ledger records the
    // rejection with a signature, rather than leaving the ticket dangling in
    // the arm's pending set until it expires.
    if (approval && approval.status === 'pending' && approval.kind === 'trade' && this.trading && approval.tradeTicketId) {
      try {
        const cancelled = await settleTradeTicket(
          this.trading,
          approval.tradeTicketId,
          approval.tradeIds ?? [],
          approval.requestedByName,
          'cancelled',
          reason,
        );
        await this.tg.sendChunked(chatId, cancelled.text, this.config.maxMessageChars);
      } catch (err) {
        logger.error(`trade rejection settle failed for ticket ${approval.tradeTicketId}:`, err);
      }
      settleApproval(approval.approvalId, 'rejected', userId, reason);
      return;
    }

    if (!approval || approval.status !== 'pending') {
      await this.tg.sendMessage({
        chat_id: chatId,
        text: approvalId
          ? `❓ No pending approval found with id <code>${esc(approvalId)}</code>.`
          : '❓ No pending co-sign requests.',
        parse_mode: 'HTML',
      });
      return;
    }

    try {
      if (approval.runtimeApprovalId) {
        await this.ronor.settleApproval(approval.runtimeApprovalId, 'rejected');
      }
    } catch (err) {
      logger.error('runtime rejection settlement failed:', err);
      await this.tg.sendMessage({
        chat_id: chatId,
        text: '⚠️ Runtime did not accept the rejection; the approval remains pending.',
      });
      return;
    }

    const settled = settleApproval(approval.approvalId, 'rejected', userId, reason);
    if (!settled) {
      await this.tg.sendMessage({ chat_id: chatId, text: '⚠️ Could not settle the approval (already settled or expired).' });
      return;
    }

    const rejectMsg = [
      `🚫 Approval <code>${esc(approval.approvalId)}</code> rejected.`,
      reason ? `\n<b>Reason:</b> ${esc(reason)}` : '',
    ].join('');

    await this.tg.sendMessage({ chat_id: chatId, text: rejectMsg, parse_mode: 'HTML' });

    if (approval.chatId !== chatId) {
      await this.tg.sendMessage({
        chat_id: approval.chatId,
        text: `🚫 Your ${esc(approval.kind)} request was rejected.${reason ? '\n<b>Reason:</b> ' + esc(reason) : ''}`,
        parse_mode: 'HTML',
      }).catch((e) => logger.warn('could not notify requester:', e));
    }
  }

  // -------------------------------------------------------------------------
  // Co-sign gate handling
  // -------------------------------------------------------------------------

  private async handleCosignRequired(
    kind: 'query' | 'mission',
    chatId: number,
    userId: number,
    userName: string,
    payload: string,
    response: RuntimeQueryResponse | RuntimeMissionResponse,
    thinkingMessageId: number,
  ): Promise<void> {
    const gov = response.governance;
    const auditRecordId =
      'provenance' in response
        ? (response as RuntimeQueryResponse).provenance.audit_record_id
        : (response as RuntimeMissionResponse).governance.audit_record_id;

    if (kind === 'mission' && !gov.approval_id) {
      throw new Error('runtime requested mission co-sign without issuing a settlement id');
    }
    const approval = createApproval({
      kind,
      requestId: response.request_id,
      runtimeApprovalId: gov.approval_id,
      heldResponse: kind === 'query' ? (response as RuntimeQueryResponse) : null,
      payload,
      requestedByUserId: userId,
      requestedByName: userName,
      chatId,
      promptMessageId: null,
      verdict: gov.verdict,
        gateFindings: 'findings' in gov && Array.isArray(gov.findings) ? gov.findings : [],
      ttlMinutes: this.config.approvalTtlMinutes,
      auditRecordId: auditRecordId ?? null,
    });

    const promptText = formatCosignPrompt(approval, this.config.approvalTtlMinutes);

    // Replace the "thinking" message with the co-sign prompt.
    await this.tg.editMessageText({
      chat_id: chatId,
      message_id: thinkingMessageId,
      text: promptText.slice(0, this.config.maxMessageChars),
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '✅ Approve', callback_data: `approve:${approval.approvalId}` },
            { text: '🚫 Reject', callback_data: `reject:${approval.approvalId}` },
          ],
        ],
      },
    });

    // If a control chat is configured and it is different from the current chat,
    // send the prompt there too so approvers who are not in this conversation
    // see it.
    if (this.config.controlChatId && String(this.config.controlChatId) !== String(chatId)) {
      await this.tg.sendMessage({
        chat_id: this.config.controlChatId,
        text: promptText.slice(0, this.config.maxMessageChars),
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✅ Approve', callback_data: `approve:${approval.approvalId}` },
              { text: '🚫 Reject', callback_data: `reject:${approval.approvalId}` },
            ],
          ],
        },
      }).catch((e) => logger.warn('could not send to control chat:', e));
    }

    logger.info(
      `co-sign required for ${kind} by user ${userId}: approval ${approval.approvalId}, ` +
        `verdict=${gov.verdict}, expires=${approval.expiresAt}`,
    );
  }

  // -------------------------------------------------------------------------
  // Complete after approval
  // -------------------------------------------------------------------------

  private async completeApproved(approval: PendingApproval): Promise<boolean> {
    const chatId = approval.chatId;
    try {
      if (approval.kind === 'trade') {
        // A trade approval is settled against the trading arm, not the runtime.
        // The base bridge has already checked that the approver is on
        // TELEGRAM_APPROVER_USER_IDS; the trading module adds two more checks
        // here: the approver must hold the sovereign role, and (if configured)
        // must be on TELEGRAM_TRADING_APPROVERS. Refusing at this point rather
        // than in doApprove keeps a settlement path that failed authorisation
        // from marking the ticket settled anywhere.
        if (!this.trading || !approval.tradeTicketId) {
          throw new Error('trade approval has no trading client or ticket id');
        }
        const settled = await settleTradeTicket(
          this.trading,
          approval.tradeTicketId,
          approval.tradeIds ?? [],
          approval.requestedByName, // approved on behalf of the requester
          'executed',
          null,
        );
        await this.tg.sendChunked(chatId, settled.text, this.config.maxMessageChars);
        return true;
      } else if (approval.kind === 'query') {
        const response = approval.heldResponse;
        if (!response) throw new Error('approved query has no held response');

        {
          const text = formatQueryResponse(response);
          await this.tg.sendChunked(chatId, text, this.config.maxMessageChars);
          return true;
        }
        /* Superseded re-prompt path retained only for reconciliation traceability.

        // If governance still requires a co-sign on the second attempt, the
        // policy has not changed and the approval did not satisfy it. Prompt
        // again rather than silently looping.
        if (response!.governance.human_cosign_required) {
          await this.tg.sendMessage({
            chat_id: chatId,
            text:
              '⚠️ The runtime still requires a co-sign after approval. ' +
              'The policy may have changed, or the request crosses a gate that requires a second approver. ' +
              'A new approval request has been created.',
          });
          await this.handleCosignRequired(
            'query',
            chatId,
            approval.requestedByUserId,
            approval.requestedByName,
            approval.payload,
            response!,
            (
              await this.tg.sendMessage({ chat_id: chatId, text: '⏳ Re-routing…' })
            ).message_id,
          );
          return true;
        }

        const text = formatQueryResponse(response!);
        await this.tg.sendChunked(chatId, text, this.config.maxMessageChars);
        */
      } else {
        if (!approval.runtimeApprovalId) throw new Error('approved mission has no runtime settlement id');
        const response = await this.ronor.settleApproval(approval.runtimeApprovalId, 'approved') as RuntimeMissionResponse;

        {
          const text = formatMissionResponse(response);
          await this.tg.sendChunked(chatId, text, this.config.maxMessageChars);
          return true;
        }
        /* Superseded re-prompt path retained only for reconciliation traceability.

        if (response.governance.human_cosign_required) {
          await this.tg.sendMessage({
            chat_id: chatId,
            text: '⚠️ The runtime still requires a co-sign after approval. A new approval request has been created.',
          });
          await this.handleCosignRequired(
            'mission',
            chatId,
            approval.requestedByUserId,
            approval.requestedByName,
            approval.payload,
            response,
            (
              await this.tg.sendMessage({ chat_id: chatId, text: '⏳ Re-routing…' })
            ).message_id,
          );
          return true;
        }

        const text = formatMissionResponse(response);
        await this.tg.sendChunked(chatId, text, this.config.maxMessageChars);
        */
      }
    } catch (err) {
      logger.error('resubmit error:', err);
      await this.tg.sendMessage({
        chat_id: chatId,
        text: `❌ Error re-submitting approved request: ${esc(String(err))}`,
        parse_mode: 'HTML',
      }).catch(() => undefined);
      return false;
    }
  }
}
