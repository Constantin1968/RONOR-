/**
 * RONOR — L0 · Telegram · Energy Trading · HTTP Client
 * ────────────────────────────────────────────────────
 * Thin, typed wrapper over the trading arm's FastAPI, reachable only from the
 * internal docker network at TRADING_ARM_BASE_URL. Every request carries the
 * X-RONOR-Token header (`ET_API_TOKEN`) which the arm requires on the
 * privileged endpoints. The token IS the access boundary — anything on the
 * docker network holding it can move against the ledger, so it lives in
 * .env.production and rotates on operator change.
 *
 * Shape parity with the Muse-authored arm (services/energy-trading-arm/src/energy_trading/api.py)
 * ────────────────────────────────────────────────────────────────────────
 *   POST /api/run       — propose trades for a day. Body: RunRequest.
 *                         Returns { log, portfolio } where the portfolio's
 *                         open book carries the newly proposed trade ids.
 *   GET  /api/book      — read the current book (proposed + nominated).
 *   POST /api/nominate  — mark proposed trades as nominated. Body:
 *                         { trade_ids: string[] }. Requires operator identity
 *                         header. This is the ARM'S authorisation step; the
 *                         Telegram bridge invokes it AFTER a sovereign
 *                         co-sign has cleared through the bridge's own gate.
 *   POST /api/settle    — settle the entire book. No body. Returns P&L lines
 *                         and total_net_eur. Called by the sovereign.
 *   GET  /api/claims    — read claims (evidence entries).
 *   POST /api/ops-upload — upload a daily-ops workbook (.xlsx or .csv). This
 *                         is the STRUCTURED-learning channel: the file lands
 *                         in bids_<day>.csv and becomes part of the twin's
 *                         corpus for that day. See obs. 2 in Muse's review.
 *   POST /api/operator  — free-form operator brief (deterministic).
 *   POST /api/ronor     — free-form structured reasoning (same brain).
 *   GET  /api/day       — the day view (top corridors, spreads, verdicts).
 *   GET  /api/health    — liveness + arm-side feature flags.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import { createLogger } from '../../../utils/logger';

const logger = createLogger('RONOR:Telegram:EnergyTrading:Client');

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TradingApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'TradingApiError';
  }
}

// ---------------------------------------------------------------------------
// Response shapes — kept aligned with the arm's Pydantic models. Optional
// fields tolerate arm-side additions without a client rebuild.
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;                 // "ok"
  time?: string;
  zones?: string[];
  scheduler?: boolean;
  telegram?: boolean;
  ronor_brain?: { ollama?: boolean; model?: string };
}

export interface TradeShape {
  id: string;
  interconnector_id: string;
  from_zone: string;
  to_zone: string;
  delivery_start: string;
  market: string;
  volume_mw: number;
  buy_price: number;
  sell_price: number;
  transport_cost: number;
  expected_pnl: number;
  status: string;                 // proposed | nominated | scheduled | settled | rejected
  reason?: string;
  nominated_by?: string;
  nominated_at?: string | null;
  created_at?: string;
}

export interface PortfolioSummary {
  count?: number;
  total_notional_eur?: number;
  expected_pnl_eur?: number;
  by_zone?: Record<string, number>;
  book?: TradeShape[];
}

export interface RunResponse {
  log: unknown;                   // opaque; the arm's own MissionLog
  portfolio: PortfolioSummary;
}

export interface BookResponse {
  count: number;
  trades: TradeShape[];
  summary: PortfolioSummary;
}

export interface NominateResponse {
  nominated: TradeShape[];
}

export interface SettleLine {
  trade_id?: string;
  interconnector_id?: string;
  volume_mw?: number;
  realised_pnl_eur?: number;
  [k: string]: unknown;
}

export interface SettleResponse {
  lines: SettleLine[];
  total_net_eur: number;
}

export interface OperatorBrief {
  brief: string;
  day?: string;
  citations?: Array<{ source: string }>;
  [k: string]: unknown;
}

export interface RonorAnswer {
  answer: string;
  reasoning?: string;
  citations?: Array<{ source: string }>;
  [k: string]: unknown;
}

export interface DayCorridorRow {
  from: string;
  to: string;
  hour: number;
  spread?: number;
  verdict?: string;
}

export interface DayView {
  day: string;
  corridors: DayCorridorRow[];
  notes?: string;
}

export interface ClaimsResponse {
  count: number;
  claims: unknown[];
}

export interface OpsUploadResponse {
  reply?: string;
  intake?: unknown;
  [k: string]: unknown;
}

/**
 * Corrective values pushed alongside a dispute. Optional; if present, the arm
 * merges them into ``bids_<day>.csv`` via ``write_bids_csv`` so the twin re-runs
 * the contested day. Shape mirrors the arm's ``CorrectiveAction``:
 *   { capacity|cbc|limits|filled|realized: { corridor: { hour: number } } }
 * where corridor is ``FROM->TO`` (e.g. ``RO->UA``) and hour is 1-24 in CET, or
 * 0 for the day-total pseudo-hour.
 */
