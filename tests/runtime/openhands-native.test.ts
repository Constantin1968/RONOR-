import { createNativeOpenHandsClient, nativeOpenHandsCost, nativeOpenHandsCatalogCost, CONTEXT_BOUNDS } from '../../src/runtime/automation/adapters/openhands-native';

describe('native catalog accounting', () => {
  it('computes the conservative catalog subtotal from measured tokens without double-counting cache hits', () => {
    expect(nativeOpenHandsCatalogCost({stats:{usage_to_metrics:{agent:{
      model_name:'openai/qwen3.8-max',accumulated_cost:0,costs:[],
      accumulated_token_usage:{prompt_tokens:306258,completion_tokens:4135,cache_read_tokens:270336},
    }}}})).toBe(0.637326);
  });
  it('refuses missing usage or a different model even if it advertises a zero cost', () => {
    expect(nativeOpenHandsCatalogCost({})).toBeNull();
    expect(nativeOpenHandsCatalogCost({stats:{usage_to_metrics:{agent:{
      model_name:'different',accumulated_token_usage:{prompt_tokens:1,completion_tokens:1},
    }}}})).toBeNull();
  });
});
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const conversationId = '11111111-1111-4111-8111-111111111111';
const envelope: OpenHandsExecutionEnvelope = {
  assignment_id: 'a1', instruction: 'Run tests.', allowed_actions: ['read_repo', 'run_tests'], objective_hash: 'a'.repeat(64), deadline: new Date(Date.now() + 120_000).toISOString(),
};
const json = (value: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(value), { status }));
const boundedLlm = {model:'openai/qwen3.8-max',base_url:'http://model-egress-proxy:3004/v1',
  max_input_tokens:CONTEXT_BOUNDS.maxInputTokens,max_message_chars:CONTEXT_BOUNDS.maxMessageChars,max_output_tokens:4096,num_retries:0,
  extra_headers:{'x-ronor-budget':'test-budget'}};
const boundedAgent = {llm:boundedLlm,condenser:{kind:'LLMSummarizingCondenser',max_size:CONTEXT_BOUNDS.condenserMaxSize,max_tokens:CONTEXT_BOUNDS.condenserMaxTokens,keep_first:2,
  llm:{...boundedLlm,usage_id:'condenser'}}};

