/**
 * RONOR — L0 · Telegram · Energy Trading · Command Handlers
 * ──────────────────────────────────────────────────────────
 * Every command is a pure function of (parsed args, user identity, trading
 * client) → formatted text for the bot to send. Handlers never touch the
 * Telegram API directly; they never write to the audit log; they never bypass
 * the role model. The dispatcher enforces role gating BEFORE calling any
 * handler, and the ledger service records the outcome AFTER.
 *
 * Command → arm-endpoint mapping (matches Muse's api.py 1:1)
 * ──────────────────────────────────────────────────────────
 *   /energy_status   → GET  /api/health
 *   /energy_report   → POST /api/operator
 *   /brief           → POST /api/ronor
 *   /day             → GET  /api/day
 *   /pl              → POST /api/ronor (labelled prompt over the ledger)
 *   /trade_request   → POST /api/run   (arm proposes trades into the book)
 *                      then the co-sign flow calls POST /api/nominate
 *   /approve TICKET  → POST /api/nominate for that trade id (arm's own auth)
 *                      when the whole book is approved: POST /api/settle
 *   /upload_case     → POST /api/ops-upload (writes bids_<day>.csv — the
 *                      canonical structured-learning channel)
 *   /feedback        → POST /api/operator with a [TRAINER_FEEDBACK] label.
 *                      NOTE: this feeds the arm's reasoning log but does NOT
 *                      write bids_<day>.csv. Structured position updates go
 *                      through /upload_case. See obs. 2 in Muse's review.
 *   /correct         → POST /api/operator with a [TRAINER_CORRECTION] label.
 *                      Same caveat as /feedback.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import { createLogger } from '../../../utils/logger';
import { TradingClient, TradingApiError, TradeShape } from './trading-client';
import type { RoleAssignment } from './roles';
import { describeRole } from './roles';

const logger = createLogger('RONOR:Telegram:EnergyTrading:Handlers');

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…';
}

function formatTradingError(err: unknown, action: string): string {
  if (err instanceof TradingApiError) {
    const detail = err.body ? truncate(err.body, 500) : '(no body)';
    return [
      `⚠️ <b>Trading arm error</b> — ${esc(action)}`,
      '',
      `<i>${esc(err.message)}</i>`,
      '',
      `<pre>${esc(detail)}</pre>`,
    ].join('\n');
  }
  const msg = (err as Error).message || String(err);
  return `⚠️ <b>Trading arm error</b> — ${esc(action)}\n\n<i>${esc(msg)}</i>`;
}

function formatTrade(t: TradeShape): string {
  return `${t.id.slice(0, 8)}  ${t.from_zone}→${t.to_zone}  ${t.volume_mw.toFixed(0)} MW  ` +
    `spread=${(t.sell_price - t.buy_price).toFixed(2)}  pnl=${t.expected_pnl.toFixed(0)}€  [${t.status}]`;
}

// ---------------------------------------------------------------------------
// Handler context
// ---------------------------------------------------------------------------

export interface HandlerContext {
  userId: number;
  userName: string;
  assignment: RoleAssignment;
  client: TradingClient;
}

// ---------------------------------------------------------------------------
// Read commands
// ---------------------------------------------------------------------------

export async function cmdEnergyStatus(ctx: HandlerContext): Promise<string> {
  try {
    const h = await ctx.client.health();
    const lines = [
      '⚡ <b>Energy Trading Arm — status</b>',
      '',
      `state: ${h.status === 'ok' ? '✅ live' : '❌ ' + h.status}`,
      h.time ? `time: <code>${esc(h.time)}</code>` : null,
      h.zones && h.zones.length ? `zones: ${esc(h.zones.join(', '))}` : null,
      h.scheduler !== undefined ? `scheduler: ${h.scheduler ? 'on' : 'off'}` : null,
      h.ronor_brain
        ? `ronor brain: ${h.ronor_brain.ollama ? 'on' : 'off'}` +
          (h.ronor_brain.model ? ` (${esc(h.ronor_brain.model)})` : '')
        : null,
      '',
      `<i>you: ${esc(describeRole(ctx.assignment))}</i>`,
    ].filter((s): s is string => s !== null);
    return lines.join('\n');
  } catch (err) {
    return formatTradingError(err, '/energy_status');
  }
}

export async function cmdEnergyReport(ctx: HandlerContext, argument: string): Promise<string> {
  const prompt = argument.trim() ||
    'Give me the current crossborder situation, top 3 corridors, and any operational risk in the next 24h.';
  try {
    const brief = await ctx.client.operatorBrief(prompt, ctx.userName);
    return [
      '📊 <b>Operator brief</b>',
      brief.day ? `<i>day: ${esc(brief.day)}</i>` : null,
      '',
      esc(brief.brief),
    ].filter((s): s is string => s !== null).join('\n');
  } catch (err) {
    return formatTradingError(err, '/energy_report');
  }
}

export async function cmdDay(ctx: HandlerContext, argument: string): Promise<string> {
  const day = argument.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return '⛔ Usage: <code>/day YYYY-MM-DD</code>  (e.g. <code>/day 2026-09-14</code>)';
  }
  try {
    const d = await ctx.client.day(day);
    const rows = d.corridors.slice(0, 10).map((c) => {
      const spread = c.spread !== undefined ? c.spread.toFixed(2) : '—';
      const verdict = c.verdict ? `  · ${esc(c.verdict)}` : '';
      return `h${String(c.hour).padStart(2, '0')} ${esc(c.from)}→${esc(c.to)}  spread=${spread}${verdict}`;
    });
    return [
      `📅 <b>${esc(d.day)}</b> — top corridors`,
      '',
      rows.length > 0 ? `<pre>${rows.join('\n')}</pre>` : '<i>(no data for this day yet)</i>',
      d.notes ? `\n<i>${esc(d.notes)}</i>` : '',
    ].join('\n');
  } catch (err) {
    return formatTradingError(err, '/day');
  }
}

export async function cmdPl(ctx: HandlerContext, argument: string): Promise<string> {
  const day = argument.trim();
  const prompt = day
    ? `Summarise the proof-of-optimisation ledger for ${day}: trades initiated, nominated, settled, and net EUR. Cite corridors.`
    : 'Summarise the proof-of-optimisation ledger for the last completed day: trades initiated, nominated, settled, and net EUR. Cite corridors.';
  try {
    const r = await ctx.client.ronorText(prompt, ctx.userName);
    return [
      '📈 <b>Proof of optimisation</b>',
      '',
      esc(r.answer),
      r.citations && r.citations.length > 0
        ? '\n<i>sources: ' + r.citations.map((c) => esc(c.source)).join(', ') + '</i>'
        : '',
    ].join('\n');
  } catch (err) {
    return formatTradingError(err, '/pl');
  }
}

export async function cmdBrief(ctx: HandlerContext, argument: string): Promise<string> {
  const prompt = argument.trim();
  if (!prompt) {
    return '⛔ Usage: <code>/brief &lt;question&gt;</code>';
  }
  try {
    const r = await ctx.client.ronorText(prompt, ctx.userName);
    return [
      '🧭 <b>Brief</b>',
      '',
      esc(r.answer),
      r.reasoning ? `\n<i>reasoning: ${esc(truncate(r.reasoning, 800))}</i>` : '',
    ].join('\n');
  } catch (err) {
    return formatTradingError(err, '/brief');
  }
}

// ---------------------------------------------------------------------------
// Contribute commands
// ---------------------------------------------------------------------------

export async function cmdFeedback(ctx: HandlerContext, argument: string): Promise<string> {
  const note = argument.trim();
  if (!note) {
    return [
      '⛔ Usage: <code>/feedback &lt;note&gt;</code>',
      '',
      'Free-text feedback on a recent recommendation, correction, or observation. Feeds the arm\'s reasoning log but does NOT update the daily bids corpus — for that, use <code>/upload_case</code> with an .xlsx.',
    ].join('\n');
  }
  try {
    const r = await ctx.client.ronorText(
      `[TRAINER_FEEDBACK from ${ctx.userName}] ${note}`,
      ctx.userName,
    );
    return `✅ Feedback recorded (reasoning log).\n\n<i>${esc(truncate(r.answer, 400))}</i>`;
  } catch (err) {
    return formatTradingError(err, '/feedback');
  }
}

export async function cmdCorrect(ctx: HandlerContext, argument: string): Promise<string> {
  const note = argument.trim();
  if (!note) {
    return [
      '⛔ Usage: <code>/correct &lt;what was wrong and what is correct&gt;</code>',
      '',
      'Recorded as a correction against the arm\'s reasoning. NOT a substitute for updating <code>bids_&lt;day&gt;.csv</code> via <code>/upload_case</code> when the correction is a position/fill/limit change.',
    ].join('\n');
  }
  try {
    const r = await ctx.client.ronorText(
      `[TRAINER_CORRECTION from ${ctx.userName}] ${note}`,
      ctx.userName,
    );
    return `✅ Correction recorded (reasoning log).\n\n<i>${esc(truncate(r.answer, 400))}</i>`;
  } catch (err) {
    return formatTradingError(err, '/correct');
  }
}

// ---------------------------------------------------------------------------
// Trade initiation
// ---------------------------------------------------------------------------

/**
 * Parse a /trade_request line. This is the trainer's initiation of a trading
 * session for a specific day. It does NOT nominate a specific corridor —
 * that shape does not exist in the arm. Instead it asks the arm to PROPOSE
 * trades for that day (against overrides supplied) and returns the arm's
 * book of candidates. The sovereign then co-signs specific trade ids.
 *
 * Format:
 *   /trade_request day=YYYY-MM-DD [zones=RO,BG,UA] [min_spread=1.5]
 *                  [max_trades=5] [volume=25]
 *
 * All fields optional except day. The old form
 * `corridor=... hour=... side=...` is REJECTED with an explanation of why —
 * the arm proposes corridors, it does not accept them prescribed.
 */
