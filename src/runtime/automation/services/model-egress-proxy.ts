import crypto from 'node:crypto';
import { createServiceRateLimit } from './rate-limit';
import net from 'node:net';
import express, { type Request } from 'express';
import { ModelBudgetError, ModelBudgetLedger, modelResponseCharge, reserveModelRequest, verifyModelBudget } from '../model-budget';

type Fetcher = typeof fetch;
const ALLOWED_PATHS = new Set(['/v1/responses', '/v1/chat/completions', '/v1/models']);

function authorised(req: Request, tokens: readonly string[]): boolean {
  const candidate = req.header('authorization');
  if (!candidate?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(candidate.slice(7));
  return tokens.some((token) => {
    const expected = Buffer.from(token);
    return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
  });
}

/** Structured, secret-free record of every settlement that is not an ordinary
 * accounted completion. Carries no bodies, no credentials and no objectives. */
function reportSettlement(entry: { path: string; status: number | null; resolution: string; reserved_micro_usd: number }): void {
  try { console.warn(JSON.stringify({ event: 'model_egress_settlement', at: new Date().toISOString(), ...entry })); } catch { /* logging must never affect accounting */ }
}

function isTailscaleIpv4(host: string): boolean {
  const parts = host.split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255) && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

export function modelGatewayBaseUrl(value: string, allowTailscale = false): URL {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, '');
  const tlsHostname = url.protocol === 'https:' && net.isIP(url.hostname) === 0 && /^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(url.hostname);
  const tailscalePeer = allowTailscale && url.protocol === 'http:' && isTailscaleIpv4(url.hostname);
  if ((!tlsHostname && !tailscalePeer) || url.username || url.password || url.search || url.hash || !path.endsWith('/v1')) {
    throw new Error('model_gateway_url_invalid');
  }
  url.pathname = path;
  return url;
}

export function createModelEgressProxy(config: { gatewayBaseUrl: string; clientTokens: string[]; upstreamToken: string; allowTailscale?: boolean; fetcher?: Fetcher;
  budget?: { key: string; ledger: ModelBudgetLedger } }) {
  if (config.clientTokens.length < 1 || config.clientTokens.some((token) => token.length < 16) ||
      new Set(config.clientTokens).size !== config.clientTokens.length) throw new Error('model_gateway_client_tokens_invalid');
  if (!config.upstreamToken || config.upstreamToken.length < 16 || config.clientTokens.includes(config.upstreamToken)) {
    throw new Error('model_gateway_upstream_token_invalid');
  }
  const upstream = modelGatewayBaseUrl(config.gatewayBaseUrl, config.allowTailscale);
  const fetcher = config.fetcher ?? fetch;
  const app = express(); app.disable('x-powered-by'); app.use(express.raw({ type: 'application/json', limit: '1mb' })); app.use(createServiceRateLimit());
  app.get('/health', (req, res) => authorised(req, config.clientTokens)
    ? res.json({ ok: true, protocol: 'ronor-model-egress/v1', service_id: 'model-egress-proxy', capabilities: ['responses', 'chat-completions', 'models'] })
    : res.status(401).json({ ok: false, error: 'unauthorized' }));
  app.use('/v1', async (req, res) => {
    const path = `/v1${req.path === '/' ? '' : req.path}`;
    if (!authorised(req, config.clientTokens)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    if (req.url.includes('?') || !ALLOWED_PATHS.has(path) || (path === '/v1/models' ? req.method !== 'GET' : req.method !== 'POST')) {
      res.status(403).json({ ok: false, error: 'model_egress_path_refused' }); return;
    }
    const target = new URL(`${upstream.pathname}${path.slice(3)}`, upstream.origin);
    let reservation: string | undefined;
    let reservedAmount = 0;
    let deadline = Date.now() + 120_000;
    let requestBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (req.method === 'POST' && config.budget) {
      const claims = verifyModelBudget(req.header('x-ronor-budget') ?? '', config.budget.key);
      const clientIndex = config.clientTokens.findIndex(t => req.header('authorization') === `Bearer ${t}`);
      if (!claims || claims.role !== (clientIndex === 0 ? 'author' : 'verifier')) {
        res.status(403).json({ ok: false, error: 'budget_authorization_required' }); return;
      }
      try {
        deadline = Math.min(deadline, Date.parse(claims.expires_at));
        const bounded = reserveModelRequest(path, requestBody);
        reservedAmount = bounded.reserveMicroUsd;
        reservation = config.budget.ledger.reserve(claims, reservedAmount);
        requestBody = Buffer.from(JSON.stringify(bounded.payload));
      } catch (error) {
        const code = error instanceof ModelBudgetError ? error.message : 'budget_store_unavailable';
        res.status(409).json({ ok: false, error: code }); return;
      }
    }
    const disconnected = new AbortController();
    res.once('close', () => { if (!res.writableEnded) disconnected.abort(); });
    try {
      const response = await fetcher(target, {
        method: req.method, redirect: 'error',
        headers: { authorization: `Bearer ${config.upstreamToken}`, accept: 'application/json', 'content-type': 'application/json' },
        body: req.method === 'POST' ? new Uint8Array(requestBody) : undefined,
        signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      });
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > 2 * 1024 * 1024) throw new Error('upstream_response_too_large');
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > 2 * 1024 * 1024) throw new Error('upstream_response_too_large');
      if (reservation && config.budget) {
        const cost = modelResponseCharge(Buffer.from(body));
        // A provider refusal is a *resolved* outcome, not an unknown one: no
        // completion was produced, so the dispatch is settled at its own
        // worst-case reservation rather than freezing the budget. The ceiling
        // stays inviolable because that amount was already held against it.
        if (!response.ok) {
          config.budget.ledger.settle(reservation, reservedAmount);
          reservation = undefined;
          reportSettlement({ path, status: response.status, resolution: 'charged_worst_case', reserved_micro_usd: reservedAmount });
          res.status(response.status).type('application/json').send(Buffer.from(body)); return;
        }
        config.budget.ledger.settle(reservation, cost);
        reservation = undefined;
        if (cost === null || cost > reservedAmount) {
          reportSettlement({ path, status: response.status, resolution: cost === null ? 'frozen_usage_unknown' : 'frozen_provider_overrun', reserved_micro_usd: reservedAmount });
          res.status(502).json({ok:false,error:cost === null ? 'budget_usage_unknown' : 'budget_provider_overrun'}); return;
        }
        res.setHeader('x-ronor-accounted-micro-usd', String(cost));
        res.setHeader('x-ronor-accounting-basis', 'catalog-no-cache-discount');
      }
      res.status(response.status).type('application/json').send(Buffer.from(body));
    } catch {
      if (reservation && config.budget) {
        // Transport failure or client disconnect: charge the worst case that was
        // already held against the ceiling instead of freezing the budget, so a
        // single unfavourable hop cannot end an authorised run irrecoverably.
        try { config.budget.ledger.settle(reservation, reservedAmount); } catch { /* pending liability remains durable */ }
        reportSettlement({ path, status: null, resolution: 'charged_worst_case', reserved_micro_usd: reservedAmount });
      }
      res.status(502).json({ ok: false, error: 'model_gateway_unavailable' });
    }
  });
  return app;
}
