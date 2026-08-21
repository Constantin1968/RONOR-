import crypto from 'node:crypto';
import net from 'node:net';
import express, { type Request } from 'express';

type Fetcher = typeof fetch;
const ALLOWED_PATHS = new Set(['/v1/responses', '/v1/chat/completions', '/v1/models']);

function authorised(req: Request, token: string): boolean {
  const candidate = req.header('authorization');
  if (!candidate?.startsWith('Bearer ')) return false;
  const supplied = Buffer.from(candidate.slice(7)); const expected = Buffer.from(token);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

export function modelGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !path.endsWith('/v1') ||
      net.isIP(url.hostname) !== 0 || !/^[A-Za-z0-9](?:[A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(url.hostname)) {
    throw new Error('model_gateway_url_invalid');
  }
  url.pathname = path;
  return url;
}

export function createModelEgressProxy(config: { gatewayBaseUrl: string; gatewayToken: string; fetcher?: Fetcher }) {
  if (!config.gatewayToken || config.gatewayToken.length < 16) throw new Error('model_gateway_token_invalid');
  const upstream = modelGatewayBaseUrl(config.gatewayBaseUrl);
  const fetcher = config.fetcher ?? fetch;
  const app = express(); app.disable('x-powered-by'); app.use(express.raw({ type: 'application/json', limit: '1mb' }));
  app.get('/health', (req, res) => authorised(req, config.gatewayToken)
    ? res.json({ ok: true, protocol: 'ronor-model-egress/v1', service_id: 'model-egress-proxy', capabilities: ['responses', 'chat-completions', 'models'] })
    : res.status(401).json({ ok: false, error: 'unauthorized' }));
  app.use('/v1', async (req, res) => {
    const path = `/v1${req.path === '/' ? '' : req.path}`;
    if (!authorised(req, config.gatewayToken)) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
    if (req.url.includes('?') || !ALLOWED_PATHS.has(path) || (path === '/v1/models' ? req.method !== 'GET' : req.method !== 'POST')) {
      res.status(403).json({ ok: false, error: 'model_egress_path_refused' }); return;
    }
    const target = new URL(`${upstream.pathname}${path.slice(3)}`, upstream.origin);
    try {
      const response = await fetcher(target, {
        method: req.method, redirect: 'error',
        headers: { authorization: req.header('authorization')!, accept: 'application/json', 'content-type': 'application/json' },
        body: req.method === 'POST' ? new Uint8Array(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0)) : undefined,
      });
      const declared = Number(response.headers.get('content-length') ?? 0);
      if (declared > 2 * 1024 * 1024) throw new Error('upstream_response_too_large');
      const body = new Uint8Array(await response.arrayBuffer());
      if (body.byteLength > 2 * 1024 * 1024) throw new Error('upstream_response_too_large');
      res.status(response.status).type('application/json').send(Buffer.from(body));
    } catch {
      res.status(502).json({ ok: false, error: 'model_gateway_unavailable' });
    }
  });
  return app;
}