export interface TradeRequestArgs {
  day: string;
  zones?: string[];
  min_spread?: number;
  max_trades?: number;
  volume_mw?: number;
}

export function parseTradeRequestArgs(argument: string): TradeRequestArgs | string {
  const raw = argument.trim();
  if (raw.length === 0) {
    return [
      '⛔ <b>Usage</b>',
      '<code>/trade_request day=YYYY-MM-DD [zones=RO,BG,UA] [min_spread=1.5] [max_trades=5] [volume=25]</code>',
      '',
      '<b>How this works</b>',
      'You do NOT prescribe a specific corridor or hour. You tell the arm which day and which zones to search, and it proposes the trades. The sovereign then co-signs the trade ids you want to execute.',
    ].join('\n');
  }

  const kv: Record<string, string> = {};
  const re = /(\w+)=(?:"([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    kv[m[1]] = m[2] !== undefined ? m[2] : m[3];
  }

  // Detect the obsolete shape and educate the caller.
  if ('corridor' in kv || 'hour' in kv || 'side' in kv) {
    return [
      '⛔ Old-shape request rejected.',
      '',
      'The arm proposes corridors — it does not accept them prescribed. Use:',
      '<code>/trade_request day=YYYY-MM-DD</code>',
      'plus optional <code>zones=RO,BG,UA</code>, <code>min_spread=1.5</code>, <code>max_trades=5</code>, <code>volume=25</code>.',
      '',
      'The reply will list proposed trade ids; the sovereign co-signs the ones you want.',
    ].join('\n');
  }

  if (!('day' in kv)) return '⛔ Missing required field: <code>day</code>';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(kv.day)) return '⛔ <code>day</code> must be YYYY-MM-DD';

  const known = new Set(['day', 'zones', 'min_spread', 'max_trades', 'volume']);
  for (const k of Object.keys(kv)) {
    if (!known.has(k)) return `⛔ Unknown field: <code>${esc(k)}</code>`;
  }

  const out: TradeRequestArgs = { day: kv.day };
  if ('zones' in kv) {
    out.zones = kv.zones.split(',').map((z) => z.trim()).filter((z) => z.length > 0);
  }
  if ('min_spread' in kv) {
    const n = Number(kv.min_spread);
    if (!Number.isFinite(n)) return '⛔ <code>min_spread</code> must be numeric';
    out.min_spread = n;
  }
  if ('max_trades' in kv) {
    const n = Number(kv.max_trades);
    if (!Number.isInteger(n) || n <= 0) return '⛔ <code>max_trades</code> must be a positive integer';
    out.max_trades = n;
  }
  if ('volume' in kv) {
    const n = Number(kv.volume);
    if (!Number.isFinite(n) || n <= 0) return '⛔ <code>volume</code> must be a positive number (MW)';
    out.volume_mw = n;
  }
  return out;
}