export interface DisputeCorrectiveAction {
  capacity?: Record<string, Record<number, number>>;
  cbc?: Record<string, Record<number, number>>;
  limits?: Record<string, Record<number, number>>;
  filled?: Record<string, Record<number, number>>;
  realized?: Record<string, Record<number, number>>;
}

export interface DisputeRequestBody {
  ticket_id: string;                    // e.g. run-2026-09-15-abc
  trade_id?: string;                    // optional: whole ticket vs one trade
  day: string;                          // ISO YYYY-MM-DD
  reason: string;                       // free text; never touches ops_intake regex
  corrective_action?: DisputeCorrectiveAction;
}

export interface DisputeResponse {
  recorded: boolean;
  day: string;
  ticket_id: string;
  trade_id?: string | null;
  actor: string;
  recorded_at: string;
  jsonl_path: string;
  materialised: unknown | null;
}

export interface DisputeListEntry {
  recorded_at: string;
  actor: string;
  ticket_id: string;
  trade_id?: string | null;
  day: string;
  reason: string;
  corrective_action?: unknown;
}

export interface DisputesResponse {
  count: number;
  disputes: DisputeListEntry[];
}

// ---------------------------------------------------------------------------
// Request shapes for the two endpoints Natalia's flow touches
// ---------------------------------------------------------------------------

export interface RunRequestBody {
  day: string;                    // ISO date (YYYY-MM-DD)
  zones?: string[];
  availability?: Record<string, number | Record<number, number>>;
  prices_override?: Record<string, Record<number, number>>;
  min_net_spread?: number;
  max_trades?: number;
  volume_mw?: number;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface TradingClientOptions {
  baseUrl: string;
  apiToken: string;
  requestTimeoutMs?: number;
}

export class TradingClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly requestTimeoutMs: number;

  constructor(opts: TradingClientOptions) {
    // Strip a trailing slash so path joins never produce '//api/...'.
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiToken = opts.apiToken;
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 30000;
  }

  // -------------------------------------------------------------------------
  // Public API — one method per Telegram-touched endpoint
  // -------------------------------------------------------------------------

