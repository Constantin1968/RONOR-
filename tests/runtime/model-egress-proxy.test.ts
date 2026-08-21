import request from 'supertest';
import { createModelEgressProxy, modelGatewayBaseUrl } from '../../src/runtime/automation/services/model-egress-proxy';

const token = 'gateway-token-for-tests-0123456789';

describe('automation model egress proxy', () => {
  it('forwards only the three model API routes to the configured HTTPS gateway', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify({ id: 'safe-response' }), { status: 200 }));
    const app = createModelEgressProxy({ gatewayBaseUrl: 'https://models.example/api/v1', gatewayToken: token, fetcher });
    const result = await request(app).post('/v1/responses').set('Authorization', `Bearer ${token}`).send({ model: 'approved' });
    expect(result.status).toBe(200); expect(result.body.id).toBe('safe-response');
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://models.example/api/v1/responses');
    expect(init.redirect).toBe('error');
    expect(JSON.stringify(init)).not.toContain('models.example/api/v1/responses?');
  });

  it('refuses missing authentication and arbitrary network paths before fetch', async () => {
    const fetcher = jest.fn(); const app = createModelEgressProxy({ gatewayBaseUrl: 'https://models.example/v1', gatewayToken: token, fetcher });
    expect((await request(app).post('/v1/responses').send({})).status).toBe(401);
    expect((await request(app).post('/v1/files').set('Authorization', `Bearer ${token}`).send({})).status).toBe(403);
    expect((await request(app).get('/v1/responses').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects plaintext, credentials, IP literals and non-v1 upstreams', () => {
    for (const url of ['http://models.example/v1', 'https://u:p@models.example/v1', 'https://127.0.0.1/v1', 'https://models.example/proxy']) {
      expect(() => modelGatewayBaseUrl(url)).toThrow('model_gateway_url_invalid');
    }
  });

  it('admits plaintext only for an explicitly enabled Tailscale CGNAT peer', () => {
    expect(modelGatewayBaseUrl('http://100.83.241.57/gw/v1', true).href).toBe('http://100.83.241.57/gw/v1');
    for (const url of ['http://100.83.241.57/gw/v1', 'http://10.0.0.1/v1', 'http://100.128.0.1/v1', 'http://169.254.169.254/v1']) {
      expect(() => modelGatewayBaseUrl(url, url.includes('100.83') ? false : true)).toThrow('model_gateway_url_invalid');
    }
  });

  it('fails closed without relaying upstream error bodies', async () => {
    const app = createModelEgressProxy({ gatewayBaseUrl: 'https://models.example/v1', gatewayToken: token, fetcher: jest.fn(async () => { throw new Error('secret upstream detail'); }) });
    const result = await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${token}`).send({});
    expect(result.status).toBe(502); expect(JSON.stringify(result.body)).not.toContain('secret upstream detail');
  });
});