/**
 * Register a trade REQUEST with the arm. The arm proposes trades for the
 * requested day into its book and returns them. Returns:
 *   - the arm's session key (= day), which acts as the "ticket" for the
 *     co-sign gate; the sovereign approves the whole SESSION, and specific
 *     trades are nominated in the settle step
 *   - the list of proposed trade ids (visible to the sovereign)
 *   - the arm's own summary
 *
 * Does NOT nominate anything. Nomination requires a subsequent sovereign
 * co-sign, which plugs into the base bridge's approval store.
 */
export async function cmdTradeRequest(
  ctx: HandlerContext,
  argument: string,
): Promise<{ text: string; ticketId?: string; proposedTradeIds?: string[]; day?: string }> {
  const parsed = parseTradeRequestArgs(argument);
  if (typeof parsed === 'string') return { text: parsed };

  try {
    const r = await ctx.client.run(
      {
        day: parsed.day,
        zones: parsed.zones,
        min_net_spread: parsed.min_spread,
        max_trades: parsed.max_trades,
        volume_mw: parsed.volume_mw,
      },
      ctx.userName,
    );

    const book = r.portfolio.book ?? [];
    const proposed = book.filter((t) => t.status === 'proposed');
    if (proposed.length === 0) {
      return {
        text: [
          '📥 <b>Trade request registered</b> — but no trades were proposed.',
          '',
          `day: <code>${esc(parsed.day)}</code>`,
          '',
          '<i>The arm did not find any corridor clearing the current filters. Try widening <code>min_spread</code>, adding zones, or lifting <code>max_trades</code>.</i>',
        ].join('\n'),
        ticketId: undefined,
        proposedTradeIds: [],
        day: parsed.day,
      };
    }

    // Ticket id for the bridge's approval store: session-scoped rather than
    // per-trade, matching the arm's own "settle the book" semantics.
    const ticketId = `run-${parsed.day}-${Date.now().toString(36)}`;
    const tradeIds = proposed.map((t) => t.id);

    const rows = proposed.slice(0, 15).map(formatTrade);
    const truncated = proposed.length > 15 ? `\n<i>… and ${proposed.length - 15} more</i>` : '';

    const text = [
      '📥 <b>Trade request registered</b>',
      '',
      `ticket: <code>${esc(ticketId)}</code>  ·  day: <code>${esc(parsed.day)}</code>`,
      `proposed: <b>${proposed.length}</b> trade(s)`,
      '',
      `<pre>${esc(rows.join('\n'))}</pre>${truncated}`,
      '',
      '<i>⛓ Awaiting sovereign co-sign. Sovereign settles with</i>',
      `<code>/approve ${ticketId}</code>  or  <code>/reject ${ticketId} [reason]</code>`,
      '',
      '<i>Approve nominates the whole set and settles the book. To nominate a subset, ask the arm dashboard directly.</i>',
    ].join('\n');

    logger.info(`trade request registered: ticket=${ticketId} by ${ctx.userName} day=${parsed.day} count=${proposed.length}`);
    return { text, ticketId, proposedTradeIds: tradeIds, day: parsed.day };
  } catch (err) {
    return { text: formatTradingError(err, '/trade_request') };
  }
}

