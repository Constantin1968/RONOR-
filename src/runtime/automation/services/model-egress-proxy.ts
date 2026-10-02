import crypto from 'node:crypto';
import { createServiceRateLimit } from './rate-limit';
import net from 'node:net';
import express, { type Request } from 'express';
import { MODEL_RATE_CARD_SET, type ModelRateCard, rateCardFor, ModelBudgetError, ModelBudgetLedger, modelResponseCharge, reserveModelRequest, verifyBudgetQuery, verifyModelBudget } from '../model-budget';

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

/** One provider per role. The author and the verifier never share a provider,
 * a credential or a rate card, so the verifier stays independent of the author. */
export interface ModelUpstream { baseUrl: string; token: string; }
export function createModelEgressProxy(config: { upstreams: { author: ModelUpstream; verifier: ModelUpstream };
  /** Index 0 authenticates the author, index 1 the verifier. */
  clientTokens: [string, string]; allowTailscale?: boolean; fetcher?: Fetcher;
  /** Test seam only: production always enforces the provider host of each card. */
  enforceProviderHosts?: boolean;
  budget?: { key: string; ledger: ModelBudgetLedger } }) {
  if (!Array.isArray(config.clientTokens) || config.clientTokens.length !== 2 || config.clientTokens.some((token) => typeof token !== 'string' || token.length < 16) ||
      new Set(config.clientTokens).size !== config.clientTokens.length) throw new Error('model_gateway_client_tokens_invalid');
  const roles = ['author', 'verifier'] as const;
  const upstreamTokens = roles.map(r => config.upstreams?.[r]?.token);
  if (upstreamTokens.some(t => !t || t.length < 16 || config.clientTokens.includes(t)) || upstreamTokens[0] === upstreamTokens[1]) {
    throw new Error('model_gateway_upstream_token_invalid');
  }
  const routes = Object.fromEntries(roles.map(r => {
    const card: ModelRateCard = rateCardFor(r);
    const url = modelGatewayBaseUrl(config.upstreams[r].baseUrl, config.allowTailscale);
    if (config.enforceProviderHosts !== false && url.hostname !== card.host) throw new Error('model_budget_provider_mismatch');
    return [r, { card, url, token: config.upstreams[r].token }];
  })) as Record<'author' | 'verifier', { card: ModelRateCard; url: URL; token: string }>;
  const fetcher = config.fetcher ?? fetch;
  const app = express(); app.disable('x-powered-by'); app.use(express.raw({ type: 'application/json', limit: '1mb' })); app.use(createServiceRateLimit());
  app.get('/health', (req, res) => authorised(req, config.clientTokens)
    ? res.json({ ok: true, protocol: 'ronor-model-egress/v1', service_id: 'model-egress-proxy', capabilities: ['responses', 'chat-completions', 'models'] })
    : res.status(401).json({ ok: false, error: 'unauthorized' }));
  // Read-only settlement report. The controller cannot see the ledger file, so
  // without this route an interrupted run's real cost stays unknown to it even
  // though the proxy settled it. Authorised by a signed query over the budget
  // identifier alone: it returns integers, never a body, a token or an objective,
  // and it can neither reserve, settle nor unfreeze anything.
  app.get('/budget/:id', (req, res) => {
    if (!config.budget) { res.status(404).json({ ok: false, error: 'budget_accounting_disabled' }); return; }
    const id = req.params.id;
    if (!verifyBudgetQuery(req.header('x-ronor-budget-query') ?? '', id, config.budget.key)) {
      res.status(401).json({ ok: false, error: 'unauthorized' }); return;
    }
    const settlement = config.budget.ledger.settlement(id);
    if (!settlement) { res.status(404).json({ ok: false, error: 'budget_unknown' }); return; }
    res.json({ ok: true, protocol: 'ronor-model-egress/v1', rate_card: MODEL_RATE_CARD_SET, ...settlement });
  });
  app.use('/v1', async (req, res) => {
    const path = `/v1${req.path === '/' ? '' : req.path}`;
    if (!authorised(req, config.clientTokens)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    if (req.url.includes('?') || !ALLOWED_PATHS.has(path) || (path === '/v1/models' ? req.method !== 'GET' : req.method !== 'POST')) {
      res.status(403).json({ ok: false, error: 'model_egress_path_refused' }); return;
    }
    const clientIndex = config.clientTokens.findIndex(t => req.header('authorization') === `Bearer ${t}`);
    const route = routes[clientIndex === 0 ? 'author' : 'verifier'];
    const target = new URL(`${route.url.pathname}${path.slice(3)}`, route.url.origin);
    let reservation: string | undefined;
    let reservedAmount = 0;
    let deadline = Date.now() + 120_000;
    let requestBody = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (req.method === 'POST' && config.budget) {
      const claims = verifyModelBudget(req.header('x-ronor-budget') ?? '', config.budget.key);
      if (!claims || claims.role !== route.card.role) {
        res.status(403).json({ ok: false, error: 'budget_authorization_required' }); return;
      }
      try {
        deadline = Math.min(deadline, Date.parse(claims.expires_at));
        const bounded = reserveModelRequest(path, requestBody, route.card);
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
        headers: { authorization: `Bearer ${route.token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: req.method === 'POST' ? new Uint8Array(requestBody) : undefined,
        signal: AbortSignal.any([disconnected.signal, AbortSignal.timeout(Math.max(1, deadline - Date.now()))]),
      });
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > 2 * 1024 * 1024) throw new Error('upstream_response_too_large');
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > 2 * 1024 * 1024) throw new Error('upstream_response_too_large');
      if (reservation && config.budget) {
        const cost = modelResponseCharge(Buffer.from(body), route.card);
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