describe('native OpenHands Agent Server client', () => {
  it('resumes the same paused conversation with verified budget headers and reports only incremental usage',async()=>{
    const state=(tokens:number,configured=false)=>({execution_status:'paused',
      agent:configured?boundedAgent:{llm:{model:'openai/qwen3.8-max'}},
      workspace:{working_dir:'/workspace/project'},confirmation_policy:{kind:'AlwaysConfirm'},
      stats:{usage_to_metrics:{agent:{model_name:'openai/qwen3.8-max',accumulated_token_usage:{prompt_tokens:tokens,completion_tokens:0}}}}});
    const fetcher=jest.fn()
      .mockImplementationOnce(()=>json(state(100000)))
      .mockImplementationOnce(()=>json({success:true}))
      .mockImplementationOnce(()=>json(state(100000,true)))
      .mockImplementationOnce(()=>json({success:true}))
      .mockImplementationOnce(()=>json({...state(110000,true),execution_status:'finished'}))
      .mockImplementationOnce(()=>json({items:[]}));
    const client=createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test-session',fetcher,
      catalogAccounting:true,llm:{model:'openai/qwen3.8-max',apiKey:'test-key',baseUrl:'http://model-egress-proxy:3004/v1'}});
    expect(await client.execute({...envelope,budget_token:'test-budget',resume:{conversation_id:conversationId,accounted_cost_usd:0.2}}))
      .toMatchObject({ok:true,cost_usd:0.02,evidence:[`conversation:${conversationId}`]});
    expect(fetcher.mock.calls.map(c=>new URL(c[0]).pathname)).toEqual([
      `/api/conversations/${conversationId}`,`/api/conversations/${conversationId}/switch_llm`,
      `/api/conversations/${conversationId}`,`/api/conversations/${conversationId}/run`,
      `/api/conversations/${conversationId}`,`/api/conversations/${conversationId}/events/search`,
    ]);
  });
  it('tolerates the asynchronous start of a resumed conversation instead of reading it as termination',async()=>{
    const state=(status:string,tokens:number)=>({execution_status:status,
      agent:boundedAgent,
      workspace:{working_dir:'/workspace/project'},confirmation_policy:{kind:'AlwaysConfirm'},
      stats:{usage_to_metrics:{agent:{model_name:'openai/qwen3.8-max',accumulated_token_usage:{prompt_tokens:tokens,completion_tokens:0}}}}});
    const fetcher=jest.fn()
      .mockImplementationOnce(()=>json(state('paused',100000)))
      .mockImplementationOnce(()=>json({success:true}))
      .mockImplementationOnce(()=>json(state('paused',100000)))
      .mockImplementationOnce(()=>json({success:true}))
      .mockImplementationOnce(()=>json(state('paused',100000)))
      .mockImplementationOnce(()=>json(state('running',100000)))
      .mockImplementationOnce(()=>json({...state('finished',110000)}))
      .mockImplementationOnce(()=>json({items:[]}));
    const client=createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test-session',fetcher,
      pollIntervalMs:0,sleep:async()=>undefined,catalogAccounting:true,
      llm:{model:'openai/qwen3.8-max',apiKey:'test-key',baseUrl:'http://model-egress-proxy:3004/v1'}});
    expect(await client.execute({...envelope,budget_token:'test-budget',resume:{conversation_id:conversationId,accounted_cost_usd:0.2}}))
      .toMatchObject({ok:true,cost_usd:0.02});
  });
  it('reports the refusal code from the conversation error events when a run really stops',async()=>{
    const state=(status:string)=>({execution_status:status,
      agent:boundedAgent,
      workspace:{working_dir:'/workspace/project'},confirmation_policy:{kind:'AlwaysConfirm'},
      stats:{usage_to_metrics:{agent:{model_name:'openai/qwen3.8-max',accumulated_token_usage:{prompt_tokens:100000,completion_tokens:0}}}}});
    const fetcher=jest.fn()
      .mockImplementationOnce(()=>json(state('paused')))
      .mockImplementationOnce(()=>json({success:true}))
      .mockImplementationOnce(()=>json(state('paused')))
      .mockImplementationOnce(()=>json({success:true}))
      .mockImplementation((input:URL)=>json(new URL(input).pathname.endsWith('/events/search')
        ? {items:[{kind:'ConversationErrorEvent',error:'litellm.BadRequestError: budget_nontext_refused'}]}
        : state('paused')));
    const client=createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test-session',fetcher,
      pollIntervalMs:0,startupPolls:0,sleep:async()=>undefined,catalogAccounting:true,
      llm:{model:'openai/qwen3.8-max',apiKey:'test-key',baseUrl:'http://model-egress-proxy:3004/v1'}});
    const result=await client.execute({...envelope,budget_token:'test-budget',resume:{conversation_id:conversationId,accounted_cost_usd:0.2}});
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('openhands_terminated_paused_budget_nontext_refused');
  });
  it('reports the failure that stopped the run, not a configuration name mentioned earlier',async()=>{
    const state=(execution_status:string)=>({execution_status,
      agent:boundedAgent,
      workspace:{working_dir:'/workspace/project'},confirmation_policy:{kind:'AlwaysConfirm'},
      stats:{usage_to_metrics:{agent:{model_name:'openai/qwen3.8-max',accumulated_token_usage:{prompt_tokens:100000,completion_tokens:0}}}}});
    // A healthy earlier event names a secret; the LAST event carries the real cause.
    const events={items:[
      {kind:'ActionEvent',source:'agent',thought:'reading openhands_llm_api_key from the environment'},
      {kind:'ObservationEvent',source:'environment',observation:{content:'no error here'}},
      {kind:'ConversationErrorEvent',code:'APIError',
        detail:"litellm.APIError: OpenAIException - Error code: 409 - {'ok': False, 'error': 'budget_insufficient_before_dispatch'}"},
    ]};
    const fetcher=jest.fn()
      .mockImplementationOnce(()=>json(state('paused')))
      .mockImplementationOnce(()=>json({success:true}))
      .mockImplementationOnce(()=>json(state('paused')))
      .mockImplementationOnce(()=>json({success:true}))
      .mockImplementation((input:URL)=>json(new URL(input).pathname.endsWith('/events/search')?events:state('error')));
    const client=createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test-session',fetcher,
      pollIntervalMs:0,startupPolls:0,sleep:async()=>undefined,catalogAccounting:true,
      llm:{model:'openai/qwen3.8-max',apiKey:'test-key',baseUrl:'http://model-egress-proxy:3004/v1'}});
    const result=await client.execute({...envelope,budget_token:'test-budget',resume:{conversation_id:conversationId,accounted_cost_usd:0.2}});
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('openhands_terminated_error_budget_insufficient_before_dispatch');
  });
  it('does not start a preserved conversation when the budget header cannot be verified',async()=>{
    const state={execution_status:'paused',agent:{llm:{model:'openai/qwen3.8-max'}},
      workspace:{working_dir:'/workspace/project'},confirmation_policy:{kind:'AlwaysConfirm'},
      stats:{usage_to_metrics:{agent:{model_name:'openai/qwen3.8-max',accumulated_token_usage:{prompt_tokens:100000,completion_tokens:0}}}}};
    const fetcher=jest.fn().mockImplementationOnce(()=>json(state)).mockImplementationOnce(()=>json({success:true}))
      .mockImplementationOnce(()=>json(state));
    const client=createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test-session',fetcher,
      catalogAccounting:true,llm:{model:'openai/qwen3.8-max',apiKey:'test-key',baseUrl:'http://model-egress-proxy:3004/v1'}});
    expect(await client.execute({...envelope,budget_token:'test-budget',resume:{conversation_id:conversationId,accounted_cost_usd:0.2}}))
      .toMatchObject({ok:false,cost_usd:0,summary:'openhands_resume_configuration_unverified'});
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
  it('uses the official authenticated conversation lifecycle and emits hashed event evidence', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'running', cost_usd: 0 }))
      .mockImplementationOnce(() => json({ execution_status: 'finished', cost_usd: 0.02 }))
      .mockImplementationOnce(() => json({ items: [{ kind: 'MessageEvent', content: 'done' }] }));
    const client = createNativeOpenHandsClient({
      baseUrl: 'http://127.0.0.1:8000', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0, sleep: async () => undefined,
      llm: { model: 'openai/qwen3-coder:30b', apiKey: 'model-client-key', baseUrl: 'http://model-egress-proxy:3004/v1', apiMode: 'chat' },
    });
    const result = await client.execute(envelope);
    expect(result).toMatchObject({ ok: true, cost_usd: 0.02, artifacts: [{ kind: 'event_log', reference: `api/conversations/${conversationId}/events/search` }] });
    const reference = result.artifacts?.[0]?.reference ?? '';
    expect(reference).toMatch(/^[A-Za-z0-9][A-Za-z0-9._/-]{0,499}$/);
    expect(reference.includes('..')).toBe(false);
    expect(reference).not.toMatch(/[?&=]/);
    expect(String(fetcher.mock.calls[4][0])).toContain('limit=100&sort_order=TIMESTAMP_DESC');
    expect(fetcher).toHaveBeenCalledTimes(5);
    for (const call of fetcher.mock.calls) expect((call[1] as RequestInit).headers).toHaveProperty('X-Session-API-Key', 'session-key');
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:8000/api/conversations');
    const createdBody = JSON.parse(String((fetcher.mock.calls[0][1] as RequestInit).body));
    expect(createdBody).toMatchObject({
      workspace: { kind: 'LocalWorkspace', working_dir: '/workspace/project' },
      confirmation_policy: { kind: 'AlwaysConfirm' }, max_iterations: 100, autotitle:false,
      agent: { kind: 'Agent', llm: {
        model: 'openai/qwen3-coder:30b', api_key: 'model-client-key', base_url: 'http://model-egress-proxy:3004/v1', api_mode: 'chat',
        max_message_chars:CONTEXT_BOUNDS.maxMessageChars, max_input_tokens:CONTEXT_BOUNDS.maxInputTokens,num_retries:0,
      }, condenser:{kind:'LLMSummarizingCondenser',max_size:CONTEXT_BOUNDS.condenserMaxSize,max_tokens:CONTEXT_BOUNDS.condenserMaxTokens,keep_first:2},
      tools:[{name:'terminal'},{name:'file_editor'},{name:'task_tracker'}], tool_concurrency_limit:1 },
    });
    expect(createdBody.agent.condenser.llm).toEqual({...createdBody.agent.llm,usage_id:'condenser'});
    expect(JSON.parse(String((fetcher.mock.calls[1][1] as RequestInit).body))).toEqual({
      role: 'user', content: [{ type: 'text', text: 'Run tests.' }], run: true,
    });
    expect((fetcher.mock.calls[0][1] as RequestInit).redirect).toBe('error');
  });

  it('accepts a safe pending action through the bounded confirmation policy', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'waiting_for_confirmation',leaf_event_id:'pending-1', cost_usd: 0.01 }))
      .mockImplementationOnce(() => json({ items: [{ id:'pending-1',kind: 'ActionEvent', action: { command: 'git status --short' } }] }))
      .mockImplementationOnce(() => json({ execution_status: 'waiting_for_confirmation',leaf_event_id:'pending-1', cost_usd: 0.01 }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'finished', cost_usd: 0.01 }))
      .mockImplementationOnce(() => json({ items: [] }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0, sleep: async () => undefined });
    await expect(client.execute(envelope)).resolves.toMatchObject({ ok: true });
    expect(JSON.parse(String((fetcher.mock.calls[5][1] as RequestInit).body))).toMatchObject({ accept: true });
  });

  it('rejects and pauses a forbidden pending action before execution', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'waiting_for_confirmation',leaf_event_id:'pending-1', cost_usd: 0.01 }))
      .mockImplementationOnce(() => json({ items: [{ id:'pending-1',kind: 'ActionEvent', action: { command: 'git push origin HEAD' } }] }))
      .mockImplementationOnce(() => json({ accepted: false }))
      .mockImplementationOnce(() => json({ paused: true }))
      .mockImplementationOnce(() => json({ execution_status: 'paused', cost_usd: 0.015 }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0, sleep: async () => undefined });
    await expect(client.execute(envelope)).resolves.toMatchObject({ ok: false, summary: expect.stringContaining('git_push_forbidden') });
    expect(JSON.parse(String((fetcher.mock.calls[4][1] as RequestInit).body))).toMatchObject({ accept: false });
    expect(String(fetcher.mock.calls[5][0])).toBe(`https://hands.invalid/api/conversations/${conversationId}/pause`);
  });

  it('pauses on bounded timeout and never deletes the conversation', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce(() => json({ execution_status: 'running', cost_usd: 0.01 }))
      .mockImplementationOnce(() => json({ paused: true }))
      .mockImplementationOnce(() => json({ execution_status: 'paused', cost_usd: 0.015 }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, maxPolls: 1, pollIntervalMs: 0, sleep: async () => undefined });
    await expect(client.execute(envelope)).resolves.toMatchObject({ ok: false, summary: expect.stringContaining('paused') });
    const urls = fetcher.mock.calls.map((call) => String(call[0]));
    expect(urls).toContain(`https://hands.invalid/api/conversations/${conversationId}/pause`);
    expect(fetcher.mock.calls.some((call) => (call[1] as RequestInit).method === 'DELETE')).toBe(false);
  });

  it('propagates cancellation to Agent Server and pauses an active conversation', async () => {
    const controller = new AbortController();
    let pollingStarted!: () => void;
    const polling = new Promise<void>((resolve) => { pollingStarted = resolve; });
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        pollingStarted();
        init.signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
      }))
      .mockImplementationOnce(() => json({ paused: true }))
      .mockImplementationOnce(() => json({ execution_status: 'paused', cost_usd: 0.015 }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'session-key', fetcher, pollIntervalMs: 0 });
    const execution = client.execute(envelope, controller.signal);
    await polling;
    controller.abort();
    await expect(execution).resolves.toMatchObject({ ok: false, summary: 'openhands_cancelled', cost_usd: 0.015 });
    expect(String(fetcher.mock.calls[3][0])).toBe(`https://hands.invalid/api/conversations/${conversationId}/pause`);
    expect((fetcher.mock.calls[2][1] as RequestInit).signal?.aborted).toBe(true);
  });

  it('uses the authenticated official health endpoint', async () => {
    const fetcher = jest.fn(() => json({ status: 'ok' }));
    const client = createNativeOpenHandsClient({ baseUrl: 'http://127.0.0.1:8000', sessionApiKey: 'session-key', fetcher });
    await expect(client.health()).resolves.toBe(true);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:8000/health');
    expect(init.headers).toHaveProperty('X-Session-API-Key', 'session-key');
  });

  it('recognises non-empty unpriced native usage as unknown, not free', () => {
    expect(nativeOpenHandsCost({ stats: { usage_to_metrics: { default: {
      accumulated_cost: 0, costs: [], accumulated_token_usage: { prompt_tokens: 306258, completion_tokens: 4135 },
    } } } })).toBeNull();
    expect(nativeOpenHandsCost({})).toBeNull();
  });

  it('sums native usage groups without adding cache tokens again', () => {
    expect(nativeOpenHandsCost({ stats: { usage_to_metrics: {
      default: { accumulated_cost: 0.2, costs: [{}], accumulated_token_usage: { prompt_tokens: 1000, completion_tokens: 20, cache_read_tokens: 900 } },
      condenser: { accumulated_cost: 0.03, costs: [{}], accumulated_token_usage: { prompt_tokens: 100, completion_tokens: 20 } },
    } } })).toBeCloseTo(0.23);
  });

  it('does not start a conversation under an expired mandate', async () => {
    const fetcher = jest.fn();
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'key', fetcher });
    await expect(client.execute({ ...envelope, deadline: '2020-01-01T00:00:00Z' })).resolves.toMatchObject({ ok: false, cost_usd: 0, summary: 'openhands_deadline_expired' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('stops at the signed deadline, confirms pause and collects final usage', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockImplementationOnce(() => json({ accepted: true }))
      .mockImplementationOnce((_url: URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }))
      .mockImplementationOnce(() => json({ paused: true }))
      .mockImplementationOnce(() => json({ execution_status: 'paused', cost_usd: 0.07 }));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'key', fetcher });
    await expect(client.execute({ ...envelope, deadline: new Date(Date.now() + 100).toISOString() }))
      .resolves.toMatchObject({ ok: false, cost_usd: 0.07, summary: 'openhands_deadline_expired' });
  });

  it('does not falsely confirm pause or report zero if Agent Server is unreachable', async () => {
    const fetcher = jest.fn()
      .mockImplementationOnce(() => json({ conversation_id: conversationId }))
      .mockRejectedValue(new Error('connection lost'));
    const client = createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: 'key', fetcher });
    await expect(client.execute(envelope)).resolves.toMatchObject({ ok: false, cost_usd: null, summary: 'openhands_pause_unconfirmed' });
  });

  it('fails closed on missing session key and plaintext remote endpoints', () => {
    expect(() => createNativeOpenHandsClient({ baseUrl: 'https://hands.invalid', sessionApiKey: '' })).toThrow('openhands_session_key_required');
    expect(() => createNativeOpenHandsClient({ baseUrl: 'http://hands.invalid', sessionApiKey: 'key' })).toThrow('openhands_url_requires_https_or_trusted_service');
  });

  it('admits only an explicitly named plaintext service on the isolated network', async () => {
    const fetcher = jest.fn(() => json({ ok: true }));
    const client = createNativeOpenHandsClient({
      baseUrl: 'http://openhands-agent:8000', sessionApiKey: 'session-key',
      plaintextServiceHosts: ['openhands-agent'], fetcher,
    });
    await expect(client.health()).resolves.toBe(true);
    const [healthUrl] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(healthUrl)).toBe('http://openhands-agent:8000/health');
    expect(() => createNativeOpenHandsClient({
      baseUrl: 'http://other-agent:8000', sessionApiKey: 'session-key', plaintextServiceHosts: ['openhands-agent'],
    })).toThrow('openhands_url_requires_https_or_trusted_service');
    expect(() => createNativeOpenHandsClient({
      baseUrl: 'http://openhands-agent:8000/path?redirect=x', sessionApiKey: 'session-key', plaintextServiceHosts: ['openhands-agent'],
    })).toThrow('openhands_url_invalid');
  });
});