/**
 * Actually settle a trade ticket — called by the base bridge's approve/reject
 * flow once the sovereign co-sign is in.
 *
 * On 'executed': call /api/nominate with the proposed trade ids (marks them
 * as authorised), then call /api/settle to close the book and produce P&L.
 * On 'cancelled': do NOT nominate; the proposed trades remain in the book as
 * 'proposed' and expire on the arm's own retention policy.
 *
 * This is the ONLY caller of /api/nominate and /api/settle in the bridge.
 */
export async function settleTradeTicket(
  client: TradingClient,
  ticketId: string,
  tradeIds: string[],
  approverName: string,
  outcome: 'executed' | 'cancelled',
  notes: string | null,
): Promise<{ text: string }> {
  if (outcome === 'cancelled') {
    return {
      text: [
        '🚫 <b>Trade session cancelled</b>',
        '',
        `ticket: <code>${esc(ticketId)}</code>`,
        `proposed trades (${tradeIds.length}) will expire under the arm's retention policy.`,
        notes ? `\n<i>${esc(notes)}</i>` : '',
      ].join('\n'),
    };
  }

  try {
    const nominated = await client.nominate(tradeIds, approverName);
    const settled = await client.settleBook();
    return {
      text: [
        '✅ <b>Trade session settled</b>',
        '',
        `ticket: <code>${esc(ticketId)}</code>`,
        `nominated: <b>${nominated.nominated.length}</b>`,
        `net: <b>${settled.total_net_eur.toFixed(2)} EUR</b>`,
        '',
        settled.lines.length > 0
          ? `<pre>${esc(settled.lines
              .slice(0, 15)
              .map((l) => `${(l.trade_id || '').slice(0, 8)}  ${(l.interconnector_id || '')}  ${(l.volume_mw ?? 0).toFixed(0)} MW  ${(l.realised_pnl_eur ?? 0).toFixed(2)} EUR`)
              .join('\n'))}</pre>`
          : '<i>(no settlement lines returned)</i>',
        notes ? `\n<i>${esc(notes)}</i>` : '',
      ].join('\n'),
    };
  } catch (err) {
    return { text: formatTradingError(err, `/settle ${ticketId}`) };
  }
}