  health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/api/health');
  }

  run(body: RunRequestBody, who: string): Promise<RunResponse> {
    // /api/run is not X-RONOR-Token-gated in the arm today, but we send the
    // header on every request so a future tightening of the arm needs no
    // client change.
    return this.postJson<RunResponse>('/api/run', body, { who });
  }

  book(): Promise<BookResponse> {
    return this.get<BookResponse>('/api/book');
  }

  nominate(tradeIds: string[], who: string): Promise<NominateResponse> {
    return this.postJson<NominateResponse>('/api/nominate', { trade_ids: tradeIds }, { who });
  }

  settleBook(): Promise<SettleResponse> {
    return this.postJson<SettleResponse>('/api/settle', {}, {});
  }

  claims(kind?: string): Promise<ClaimsResponse> {
    const q = kind ? `?kind=${encodeURIComponent(kind)}` : '';
    return this.get<ClaimsResponse>(`/api/claims${q}`);
  }

  day(day: string, refresh = false): Promise<DayView> {
    const q = `?day=${encodeURIComponent(day)}${refresh ? '&refresh=true' : ''}`;
    return this.get<DayView>(`/api/day${q}`);
  }

  operatorBrief(text: string, who: string): Promise<OperatorBrief> {
    return this.postJson<OperatorBrief>('/api/operator', { text, who }, { who });
  }

  ronorText(text: string, who: string): Promise<RonorAnswer> {
    return this.postJson<RonorAnswer>('/api/ronor', { text, who }, { who });
  }

  /**
   * Record a trainer / operator dispute. Muse's Decizia 1: a dedicated channel,
   * NOT ``/api/ops-parse`` with a ``[DISPUTE]`` tag, because the intake parser
   * would extract phantom borders / MW / prices from the reason text and
   * silently corrupt the day. The reason string here lives in
   * ``disputes_<day>.jsonl`` only. Any structured correction goes in
   * ``corrective_action`` and materialises into ``bids_<day>.csv``.
   */
  dispute(body: DisputeRequestBody, who: string): Promise<DisputeResponse> {
    return this.postJson<DisputeResponse>('/api/dispute', body, { who });
  }

  listDisputes(day?: string): Promise<DisputesResponse> {
    const q = day ? `?day=${encodeURIComponent(day)}` : '';
    return this.get<DisputesResponse>(`/api/disputes${q}`);
  }

  /**
   * Upload a daily-ops workbook. THIS is where /upload_case lands the
   * trainer's structured contribution — the arm writes it to bids_<day>.csv
   * and the twin picks it up. Free-form /feedback and /correct do NOT feed
   * this corpus; they go through /api/operator with a labelled prompt.
   */
  async opsUpload(
    fileBytes: Uint8Array,
    filename: string,
    day: string,
    who: string,
    apply = true,
  ): Promise<OpsUploadResponse> {
    const url = `${this.baseUrl}/api/ops-upload?day=${encodeURIComponent(day)}&apply=${apply ? 'true' : 'false'}&source=telegram`;
    // multipart/form-data — Node 18+ globals FormData/Blob are used. The DOM
    // lib is intentionally not enabled in tsconfig (server-side project), so
    // FormData/Blob are typed as any at compile time and constructed at
    // runtime; the Node built-ins have the same shape as the fetch spec.
    const F = (globalThis as any).FormData;
    const B = (globalThis as any).Blob;
    const form = new F();
    form.append('file', new B([fileBytes]), filename);
    return this.request<OpsUploadResponse>(url, {
      method: 'POST',
      body: form,
      extraHeaders: { 'X-Operator-Who': who },
    });
  }

  // -------------------------------------------------------------------------
  // Transport
  // -------------------------------------------------------------------------

  private get<T>(path: string): Promise<T> {
    return this.request<T>(`${this.baseUrl}${path}`, { method: 'GET' });
  }

  private postJson<T>(path: string, body: unknown, opts: { who?: string }): Promise<T> {
    return this.request<T>(`${this.baseUrl}${path}`, {
      method: 'POST',
      body: JSON.stringify(body),
      extraHeaders: {
        'Content-Type': 'application/json',
        ...(opts.who ? { 'X-Operator-Who': opts.who } : {}),
      },
    });
  }

  private async request<T>(
    url: string,
    init: { method: string; body?: unknown; extraHeaders?: Record<string, string> },
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const res = await fetch(url, {
        method: init.method,
        headers: {
          'X-RONOR-Token': this.apiToken,
          ...(init.extraHeaders ?? {}),
        },
        body: init.body as any,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        logger.warn(`arm ${init.method} ${url} → ${res.status}: ${text.slice(0, 400)}`);
        throw new TradingApiError(
          res.status,
          text,
          `Trading arm returned HTTP ${res.status} for ${init.method} ${url}`,
        );
      }
      if (text.length === 0) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        throw new TradingApiError(res.status, text, `Trading arm returned non-JSON for ${init.method} ${url}`);
      }
    } finally {
      clearTimeout(timer);
    }
  }
}
