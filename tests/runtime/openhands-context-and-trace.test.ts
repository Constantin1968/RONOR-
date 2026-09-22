import {createNativeOpenHandsClient,CONTEXT_BOUNDS} from '../../src/runtime/automation/adapters/openhands-native';
import {reserveModelRequest,MODEL_RATE_CARD} from '../../src/runtime/automation/model-budget';
import type {OpenHandsExecutionEnvelope} from '../../src/runtime/automation/contracts';
const id='11111111-1111-4111-8111-111111111111';
const envelope:OpenHandsExecutionEnvelope={assignment_id:'test',instruction:'Run tests.',allowed_actions:['run_tests'],objective_hash:'a'.repeat(64),deadline:'2099-01-01T00:00:00Z',budget_token:'test-budget'};
const json=(value:unknown)=>Promise.resolve(new Response(JSON.stringify(value)));
describe('bounded context and pre-inference trace barrier',()=>{
  it('uses one provider/budget for agent and condenser without raising egress limits',async()=>{
    let payload:any;
    const fetcher=jest.fn().mockImplementation((url:URL,init:RequestInit)=>{
      if(url.pathname==='/api/conversations'){payload=JSON.parse(String(init.body));return json({id});}
      if(url.pathname.endsWith('/events/search'))return json({items:[]});
      return json({execution_status:'finished',cost_usd:0});
    });
    await createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher,
      llm:{model:'openai/qwen3.8-max',apiKey:'test-key',baseUrl:'http://model-egress-proxy:3004/v1'}}).execute(envelope);
    expect(payload.agent.condenser.llm).toEqual({...payload.agent.llm,usage_id:'condenser'});
    expect(payload.agent.llm.extra_headers['x-ronor-budget']).toBe('test-budget');
    expect(payload.agent.llm.max_output_tokens).toBe(4096);
    expect(payload.agent.condenser.max_size).toBe(CONTEXT_BOUNDS.condenserMaxSize);
    expect(payload.agent.condenser.max_tokens).toBe(CONTEXT_BOUNDS.condenserMaxTokens);
    expect(payload.autotitle).toBe(false);
    // A smaller configured condensation threshold is not permission to bypass
    // the unchanged hard guard. A huge request must still be refused.
    const tooLarge=Buffer.from(JSON.stringify({model:MODEL_RATE_CARD.model,messages:[{role:'user',content:'x'.repeat(250000)}]}));
    expect(()=>reserveModelRequest('/v1/chat/completions',tooLarge)).toThrow('budget_context_too_large');
  });
  it('persists the conversation before sending a runnable message',async()=>{
    const calls:string[]=[];
    const fetcher=jest.fn().mockImplementation((url:URL)=>{
      calls.push(url.pathname);
      if(url.pathname==='/api/conversations')return json({id});
      if(url.pathname.endsWith('/events/search'))return json({items:[]});
      return json({execution_status:'finished',cost_usd:0});
    });
    await createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher,
      onConversationCreated:async(got,value)=>{expect(got).toBe(id);expect(value).toBe(envelope);calls.push('durable');}}).execute(envelope);
    expect(calls.indexOf('durable')).toBeLessThan(calls.indexOf(`/api/conversations/${id}/events`));
  });
  it('never starts inference when the receipt cannot be persisted',async()=>{
    const fetcher=jest.fn().mockImplementation((url:URL)=>{
      if(url.pathname==='/api/conversations')return json({id});
      return json({execution_status:'paused',cost_usd:0});
    });
    const result=await createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher,
      onConversationCreated:async()=>{throw Error('disk full');}}).execute(envelope);
    expect(result).toMatchObject({ok:false,summary:'openhands_trace_persist_failed',cost_usd:0,evidence:[`conversation:${id}`]});
    expect(fetcher.mock.calls.some(([url])=>new URL(url).pathname.endsWith('/events'))).toBe(false);
  });
  it('refuses to resume a legacy condenser even when the agent budget header was renewed',async()=>{
    const state={execution_status:'paused',
      agent:{llm:{model:'openai/qwen3.8-max',extra_headers:{'x-ronor-budget':'test-budget'}},
        condenser:{kind:'LLMSummarizingCondenser',max_size:240,max_tokens:null}},
      workspace:{working_dir:'/workspace/project'},confirmation_policy:{kind:'AlwaysConfirm'},
      stats:{usage_to_metrics:{agent:{model_name:'openai/qwen3.8-max',accumulated_token_usage:{prompt_tokens:100000,completion_tokens:0}}}}};
    const fetcher=jest.fn().mockImplementation((url:URL)=>json(url.pathname.endsWith('/switch_llm')?{ok:true}:state));
    const result=await createNativeOpenHandsClient({baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher,catalogAccounting:true,
      llm:{model:'openai/qwen3.8-max',apiKey:'test-key',baseUrl:'http://model-egress-proxy:3004/v1'}})
      .execute({...envelope,resume:{conversation_id:id,accounted_cost_usd:0.2}});
    expect(result).toMatchObject({ok:false,summary:'openhands_resume_context_unverified'});
    expect(fetcher.mock.calls.some(([url])=>new URL(url).pathname.endsWith('/run'))).toBe(false);
  });
});