// ---------------------------------------------------------------------------
// Dispute channel (Muse's Decizia 1)
// ---------------------------------------------------------------------------

export interface DisputeArgs {
  ticket_id: string;
  trade_id?: string;
  day: string;
  reason: string;
}

export function parseDisputeArgs(argument: string): DisputeArgs | string {
  const raw = argument.trim();
  if (raw.length === 0) {
    return [
      '⛔ <b>Usage</b>',
      '<code>/dispute &lt;ticket_id&gt;[:&lt;trade_id&gt;] [day=YYYY-MM-DD] &lt;motiv&gt;</code>',
      '',
      'Exemplu:',
      '<code>/dispute run-2026-09-15-abc RO-&gt;UA la ora 14 era indisponibil pe OPCOM.</code>',
      '<code>/dispute run-2026-09-15-abc:trd-1 sell_price real 88,5 EUR/MWh.</code>',
      '',
      '<i>Textul motivului NU este parsat automat. Se scrie în disputes_&lt;day&gt;.jsonl ca dovadă. Pentru corecţii structurate (capacitate/preţ/fill), încarcă .xlsx-ul cu /upload_case.</i>',
    ].join('\n');
  }

  const parts = raw.split(/\s+/);
  const first = parts.shift();
  if (!first) return '⛔ Missing ticket id.';

  const [ticket_id, trade_id] = first.split(':', 2);
  if (!ticket_id) return '⛔ Missing ticket id.';

  let day: string | null = null;
  const rest: string[] = [];
  for (const tok of parts) {
    const m = /^day=(\d{4}-\d{2}-\d{2})$/.exec(tok);
    if (m) {
      if (day !== null) return '⛔ Multiple day= tokens.';
      day = m[1];
    } else {
      rest.push(tok);
    }
  }

  if (day === null) {
    const m = /^run-(\d{4}-\d{2}-\d{2})-/.exec(ticket_id);
    if (m) day = m[1];
    else return '⛔ Cannot infer day from ticket. Pass <code>day=YYYY-MM-DD</code>.';
  }

  const reason = rest.join(' ').trim();
  if (reason.length === 0) return '⛔ Missing dispute reason.';
  if (reason.length > 8000) return '⛔ Reason too long (max 8000 chars).';

  return { ticket_id, trade_id: trade_id || undefined, day, reason };
}

export async function cmdDispute(ctx: HandlerContext, argument: string): Promise<string> {
  const parsed = parseDisputeArgs(argument);
  if (typeof parsed === 'string') return parsed;
  try {
    const r = await ctx.client.dispute(
      {
        ticket_id: parsed.ticket_id,
        trade_id: parsed.trade_id,
        day: parsed.day,
        reason: parsed.reason,
      },
      ctx.userName,
    );
    logger.info(
      `dispute recorded: ticket=${parsed.ticket_id} trade=${parsed.trade_id ?? '-'} day=${parsed.day} by ${ctx.userName}`,
    );
    return [
      '📝 <b>Dispută înregistrată</b>',
      '',
      `ticket: <code>${esc(parsed.ticket_id)}</code>` +
        (parsed.trade_id ? `  ·  trade: <code>${esc(parsed.trade_id)}</code>` : ''),
      `zi: <code>${esc(parsed.day)}</code>  ·  actor: <code>${esc(ctx.userName)}</code>`,
      `înregistrat la: <code>${esc(r.recorded_at)}</code>`,
      '',
      `<i>Textul motivului nu a fost interpretat de parser — trăieşte doar în disputes_${esc(parsed.day)}.jsonl.</i>`,
      '<i>Pentru a corecta capacitate/preţ/fill într-o formă pe care twin-ul o poate consuma, încarcă .xlsx-ul cu /upload_case pe aceeaşi zi.</i>',
    ].join('\n');
  } catch (err) {
    return formatTradingError(err, '/dispute');
  }
}

