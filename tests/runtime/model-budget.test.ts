import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ModelBudgetLedger, MAX_CONCURRENT_DISPATCH, verifyModelBudget, signModelBudget, reserveModelRequest, modelResponseCharge } from '../../src/runtime/automation/model-budget';
import type { ExecutionMandate } from '../../src/runtime/automation/contracts';

const key = 'budget-authority-test-key-32-bytes-long';
const mandate = { mission_id: 'm-budget', max_cost_usd: 1, expires_at: new Date(Date.now()+600_000).toISOString() } as ExecutionMandate;
const token = (spent = 0) => signModelBudget(mandate, {run_id:'r-budget',accounted_cost_usd:spent}, 'author', key);
const claims = (spent = 0) => verifyModelBudget(token(spent), key)!;

describe('signed persistent model budget', () => {
  it('authenticates the ceiling, previous consumption, mission, role and expiry', () => {
    expect(claims(0.2)).toMatchObject({ceiling_micro_usd:1e6,prior_micro_usd:200000,role:'author'});
    expect(verifyModelBudget(token(),key+'x')).toBeNull();
    expect(verifyModelBudget(token()+'x',key)).toBeNull();
    expect(verifyModelBudget(token(),key,Date.now()+700_000)).toBeNull();
    expect(verifyModelBudget(token(1),key)).toBeNull();
  });
  it('refuses overspending BEFORE reserving any dispatch', () => {
    const ledger = new ModelBudgetLedger(':memory:');
    expect(()=>ledger.reserve(claims(0.9),200000)).toThrow('budget_insufficient_before_dispatch');
    expect(ledger.snapshot('r-budget')).toBeNull();
    ledger.close();
  });
  it('cannot reset previous cost by replaying a token or switching model roles', () => {
    const ledger = new ModelBudgetLedger(':memory:');
    const id = ledger.reserve(claims(0.2),300000); ledger.settle(id,250000);
    const next = ledger.reserve({...claims(),role:'verifier'},200000); ledger.settle(next,100000);
    expect(ledger.snapshot('r-budget')?.spent).toBe(550000);
    expect(()=>ledger.reserve({...claims(),ceiling_micro_usd:2e6},1000)).toThrow('budget_identity_mismatch');
    ledger.close();
  });
  it('freezes permanently on an unresolved outcome, across restart and replay', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ronor-budget-'));
    const filename = path.join(dir,'ledger.db');
    let ledger = new ModelBudgetLedger(filename);
    const id = ledger.reserve(claims(),200000);
    ledger.settle(id,null);
    expect(ledger.snapshot('r-budget')).toMatchObject({frozen:1,pending:1,outstanding:200000});
    expect(()=>ledger.reserve(claims(),1000)).toThrow('budget_unresolved_dispatch');
    ledger.close(); ledger = new ModelBudgetLedger(filename);
    expect(()=>ledger.reserve(claims(),1000)).toThrow('budget_unresolved_dispatch');
    expect(ledger.snapshot('r-budget')).toMatchObject({frozen:1,pending:1});
    ledger.close(); fs.rmSync(dir,{recursive:true});
  });
  it('admits concurrent dispatches and holds each worst case against the ceiling', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ronor-budget-'));
    const filename = path.join(dir,'ledger.db');
    let ledger = new ModelBudgetLedger(filename);
    const first = ledger.reserve(claims(),200000);
    const second = ledger.reserve(claims(),300000);
    expect(ledger.snapshot('r-budget')).toMatchObject({pending:2,outstanding:500000,spent:0,frozen:0});
    // Outstanding worst cases are held, so the ceiling cannot be exceeded in flight.
    expect(()=>ledger.reserve(claims(),600000)).toThrow('budget_insufficient_before_dispatch');
    // An outstanding reservation survives restart and still holds its amount.
    ledger.close(); ledger = new ModelBudgetLedger(filename);
    expect(ledger.snapshot('r-budget')).toMatchObject({pending:2,outstanding:500000});
    expect(()=>ledger.reserve(claims(),600000)).toThrow('budget_insufficient_before_dispatch');
    ledger.settle(first,10000); ledger.settle(second,20000);
    expect(ledger.snapshot('r-budget')).toMatchObject({pending:0,outstanding:0,spent:30000,frozen:0});
    ledger.close(); fs.rmSync(dir,{recursive:true});
  });
  it('refuses dispatch beyond the concurrency bound without freezing the budget', () => {
    const ledger = new ModelBudgetLedger(':memory:');
    const ids = Array.from({length:MAX_CONCURRENT_DISPATCH},()=>ledger.reserve(claims(),1000));
    expect(ledger.snapshot('r-budget')).toMatchObject({pending:MAX_CONCURRENT_DISPATCH,frozen:0});
    expect(()=>ledger.reserve(claims(),1000)).toThrow('budget_dispatch_concurrency_exceeded');
    ledger.settle(ids[0]!,500);
    expect(typeof ledger.reserve(claims(),1000)).toBe('string');
    ledger.close();
  });
  it('records a provider overrun instead of clamping it to the reservation', () => {
    const ledger = new ModelBudgetLedger(':memory:');
    ledger.settle(ledger.reserve(claims(),1000),1001);
    expect(ledger.snapshot('r-budget')).toMatchObject({spent:1001,frozen:1});
    ledger.close();
  });
});
describe('text-only request reservations', () => {
  const body = (extra = {}) => Buffer.from(JSON.stringify({model:'qwen3.8-max',messages:[{role:'user',content:'hello'}],...extra}));
  it('reserves input plus capped output before a provider request', () => {
    const r = reserveModelRequest('/v1/chat/completions',body({max_tokens:10000}));
    expect(r.outputBound).toBe(4096);
    expect(r.payload.max_tokens).toBe(4096);
    expect(r.reserveMicroUsd).toBe(r.inputBound*2+4096*6);
  });
  it.each([{stream:true},{model:'unpriced'},{previous_response_id:'stored-context'},
    {tools:[{type:'web_search'}]}, {extra_body:{hidden:true}},
    {messages:[{role:'user',content:'test',cache_control:{type:'persistent'}}]},
    {messages:[{role:'user',content:'test',cache_control:{type:'ephemeral',ttl:'1h'}}]},
    {messages:[{role:'user',content:[{type:'text',text:'t',cache_control:{type:'persistent'}}]}]},
    {messages:[{role:'assistant',content:[{type:'text',text:'t'}],thinking_blocks:[{type:'thinking',thinking:'t',tool_use:{}}]}]},
    {messages:[{role:'assistant',content:[{type:'text',text:'t'}],thinking_blocks:[{type:'image',image_urls:['https://example.test']}]}]},
    {messages:[{role:'assistant',tool_calls:[]}]},
    {messages:[{role:'assistant'}]},
    {messages:[{role:'user',content:[{type:'image_url',image_url:{url:'https://example.test'}}]}]}])(
    'refuses non-admitted costs %j', extra => {
      expect(()=>reserveModelRequest('/v1/chat/completions',body(extra))).toThrow();
    });
  // Wire shapes produced by OpenHands SDK 1.42.1 Message.to_chat_dict / _list_serializer.
  it('admits the SDK prompt-cache markers, replayed thinking blocks and content-free tool-call turns', () => {
    const messages = [
      {role:'system',content:[{type:'text',text:'You are RONOR.',cache_control:{type:'ephemeral'}}]},
      {role:'user',content:[{type:'text',text:'Run tests.'}]},
      {role:'assistant',thinking_blocks:[{type:'thinking',thinking:'plan',signature:'sig'},{type:'redacted_thinking',data:'xx'}],
        tool_calls:[{id:'call_1',type:'function',function:{name:'bash',arguments:'{}'}}]},
      {role:'tool',tool_call_id:'call_1',name:'bash',content:[{type:'text',text:'ok'}],cache_control:{type:'ephemeral'}},
    ];
    const r = reserveModelRequest('/v1/chat/completions',body({messages}));
    expect(r.payload.max_tokens).toBe(4096);
    expect(r.reserveMicroUsd).toBe(r.inputBound*2+4096*6);
  });
  it('charges measured input and all output at the catalog ceiling, without claiming invoice equality', () => {
    expect(modelResponseCharge(Buffer.from('{"usage":{"prompt_tokens":100,"completion_tokens":10}}'))).toBe(260);
    expect(modelResponseCharge(Buffer.from('{"usage":{"input_tokens":0,"output_tokens":0}}'))).toBe(0);
    expect(modelResponseCharge(Buffer.from('{}'))).toBeNull();
  });
});
