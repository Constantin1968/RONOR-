/**
 * RONOR — L0 · Telegram · Energy Trading · HTTP Client
 * ─────────────────────────────────────────────────────
 * Thin wrapper around the crossborder trading arm's FastAPI. Reached on the
 * internal docker network at http://energy-trading-arm:8000. Every request
 * carries X-RONOR-Token, whose value is the ET_API_TOKEN the arm was booted
 * with. Nothing here uses cookies or session state — every call is stateless
 * and idempotent from the client's view (idempotency on the write path is the
 * ledger's responsibility, not the client's).
 *
 * The client never uses `fetch()` blindly — every response is checked for HTTP
 * status, wrapped in a `TradingApiError` on failure, and surfaced with the
 * operator's original prompt for the bot to render clean error text.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import { createLogger } from '../../../utils/logger';

const logger = createLogger('RONOR:Telegram:EnergyTrading:Client');

export class TradingApiError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly body: string | null,
  ) {
    super(message);
    this.name = 'TradingApiError';
  }
}

export interface TradingClientConfig {
  /** Base URL of the trading arm. In compose: http://energy-trading-arm:8000 */
  baseUrl: string;
  /** Value asserted in X-RONOR-Token on every request. */
  token: string;
  /** Milliseconds before a request is abandoned. Default 30 s. */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Response shapes (partial — only fields the bot actually reads)
// ---------------------------------------------------------------------------

export interface HealthResponse {
  ok: boolean;
  version?: string;
  timezone?: string;
  scheduler_enabled?: boolean;
}

export interface OperatorBriefResponse {
  /** Free text the arm produced for the operator. */
  brief: string;
  /** Structured evidence — corridors, prices, decisions. Opaque to the bot. */
  evidence?: Record<string, unknown>;
  /** Optional day the brief refers to (YYYY-MM-DD). */
  day?: string;
}

export interface RonorTextResponse {
  answer: string;
  reasoning?: string;
  citations?: Array<{ source: string; note?: string }>;
}

export interface DayResponse {
  day: string;
  corridors: Array<{
    from: string;
    to: string;
    hour: number;
    price_export?: number;
    price_import?: number;
    spread?: number;
    verdict?: string;
  }>;
  notes?: string;
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export class TradingClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(cfg: TradingClientConfig) {
    // Trim trailing slash so path concatenation is unambiguous.
    this.baseUrl = cfg.baseUrl.replace(/\/+$/, '');
    this.token = cfg.token;
    this.timeoutMs = cfg.timeoutMs ?? 30_000;
  }

  // -------------------------------------------------------------------------
  // Public methods
  // -------------------------------------------------------------------------

  async health(): Promise<HealthResponse> {
    return this.get<HealthResponse>('/api/health');
  }

  async day(day: string): Promise<DayResponse> {
    // day = YYYY-MM-DD; the arm validates the format server-side.
    return this.get<DayResponse>(`/api/day?day=${encodeURIComponent(day)}`);
  }

  async operatorBrief(prompt: string, who: string): Promise<OperatorBriefResponse> {
    return this.post<OperatorBriefResponse>('/api/operator', { prompt, who });
  }

  async ronorText(prompt: string, who: string): Promise<RonorTextResponse> {
    return this.post<RonorTextResponse>('/api/ronor', { prompt, who });
  }

  /**
   * Register a trade REQUEST in the arm's ledger. The arm returns a ticket id
   * the bot then binds to a co-sign approval. Nothing is nominated until the
   * co-sign is settled and a subsequent /api/settle call is made.
   */
  async nominate(payload: {
    who: string;
    corridor: string;    // e.g. "RO->UA", "UA->RO via MD"
    day: string;         // YYYY-MM-DD
    hour: number;        // 0-23
    volume_mw: number;   // MW/h
    side: 'export' | 'import';
    price_ceiling?: number;
    notes?: string;
  }): Promise<{ ticket_id: string; status: 'pending' | 'accepted' | 'rejected'; brief: string }> {
    return this.post('/api/nominate', payload);
  }

  /**
   * Settle a previously nominated ticket. Requires the co-sign ticket id
   * returned by /api/nominate. The arm records the settlement in its own
   * ledger; RONOR records its own copy in optimization_ledger.
   */
  async settle(payload: {
    ticket_id: string;
    approved_by: string;
    outcome: 'executed' | 'cancelled';
    notes?: string;
  }): Promise<{ ticket_id: string; final_status: string; brief: string }> {
    return this.post('/api/settle', payload);
  }

  /**
   * Upload an operator case as multipart/form-data. The arm accepts xlsx (its
   * primary format) plus csv/json for training data. `filename` is what the
   * arm stores it as; `contentType` should match the extension.
   */
  async uploadCase(payload: {
    who: string;
    filename: string;
    contentType: string;
    fileBytes: Uint8Array;
    label?: string;
  }): Promise<{ case_id: string; brief: string }> {
    const form = new FormData();
    form.append('who', payload.who);
    if (payload.label) form.append('label', payload.label);
    form.append(
      'file',
      new Blob([payload.fileBytes], { type: payload.contentType }),
      payload.filename,
    );
    return this.postForm('/api/ops-upload', form);
  }

  /** Return recent nominations, filtered by status if provided. */
  async claims(filter: { status?: 'pending' | 'executed' | 'cancelled'; day?: string } = {}): Promise<
    Array<{ ticket_id: string; status: string; corridor: string; day: string; hour: number; volume_mw: number; who: string }>
  > {
    const params = new URLSearchParams();
    if (filter.status) params.set('status', filter.status);
    if (filter.day) params.set('day', filter.day);
    const qs = params.toString();
    return this.get(`/api/claims${qs ? `?${qs}` : ''}`);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private async get<T>(path: string): Promise<T> {
    return this.request<T>('GET', path);
  }

  private async post<T>(path: string, body: unknown): Promise<T> {
    return this.request<T>('POST', path, JSON.stringify(body), 'application/json');
  }

  private async postForm<T>(path: string, form: FormData): Promise<T> {
    return this.request<T>('POST', path, form, null); // browser sets multipart boundary
  }

  private async request<T>(
    method: string,
    path: string,
    body: string | FormData | null = null,
    contentType: string | null = 'application/json',
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    const headers: Record<string, string> = { 'X-RONOR-Token': this.token };
    if (contentType && body !== null) headers['Content-Type'] = contentType;

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: body ?? undefined,
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // The arm returns clean JSON errors most of the time — pass the body
        // through unchanged so the bot can render whatever the arm intended.
        throw new TradingApiError(
          `Trading arm returned HTTP ${res.status} on ${method} ${path}`,
          res.status,
          text,
        );
      }
      if (text.length === 0) return {} as T;
      try {
        return JSON.parse(text) as T;
      } catch (err) {
        logger.warn(`non-JSON response from ${path}: ${text.slice(0, 200)}`);
        throw new TradingApiError(
          `Trading arm returned non-JSON body on ${method} ${path}`,
          res.status,
          text,
        );
      }
    } catch (err) {
      if (err instanceof TradingApiError) throw err;
      if ((err as Error).name === 'AbortError') {
        throw new TradingApiError(
          `Trading arm request timed out after ${this.timeoutMs} ms on ${method} ${path}`,
          null,
          null,
        );
      }
      throw new TradingApiError(
        `Trading arm request failed on ${method} ${path}: ${(err as Error).message}`,
        null,
        null,
      );
    } finally {
      clearTimeout(timeout);
    }
  }
}