// ---------------------------------------------------------------------------
// Structured ingest (Muse's Decizia 2: no OCR)
// ---------------------------------------------------------------------------

export function cmdUploadCaseHint(argument: string): { text: string; day: string | null } {
  const raw = argument.trim();
  const m = /^day=(\d{4}-\d{2}-\d{2})$/.exec(raw);
  const day = m ? m[1] : null;
  const dayLine = day
    ? `Zi setată: <code>${esc(day)}</code>.`
    : 'Nu ai specificat o zi — default: azi (CET).';
  const text = [
    '📎 <b>Încarcă poziţia zilnică</b>',
    '',
    dayLine,
    '',
    '<b>Formate acceptate</b>',
    '· <code>.xlsx</code> / <code>.xlsm</code> / <code>.csv</code> — procesate în bids_&lt;day&gt;.csv.',
    '· Text lipit într-un mesaj următor — procesat prin /api/ops-parse.',
    '',
    '<b>Ce refuzăm expres</b>',
    '· <b>Screenshot / poză cu tabel Excel</b> — fără OCR. Cifră citită prost în trading nu e zgomot, e P&amp;L fals cu aparenţă de precizie. Trimite fişierul original sau lipeşte cifrele ca text.',
    '· <b>PDF neatestat</b> — acelaşi motiv.',
    '',
    'Trimite acum: fişier ca attachment SAU text în următorul mesaj.',
  ].join('\n');
  return { text, day };
}

export async function handleUploadCasePayload(
  ctx: HandlerContext,
  payload:
    | { kind: 'file'; bytes: Uint8Array; filename: string; day: string }
    | { kind: 'text'; text: string; day: string }
    | { kind: 'image' | 'pdf' | 'unsupported'; filename?: string; day: string },
): Promise<string> {
  if (payload.kind === 'image' || payload.kind === 'pdf' || payload.kind === 'unsupported') {
    const what =
      payload.kind === 'image'
        ? 'imagine / screenshot'
        : payload.kind === 'pdf'
          ? 'PDF'
          : 'format nesuportat';
    return [
      `⛔ <b>Refuzat</b>: ${what}` + (payload.filename ? ` (${esc(payload.filename)})` : ''),
      '',
      'Regula: fişier original (.xlsx / .csv) sau text lipit — fără OCR pe cifre de trading.',
      '',
      'Opţiuni:',
      '· exportă tabelul în .xlsx / .csv şi retrimite',
      '· sau lipeşte cifrele ca text într-un mesaj nou',
    ].join('\n');
  }
  try {
    if (payload.kind === 'file') {
      const r = await ctx.client.opsUpload(
        payload.bytes,
        payload.filename,
        payload.day,
        ctx.userName,
      );
      return [
        '✅ <b>Încarcat</b>',
        '',
        `fişier: <code>${esc(payload.filename)}</code>  ·  zi: <code>${esc(payload.day)}</code>`,
        r.reply ? `\n<i>${esc(truncate(r.reply, 600))}</i>` : '',
      ].join('\n');
    }
    if (payload.kind !== 'text') {
      // Exhaustiveness guard — image/pdf/unsupported are handled above.
      return '⛔ Internal: unhandled payload kind.';
    }
    const r = await ctx.client.ronorText(
      `[OPS_INTAKE day=${payload.day} from ${ctx.userName}]\n${payload.text}`,
      ctx.userName,
    );
    return [
      '✅ <b>Text înregistrat</b>',
      '',
      `zi: <code>${esc(payload.day)}</code>`,
      '',
      `<i>${esc(truncate(r.answer, 500))}</i>`,
      '',
      '<i>Notă: textul liber intră doar în raportul de raţionament. Pentru poziţie/fill/limite, foloseşte .xlsx.</i>',
    ].join('\n');
  } catch (err) {
    return formatTradingError(err, '/upload_case');
  }
}

