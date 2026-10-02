import request from 'supertest';
import { createModelEgressProxy, modelGatewayBaseUrl } from '../../src/runtime/automation/services/model-egress-proxy';
import { ModelBudgetLedger, signBudgetQuery, signModelBudget } from '../../src/runtime/automation/model-budget';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';

const token = 'gateway-token-for-tests-0123456789';
const codexToken = 'codex-client-token-tests-0123456789';
const upstreamToken = 'upstream-provider-token-0123456789';
const verifierUpstreamToken = 'verifier-provider-token-0123456789';
const upstreams = (author = 'https://models.example/api/v1', verifier = 'https://verifier.example/v1') =>
  ({ author: { baseUrl: author, token: upstreamToken }, verifier: { baseUrl: verifier, token: verifierUpstreamToken } });
const config = { upstreams: upstreams(), clientTokens: [token, codexToken] as [string, string], enforceProviderHosts: false };

describe('automation model egress proxy', () => {
  it('forwards only the three model API routes to the configured HTTPS gateway', async () => {
    const fetcher = jest.fn(async () => new Response(JSON.stringify({ id: 'safe-response' }), { status: 200 }));
    const app = createModelEgressProxy({ ...config, fetcher });
    const result = await request(app).post('/v1/responses').set('Authorization', `Bearer ${token}`).send({ model: 'approved' });
    expect(result.status).toBe(200); expect(result.body.id).toBe('safe-response');
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('https://models.example/api/v1/responses');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${upstreamToken}`);
    expect(JSON.stringify(init)).not.toContain(token);
    expect(JSON.stringify(init)).not.toContain('models.example/api/v1/responses?');
  });

  it('refuses missing authentication and arbitrary network paths before fetch', async () => {
    const fetcher = jest.fn(); const app = createModelEgressProxy({ ...config, upstreams: upstreams('https://models.example/v1'), fetcher });
    expect((await request(app).post('/v1/responses').send({})).status).toBe(401);
    expect((await request(app).post('/v1/files').set('Authorization', `Bearer ${token}`).send({})).status).toBe(403);
    expect((await request(app).get('/v1/responses').set('Authorization', `Bearer ${token}`)).status).toBe(403);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('accepts distinct OpenHands and Codex identities but never an upstream credential as a client', async () => {
    const fetcher = jest.fn(async () => new Response('{}'));
    const app = createModelEgressProxy({ ...config, fetcher });
    expect((await request(app).post('/v1/responses').set('Authorization', `Bearer ${token}`).send({})).status).toBe(200);
    expect((await request(app).post('/v1/responses').set('Authorization', `Bearer ${codexToken}`).send({})).status).toBe(200);
    expect((await request(app).post('/v1/responses').set('Authorization', `Bearer ${upstreamToken}`).send({})).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(2);
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
    const app = createModelEgressProxy({ ...config, upstreams: upstreams('https://models.example/v1'), fetcher: jest.fn(async () => { throw new Error('secret upstream detail'); }) });
    const result = await request(app).post('/v1/chat/completions').set('Authorization', `Bearer ${token}`).send({});
    expect(result.status).toBe(502); expect(JSON.stringify(result.body)).not.toContain('secret upstream detail');
  });
});

describe('production model budget enforcement', () => {
  const key = 'budget-key-for-proxy-tests-32-bytes';
  const mandate = {mission_id:'m-proxy',max_cost_usd:1,expires_at:new Date(Date.now()+600000).toISOString()} as ExecutionMandate;
  const payload = {model:'claude-opus-5-5',messages:[{role:'user',content:'test'}]};
  const signed = (spent = 0, role: 'author'|'verifier' = 'author') => signModelBudget(mandate,{run_id:'r-proxy',accounted_cost_usd:spent},role,key);
  it('refuses missing, mismatched-role and exhausted budget authorizations before upstream access', async () => {
    const ledger = new ModelBudgetLedger(':memory:'); const fetcher = jest.fn();
    const app = createModelEgressProxy({...config,fetcher,budget:{key,ledger}});
    expect((await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).send(payload)).status).toBe(403);
    expect((await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${codexToken}`).set('x-ronor-budget',signed()).send(payload)).status).toBe(403);
    expect((await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed(0.999)).send(payload)).status).toBe(409);
    expect(fetcher).not.toHaveBeenCalled(); ledger.close();
  });
  it('exposes the settled ledger read-only, to a signed query alone', async () => {
    const ledger = new ModelBudgetLedger(':memory:');
    const fetcher = jest.fn(async()=>new Response('{"usage":{"input_tokens":100,"output_tokens":10}}'));
    const app = createModelEgressProxy({...config,fetcher,budget:{key,ledger}});
    await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed()).send(payload);
    const proof = signBudgetQuery('r-proxy',key);
    const ok = await request(app).get('/budget/r-proxy').set('x-ronor-budget-query',proof);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ok:true,budget_id:'r-proxy',settled_micro_usd:600,settled_reservations:1,pending_reservations:0,frozen:false});
    // A client credential is not a settlement authority, and a settlement proof
    // is not a client credential.
    expect((await request(app).get('/budget/r-proxy')).status).toBe(401);
    expect((await request(app).get('/budget/r-proxy').set('Authorization',`Bearer ${token}`)).status).toBe(401);
    expect((await request(app).get('/budget/r-proxy').set('x-ronor-budget-query',signBudgetQuery('r-other',key))).status).toBe(401);
    expect((await request(app).get('/budget/r-other').set('x-ronor-budget-query',signBudgetQuery('r-other',key))).status).toBe(404);
    expect((await request(app).post('/v1/chat/completions').set('x-ronor-budget-query',proof).send(payload)).status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(ok.body)).not.toContain(upstreamToken);
    ledger.close();
  });
  it('shares cumulative accounting between author and verifier and strips the signed authorization upstream', async () => {
    const ledger = new ModelBudgetLedger(':memory:');
    const fetcher = jest.fn(async()=>new Response('{"usage":{"input_tokens":100,"output_tokens":10}}'));
    const app = createModelEgressProxy({...config,fetcher,budget:{key,ledger}});
    const r = await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed(0.2)).send(payload);
    expect(r.status).toBe(200); expect(r.headers['x-ronor-accounted-micro-usd']).toBe('600');
    const second = await request(app).post('/v1/responses').set('Authorization',`Bearer ${codexToken}`).set('x-ronor-budget',signed(0,'verifier')).send({model:'gpt-6-astra',input:'verify'});
    expect(second.status).toBe(200);
    expect(ledger.snapshot('r-proxy')?.spent).toBe(202100);
    expect(JSON.stringify(fetcher.mock.calls)).not.toContain('x-ronor-budget');
    ledger.close();
  });
  it('charges the reserved worst case after a transport failure and lets the authorised run continue', async () => {
    const ledger = new ModelBudgetLedger(':memory:');
    const fetcher = jest.fn(async()=>{throw new Error('private detail');});
    const app = createModelEgressProxy({...config,fetcher,budget:{key,ledger}});
    const call = ()=>request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed()).send(payload);
    const first = await call();
    expect(first.status).toBe(502); expect(JSON.stringify(first.body)).not.toContain('private detail');
    const after = ledger.snapshot('r-proxy')!;
    expect(after).toMatchObject({frozen:0,pending:0,outstanding:0});
    expect(after.spent).toBeGreaterThan(0);
    expect((await call()).status).toBe(502);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(ledger.snapshot('r-proxy')).toMatchObject({frozen:0,pending:0});
    ledger.close();
  });

  it('treats a provider refusal as resolved, charging the worst case without freezing the budget', async () => {
    const ledger = new ModelBudgetLedger(':memory:');
    const fetcher = jest.fn(async()=>new Response(JSON.stringify({error:{code:'Throttling'}}),{status:429}));
    const app = createModelEgressProxy({...config,fetcher,budget:{key,ledger}});
    const refused = await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed()).send(payload);
    expect(refused.status).toBe(429);
    expect(refused.headers['x-ronor-accounted-micro-usd']).toBeUndefined();
    const afterRefusal = ledger.snapshot('r-proxy')!;
    expect(afterRefusal).toMatchObject({frozen:0,pending:0,outstanding:0});
    expect(afterRefusal.spent).toBeGreaterThan(0);
    fetcher.mockImplementation(async()=>new Response('{"usage":{"input_tokens":100,"output_tokens":10}}'));
    const recovered = await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed()).send(payload);
    expect(recovered.status).toBe(200);
    expect(recovered.headers['x-ronor-accounted-micro-usd']).toBe('600');
    ledger.close();
  });

  it('still freezes when a successful completion cannot be accounted for', async () => {
    const ledger = new ModelBudgetLedger(':memory:');
    const fetcher = jest.fn(async()=>new Response(JSON.stringify({id:'no-usage-block'}),{status:200}));
    const app = createModelEgressProxy({...config,fetcher,budget:{key,ledger}});
    const call = ()=>request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed()).send(payload);
    expect((await call()).status).toBe(502);
    expect((await call()).status).toBe(409);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(ledger.snapshot('r-proxy')).toMatchObject({frozen:1,pending:1});
    ledger.close();
  });
});

