/**
 * RONOR — L0 · Telegram Interface · Runtime Client
 * ─────────────────────────────────────────────────
 * HTTP client the Telegram bridge uses to talk to the RONOR runtime. It is an
 * ordinary API client, not an in-process call: in the production composition the
 * bridge runs in a separate container and communicates over the compose network.
 *
 * Three design decisions worth naming:
 *
 *   · EVERY RESPONSE IS TYPED. The bridge reads specific fields; an unexpected
 *     shape is caught at the boundary rather than propagated as `undefined` into
 *     a message the operator reads.
 *
 *   · THE CREDENTIAL IS NEVER LOGGED. The key is present/absent in the log,
 *     never its value.
 *
 *   · TIMEOUT IS GENEROUS. A governed query with retrieval and a fallback chain
 *     can legitimately take 3–4 minutes. A client that times out at 30s would
 *     cancel work the runtime has already paid for.
 *
 * Prepared by AMB · Mayleven Ecosystem
 */

import https from 'https';
import http from 'http';
import { createLogger } from '../../utils/logger';
import type {
  RuntimeQueryResponse,
  RuntimeMissionResponse,
  RuntimeStatusResponse,
  RuntimeHealthResponse,
} from './types';

const logger = createLogger('RONOR:Telegram:RuntimeClient');

export class RonorClientError extends Error {
  constructor(
    public readonly endpoint: string,
    public readonly httpStatus: number | null,
    message: string,
  ) {
    super(`RONOR client error on ${endpoint}: [${httpStatus ?? 'network'}] ${message}`);
    this.name = 'RonorClientError';
  }
}

function request<T>(
  baseUrl: string,
  path: string,
  method: 'GET' | 'POST',
  apiKey: string,
  body?: unknown,
  timeoutMs = 360_000,
): Promise<{ status: number; data: T }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const payload = body !== undefined ? JSON.stringify(body) : undefined;
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const options: http.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname + url.search,
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'User-Agent': 'RONOR-Telegram-Bridge/0.5.0',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: timeoutMs,
    };

    const req = lib.request(options, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data: T;
        try {
          data = JSON.parse(raw) as T;
        } catch {
          reject(new RonorClientError(path, res.statusCode ?? null, `non-JSON body: ${raw.slice(0, 200)}`));
          return;
        }
        resolve({ status: res.statusCode ?? 0, data });
      });
    });

    req.on('timeout', () => {
      req.destroy();
      reject(new RonorClientError(path, null, `timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err: Error) => reject(new RonorClientError(path, null, err.message)));
    if (payload) req.write(payload);
    req.end();
  });
}

export class RonorRuntimeClient {
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
  ) {
    logger.info(`runtime client → ${baseUrl} (key present: ${apiKey.length > 0})`);
  }

  async health(): Promise<RuntimeHealthResponse> {
    // Health is unauthenticated by design; we still pass the key so the client
    // code is uniform, but the runtime ignores it on this route.
    const { data } = await request<RuntimeHealthResponse>(
      this.baseUrl,
      '/api/runtime/health',
      'GET',
      this.apiKey,
      undefined,
      10_000,
    );
    return data;
  }

  async status(): Promise<RuntimeStatusResponse> {
    const { data } = await request<RuntimeStatusResponse>(
      this.baseUrl,
      '/api/runtime/status',
      'GET',
      this.apiKey,
      undefined,
      15_000,
    );
    return data;
  }

  async query(params: {
    query: string;
    task_type?: string;
    confidentiality_level?: string;
    jurisdiction_pin?: string;
    mission_id?: string | null;
    operator_id?: string | null;
    use_knowledge?: boolean;
    max_cost_usd?: number;
    dry_run?: boolean;
  }): Promise<{ httpStatus: number; response: RuntimeQueryResponse }> {
    const { status, data } = await request<RuntimeQueryResponse>(
      this.baseUrl,
      '/api/runtime/query',
      'POST',
      this.apiKey,
      params,
      360_000,
    );
    return { httpStatus: status, response: data };
  }

  async settleApproval(
    approvalId: string,
    decision: 'approved' | 'rejected',
  ): Promise<RuntimeQueryResponse | RuntimeMissionResponse | { ok: true; settlement: 'rejected'; request_id: string }> {
    const { data } = await request<
      RuntimeQueryResponse | RuntimeMissionResponse | { ok: true; settlement: 'rejected'; request_id: string }
    >(
      this.baseUrl,
      '/api/runtime/approvals/' + encodeURIComponent(approvalId) + '/settle',
      'POST',
      this.apiKey,
      { decision },
      600_000,
    );
    return data;
  }

  async dispatchMission(params: {
    objective: string;
    title?: string;
    confidentiality_level?: string;
    jurisdiction_pin?: string;
    operator_id?: string | null;
    max_cost_usd?: number;
    use_knowledge?: boolean;
    require_evidence?: boolean;
  }): Promise<{ httpStatus: number; response: RuntimeMissionResponse }> {
    const { status, data } = await request<RuntimeMissionResponse>(
      this.baseUrl,
      '/api/runtime/agents/dispatch',
      'POST',
      this.apiKey,
      params,
      600_000,
    );
    return { httpStatus: status, response: data };
  }
}