export async function cmdHistory(ctx: HandlerContext, argument: string): Promise<string> {
  const m = /^day=(\d{4}-\d{2}-\d{2})$/.exec(argument.trim());
  if (!m) return '⛔ Usage: <code>/history day=YYYY-MM-DD</code>';
  const day = m[1];
  try {
    const r = await ctx.client.run({ day }, ctx.userName);
    const book = r.portfolio.book ?? [];
    return [
      '📚 <b>Re-run istoric</b>',
      '',
      `zi: <code>${esc(day)}</code>  ·  book: <b>${book.length}</b> trade(s)`,
      '',
      `<i>Twin-ul a recomputat ziua pe corpusul curent. Verifică /day ${esc(day)} şi /pl ${esc(day)}.</i>`,
    ].join('\n');
  } catch (err) {
    return formatTradingError(err, '/history');
  }
}

// ---------------------------------------------------------------------------
// Onboarding text (used at first /start of a trading_trainer)
// ---------------------------------------------------------------------------

/**
 * Trainer onboarding shown on /start. `userName` MUST be HTML-escaped by the
 * caller — this function assumes any interpolation upstream is safe. To keep
 * the surface trivially auditable, we escape it here too.
 */
export function tradingTrainerOnboarding(userName: string): string {
  const name = esc(userName);
  return [
    `👋 Bine ai venit, ${name}.`,
    '',
    'Ai fost înrolată în RONOR ca <b>nrgpaths:trading_trainer</b>. Acest bot este brațul de trading crossborder de energie electrică. Rolul tău este să inițiezi sesiuni de trading (fără plafon de volum), să contribui cazuri și feedback, și să vezi rapoarte. Fiecare sesiune propusă de arm necesită co-semnătură din partea suveranului (Liviu) înainte de a fi nominată și decontată.',
    '',
    '<b>Fluxul unei sesiuni de trading</b>',
    '1. Tu: <code>/trade_request day=YYYY-MM-DD</code> (opțional <code>zones=</code>, <code>min_spread=</code>, <code>max_trades=</code>, <code>volume=</code>).',
    '2. Arm-ul propune trade-uri în book și îți răspunde cu lista.',
    '3. Suveranul primește o cerere de co-sign; dă <code>/approve &lt;ticket&gt;</code> sau <code>/reject &lt;ticket&gt; [motiv]</code>.',
    '4. Pe approve, arm-ul nominalizează trade-urile și decontează book-ul; primești P&amp;L-ul.',
    '',
    '<b>Comenzi disponibile</b>',
    '/energy_status — starea arm-ului',
    '/energy_report [prompt] — brief operațional curent',
    '/day YYYY-MM-DD — top coridoare pe o zi',
    '/pl [day] — proof-of-optimisation pentru zi',
    '/brief &lt;întrebare&gt; — întrebare liberă către raționament',
    '/trade_request day=... — cerere de sesiune de trading',
    '/upload_case — încarcă .xlsx cu poziția zilnică (feed structurat în bids_&lt;day&gt;.csv)',
    '/feedback &lt;text&gt; — feedback liber pe raționament (nu update la bids)',
    '/correct &lt;text&gt; — corecție liberă pe raționament (nu update la bids)',
    '/dispute &lt;ticket&gt;[:&lt;trade&gt;] &lt;motiv&gt; — contestă un ticket sau un trade (append-only, audit trail)',
    '/history day=YYYY-MM-DD — re-computează o zi istorică după upload',
    '',
    '<b>Ce nu poți face din rolul actual</b>',
    '· nu poți nominaliza sau deconta un book fără co-sign suveran',
    '· nu ai acces la comenzile generale RONOR (query, mission, runtime status)',
    '',
    '<b>Atenție</b>',
    'Actualizările structurate (poziție, umpluturi, limite) merg PRIN <code>/upload_case</code> cu un .xlsx. <code>/feedback</code> și <code>/correct</code> alimentează doar raționamentul arm-ului, nu corpusul de învățare zilnic.',
    '',
    'Când ai nevoie, scrie /help.',
  ].join('\n');
}