describe('one provider per role', () => {
  const key = 'budget-key-for-proxy-tests-32-bytes';
  const mandate = {mission_id:'m-route',max_cost_usd:5,expires_at:new Date(Date.now()+600000).toISOString()} as ExecutionMandate;
  const signed = (role: 'author'|'verifier') => signModelBudget(mandate,{run_id:'r-route',accounted_cost_usd:0},role,key);
  const usage = () => new Response('{"usage":{"input_tokens":100,"output_tokens":10}}');
  it('sends the author to the author provider and the verifier to the verifier provider, each with its own credential', async () => {
    const ledger = new ModelBudgetLedger(':memory:'); const fetcher = jest.fn(async () => usage());
    const app = createModelEgressProxy({...config,fetcher,budget:{key,ledger}});
    expect((await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed('author'))
      .send({model:'claude-opus-5-5',messages:[{role:'user',content:'a'}]})).status).toBe(200);
    expect((await request(app).post('/v1/responses').set('Authorization',`Bearer ${codexToken}`).set('x-ronor-budget',signed('verifier'))
      .send({model:'gpt-6-astra',input:'v'})).status).toBe(200);
    const calls = fetcher.mock.calls as unknown as [URL, RequestInit][];
    expect(String(calls[0][0])).toBe('https://models.example/api/v1/chat/completions');
    expect((calls[0][1].headers as Record<string,string>).authorization).toBe(`Bearer ${upstreamToken}`);
    expect(String(calls[1][0])).toBe('https://verifier.example/v1/responses');
    expect((calls[1][1].headers as Record<string,string>).authorization).toBe(`Bearer ${verifierUpstreamToken}`);
    ledger.close();
  });
  it('refuses the other role\'s model before any provider is contacted', async () => {
    const ledger = new ModelBudgetLedger(':memory:'); const fetcher = jest.fn(async () => usage());
    const app = createModelEgressProxy({...config,fetcher,budget:{key,ledger}});
    expect((await request(app).post('/v1/chat/completions').set('Authorization',`Bearer ${token}`).set('x-ronor-budget',signed('author'))
      .send({model:'gpt-6-astra',messages:[{role:'user',content:'a'}]})).body.error).toBe('budget_payload_unsupported');
    expect((await request(app).post('/v1/responses').set('Authorization',`Bearer ${codexToken}`).set('x-ronor-budget',signed('verifier'))
      .send({model:'claude-opus-5-5',input:'v'})).body.error).toBe('budget_payload_unsupported');
    expect(fetcher).not.toHaveBeenCalled(); ledger.close();
  });
  it('admits only the provider host named by each rate card in production', () => {
    expect(() => createModelEgressProxy({ upstreams: upstreams(), clientTokens: [token, codexToken] })).toThrow('model_budget_provider_mismatch');
    expect(() => createModelEgressProxy({ upstreams: upstreams('https://api.anthropic.com/v1', 'https://api.anthropic.com/v1'), clientTokens: [token, codexToken] })).toThrow('model_budget_provider_mismatch');
    expect(() => createModelEgressProxy({ upstreams: upstreams('https://api.anthropic.com/v1', 'https://api.openai.com/v1'), clientTokens: [token, codexToken] })).not.toThrow();
  });
  it('refuses one credential shared by both providers', () => {
    const shared = { author: { baseUrl: 'https://a.example/v1', token: upstreamToken }, verifier: { baseUrl: 'https://b.example/v1', token: upstreamToken } };
    expect(() => createModelEgressProxy({ upstreams: shared, clientTokens: [token, codexToken], enforceProviderHosts: false })).toThrow('model_gateway_upstream_token_invalid');
  });
});
