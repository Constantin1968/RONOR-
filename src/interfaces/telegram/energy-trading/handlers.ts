/**
 * RONOR — L0 · Telegram · Energy Trading · Command Handlers
 * ──────────────────────────────────────────────────────────
 * Every command is a pure function of (parsed args, user identity, trading
 * client) → formatted text for the bot to send. Handlers never touch the
 * Telegram API directly; they never write to the audit log; they never bypass
 * the role model. The dispatcher enforces role gating BEFORE calling any
 * handler, and the ledger service records the outcome AFTER.
 *
 * That layering is deliberate: it means a bug in a handler can produce a bad
 * message but cannot silently execute a trade or leak a route to the wrong
 * user. Handlers are the last mile, not the first.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import { createLogger } from '../../../utils/logger';
import { TradingClient, TradingApiError } from './trading-client';
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
      `state: ${h.ok ? '✅ live' : '❌ down'}`,
      h.version ? `version: <code>${esc(h.version)}</code>` : null,
      h.timezone ? `tz: ${esc(h.timezone)}` : null,
      h.scheduler_enabled !== undefined
        ? `scheduler: ${h.scheduler_enabled ? 'on' : 'off'}`
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
  const prompt = argument.trim() || 'Give me the current crossborder situation, top 3 corridors, and any operational risk in the next 24h.';
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
  // /pl [day] — proof-of-optimisation summary. Falls through to /api/ronor with
  // a fixed prompt so the arm's own reasoner produces the answer, keeping the
  // bot free of business rules that belong in the arm.
  const day = argument.trim();
  const prompt = day
    ? `Summarise the proof-of-optimisation ledger for ${day}: trades initiated, approved, cancelled, and estimated uplift vs baseline. Cite corridors.`
    : 'Summarise the proof-of-optimisation ledger for the last completed day: trades initiated, approved, cancelled, and estimated uplift vs baseline. Cite corridors.';
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
  // Free-form question to the arm's reasoner. Same as /energy_report but goes
  // through the /api/ronor endpoint (text-in, structured reasoning) rather
  // than /api/operator (brief-in, decision-oriented output).
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
      'Free-text feedback on a recent recommendation, correction, or observation. Stored in the trainer corpus.',
    ].join('\n');
  }
  try {
    // Feedback rides on /api/ronor with a labelled prompt so the arm's log
    // captures it as a trainer contribution rather than a query.
    const r = await ctx.client.ronorText(
      `[TRAINER_FEEDBACK from ${ctx.userName}] ${note}`,
      ctx.userName,
    );
    return `✅ Feedback recorded.\n\n<i>${esc(truncate(r.answer, 400))}</i>`;
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
      'Recorded as a correction against the arm\'s reasoning. Used in next fine-tune / prompt refinement.',
    ].join('\n');
  }
  try {
    const r = await ctx.client.ronorText(
      `[TRAINER_CORRECTION from ${ctx.userName}] ${note}`,
      ctx.userName,
    );
    return `✅ Correction recorded.\n\n<i>${esc(truncate(r.answer, 400))}</i>`;
  } catch (err) {
    return formatTradingError(err, '/correct');
  }
}

// ---------------------------------------------------------------------------
// Trade initiation
// ---------------------------------------------------------------------------

/**
 * Parse a /trade_request line. Format is deliberately explicit:
 *
 *   /trade_request corridor=RO->UA day=2026-09-15 hour=10 volume=25 side=export price_ceiling=140 notes="test"
 *
 * Keys with an equals sign; unknown keys refused; missing required keys
 * refused. A freeform "just do X" prompt would be shorter but every trainer
 * question begins as an explicit ticket the sovereign can co-sign; the format
 * IS the discipline.
 */
export interface TradeRequestArgs {
  corridor: string;
  day: string;
  hour: number;
  volume_mw: number;
  side: 'export' | 'import';
  price_ceiling?: number;
  notes?: string;
}

export function parseTradeRequestArgs(argument: string): TradeRequestArgs | string {
  const raw = argument.trim();
  if (raw.length === 0) {
    return [
      '⛔ Usage:',
      '<code>/trade_request corridor=RO-&gt;UA day=2026-09-15 hour=10 volume=25 side=export [price_ceiling=140] [notes="..."]</code>',
      '',
      '<b>Required:</b> corridor · day (YYYY-MM-DD) · hour (0-23) · volume (MW) · side (export|import)',
      '<b>Optional:</b> price_ceiling (EUR/MWh) · notes',
    ].join('\n');
  }

  const kv: Record<string, string> = {};
  // Handle quoted values (notes="...")
  const re = /(\w+)=("([^"]*)"|(\S+))/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const key = m[1];
    const value = m[3] !== undefined ? m[3] : m[4];
    kv[key] = value;
  }

  const required = ['corridor', 'day', 'hour', 'volume', 'side'];
  for (const k of required) {
    if (!(k in kv)) return `⛔ Missing required field: <code>${esc(k)}</code>`;
  }
  const known = new Set([...required, 'price_ceiling', 'notes']);
  for (const k of Object.keys(kv)) {
    if (!known.has(k)) return `⛔ Unknown field: <code>${esc(k)}</code>`;
  }

  if (!/^\d{4}-\d{2}-\d{2}$/.test(kv.day)) return '⛔ <code>day</code> must be YYYY-MM-DD';
  const hour = Number(kv.hour);
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return '⛔ <code>hour</code> must be integer 0-23';
  const vol = Number(kv.volume);
  if (!Number.isFinite(vol) || vol <= 0) return '⛔ <code>volume</code> must be a positive number (MW)';
  if (kv.side !== 'export' && kv.side !== 'import') return '⛔ <code>side</code> must be export or import';
  let ceiling: number | undefined;
  if ('price_ceiling' in kv) {
    ceiling = Number(kv.price_ceiling);
    if (!Number.isFinite(ceiling)) return '⛔ <code>price_ceiling</code> must be numeric';
  }

  return {
    corridor: kv.corridor,
    day: kv.day,
    hour,
    volume_mw: vol,
    side: kv.side,
    price_ceiling: ceiling,
    notes: kv.notes,
  };
}

