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
 *   4. On approval: re-submits the original request to the runtime. The runtime
 *      re-runs governance; if it still requires a co-sign, a new prompt is sent.
 *   5. On rejection: notifies the requester and records the decision.
 *   6. On expiry: the approval is refused and the requester is notified.
 *
 * The runtime is NOT told that a gate was settled via a side-channel. It re-runs
 * governance on every submission. This is correct: governance is not a one-time
 * check that can be bypassed by a stored token; it is a function of the request
 * and the current policy, and both may have changed.
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
  private pollOffset = 0;
  private running = false;
  private pruneInterval: NodeJS.Timeout | null = null;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.tg = new TelegramApiClient(config.botToken);
    this.ronor = new RonorRuntimeClient(config.apiBaseUrl, config.apiKey);
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

    if (!userId || msg.text === undefined || text.trim().length === 0) return;
    // Conversational mode: plain text (no / prefix) is treated as /query.
    // Auth and rate-limit checks still run below before the query is forwarded.
    const isPlainText = !text.startsWith('/');

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

    // Conversational passthrough: route plain text directly to query handler.
    if (isPlainText) {
      logger.info(`conversational query from user ${userId} in chat ${chatId}`);
      await this.cmdQuery(chatId, msg.message_id, userId, msg.from?.first_name ?? 'Operator', text.trim());
      return;
    }
    const cmd = parseCommand(text);
    logger.info(`command /${cmd.name} from user ${userId} in chat ${chatId}`);

    switch (cmd.name) {
      case 'start':
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
      '<b>Gate 1/2 approval flow</b>',
      'When MI9 governance requires a co-sign, RONOR sends you a prompt. Reply with /approve or /reject. The request expires if not settled within the configured TTL.',
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

    const settled = settleApproval(approval.approvalId, 'approved', userId, note);
    if (!settled) {
      await this.tg.sendMessage({ chat_id: chatId, text: '⚠️ Could not settle the approval (already settled or expired).' });
      return;
    }

    await this.tg.sendMessage({
      chat_id: chatId,
      text: `✅ Approval <code>${esc(approval.approvalId)}</code> granted. Re-submitting to RONOR…`,
      parse_mode: 'HTML',
    });

    // Notify the original requester if they are in a different chat.
    if (approval.chatId !== chatId) {
      await this.tg.sendMessage({
        chat_id: approval.chatId,
        text: `✅ Your ${esc(approval.kind)} request has been approved. Re-submitting…`,
        parse_mode: 'HTML',
      }).catch((e) => logger.warn('could not notify requester:', e));
    }

    // Re-submit the original request.
    await this.resubmitApproved(approval);
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

    const approval = createApproval({
      kind,
      requestId: response.request_id,
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
  // Re-submit after approval
  // -------------------------------------------------------------------------

  private async resubmitApproved(approval: PendingApproval): Promise<void> {
    const chatId = approval.chatId;
    try {
      if (approval.kind === 'query') {
        const { response } = await this.ronor.query({
          query: approval.payload,
          operator_id: `tg:${approval.requestedByUserId}`,
          use_knowledge: true,
        });

        // If governance still requires a co-sign on the second attempt, the
        // policy has not changed and the approval did not satisfy it. Prompt
        // again rather than silently looping.
        if (response.governance.human_cosign_required) {
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
            response,
            (
              await this.tg.sendMessage({ chat_id: chatId, text: '⏳ Re-routing…' })
            ).message_id,
          );
          return;
        }

        const text = formatQueryResponse(response);
        await this.tg.sendChunked(chatId, text, this.config.maxMessageChars);
      } else {
        const { response } = await this.ronor.dispatchMission({
          objective: approval.payload,
          operator_id: `tg:${approval.requestedByUserId}`,
          use_knowledge: true,
          require_evidence: true,
        });

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
          return;
        }

        const text = formatMissionResponse(response);
        await this.tg.sendChunked(chatId, text, this.config.maxMessageChars);
      }
    } catch (err) {
      logger.error('resubmit error:', err);
      await this.tg.sendMessage({
        chat_id: chatId,
        text: `❌ Error re-submitting approved request: ${esc(String(err))}`,
        parse_mode: 'HTML',
      }).catch(() => undefined);
    }
  }
}