/**
 * Register a trade REQUEST with the arm. Returns:
 *   - the arm's ticket id (used later to /settle)
 *   - the arm's own reasoning brief on the request
 *
 * Does NOT execute the trade. Execution requires a subsequent sovereign
 * co-sign, which is what plugs into the base bridge's approval store.
 */
export async function cmdTradeRequest(
  ctx: HandlerContext,
  argument: string,
): Promise<{ text: string; ticketId?: string; requestArgs?: TradeRequestArgs; brief?: string }> {
  const parsed = parseTradeRequestArgs(argument);
  if (typeof parsed === 'string') return { text: parsed };

  try {
    const r = await ctx.client.nominate({
      who: ctx.userName,
      corridor: parsed.corridor,
      day: parsed.day,
      hour: parsed.hour,
      volume_mw: parsed.volume_mw,
      side: parsed.side,
      price_ceiling: parsed.price_ceiling,
      notes: parsed.notes,
    });

    const text = [
      '📥 <b>Trade request registered</b>',
      '',
      `ticket: <code>${esc(r.ticket_id)}</code>`,
      `corridor: <code>${esc(parsed.corridor)}</code>  ·  day: <code>${esc(parsed.day)}</code>  ·  hour: <code>${parsed.hour}</code>`,
      `side: <code>${esc(parsed.side)}</code>  ·  volume: <code>${parsed.volume_mw} MW</code>` +
        (parsed.price_ceiling !== undefined ? `  ·  ceiling: <code>${parsed.price_ceiling} EUR/MWh</code>` : ''),
      '',
      '<b>Arm brief</b>',
      esc(r.brief),
      '',
      '<i>⛓ Awaiting sovereign co-sign. Sovereign settles with</i>',
      `<code>/approve ${r.ticket_id}</code>  or  <code>/reject ${r.ticket_id} [reason]</code>`,
    ].join('\n');

    logger.info(`trade request registered: ticket=${r.ticket_id} by ${ctx.userName} corridor=${parsed.corridor}`);
    return { text, ticketId: r.ticket_id, requestArgs: parsed, brief: r.brief };
  } catch (err) {
    return { text: formatTradingError(err, '/trade_request') };
  }
}

/**
 * Actually settle a trade — called by the base bridge's approve/reject flow
 * once the sovereign co-sign is in. This is the ONLY place that hits
 * /api/settle, and it is called AFTER the base bridge has verified the
 * approver identity. Handlers never trigger this on their own.
 */
export async function settleTradeTicket(
  client: TradingClient,
  ticketId: string,
  approverName: string,
  outcome: 'executed' | 'cancelled',
  notes: string | null,
): Promise<{ text: string }> {
  try {
    const r = await client.settle({
      ticket_id: ticketId,
      approved_by: approverName,
      outcome,
      notes: notes ?? undefined,
    });
    return {
      text: [
        outcome === 'executed' ? '✅ <b>Trade settled</b>' : '🚫 <b>Trade cancelled</b>',
        '',
        `ticket: <code>${esc(r.ticket_id)}</code>`,
        `final: <code>${esc(r.final_status)}</code>`,
        '',
        esc(r.brief),
      ].join('\n'),
    };
  } catch (err) {
    return { text: formatTradingError(err, `/settle ${ticketId}`) };
  }
}

// ---------------------------------------------------------------------------
// Onboarding text (used at first /start of a trading_trainer)
// ---------------------------------------------------------------------------

export function tradingTrainerOnboarding(userName: string): string {
  return [
    `👋 Bine ai venit, ${esc(userName)}.`,
    '',
    'Ai fost înrolată în RONOR ca <b>nrgpaths:trading_trainer</b>. Acest bot este brațul de trading crossborder de energie electrică. Rolul tău este să inițiezi cereri de trade (fără plafon), să contribui cazuri și feedback, și să vezi rapoarte. Fiecare cerere de trade necesită co-semnătură din partea suveranului (Liviu) înainte de a fi executată.',
    '',
    '<b>Comenzi disponibile</b>',
    '/energy_status — starea arm-ului',
    '/energy_report — brief operațional curent',
    '/day YYYY-MM-DD — top coridoare pe o zi',
    '/pl [day] — proof-of-optimisation pentru zi',
    '/brief &lt;întrebare&gt; — întrebare liberă către raționament',
    '/trade_request corridor=... day=... hour=... volume=... side=... — cerere de trade',
    '/upload_case — încarcă un caz (răspunde cu fișier .xlsx atașat)',
    '/feedback &lt;text&gt; — feedback pe o recomandare',
    '/correct &lt;text&gt; — corecție împotriva raționamentului arm-ului',
    '',
    '<b>Ce nu poți face din rolul actual</b>',
    '· nu poți executa direct un trade (co-sign obligatoriu)',
    '· nu poți vedea comenzile generale RONOR (query/mission/status runtime)',
    '',
    'Când ai nevoie, scrie /help.',
  ].join('\n');
}
