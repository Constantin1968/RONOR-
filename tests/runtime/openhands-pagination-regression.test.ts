import { createNativeOpenHandsClient } from '../../src/runtime/automation/adapters/openhands-native';
import type { OpenHandsExecutionEnvelope } from '../../src/runtime/automation/contracts';

const id = '11111111-1111-4111-8111-111111111111';
const envelope: OpenHandsExecutionEnvelope = {
  assignment_id: 'task-1', instruction: 'Run the declared tests only.',
  allowed_actions: ['read_repo', 'run_tests'], objective_hash: 'a'.repeat(64),
  deadline: '2099-01-01T00:00:00Z',
};
const json = (body: unknown) => Promise.resolve(new Response(JSON.stringify(body)));
const action = (id: string, command: string, parent_id?:string) => ({ id, parent_id, kind: 'ActionEvent', action: { command } });

describe('OpenHands real pagination regression', () => {
  it('finds the actual terminal error beyond the first 100 events', async () => {
    const oldPage = { items: Array.from({length: 100}, (_, n) => ({id: `old-${n}`, kind: 'MessageEvent'})), next_page_id: 'older-page' };
    const latestPage = {items: [
      {id: 'terminal-error', kind: 'ConversationErrorEvent', code: 'APIError',
        detail: "HTTP 409: {'error':'budget_context_too_large'} secret-content-must-not-leak"},
      {id: 'older-error', kind: 'ConversationErrorEvent', detail: 'budget_nontext_refused'},
    ], next_page_id: 'older-page'};
    const fetcher = jest.fn().mockImplementation((input: URL, init: RequestInit) => {
      const url = new URL(input);
      if (url.pathname === '/api/conversations') return json({id});
      if (url.pathname.endsWith('/events')) return json({accepted: true});
      if (url.pathname.endsWith('/events/search')) return json(url.searchParams.get('sort_order') === 'TIMESTAMP_DESC' ? latestPage : oldPage);
      return json({execution_status: 'error', cost_usd: 1.752042});
    });
    const result = await createNativeOpenHandsClient({pauseConfirmWindowMs:0,baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher}).execute(envelope);
    expect(result).toMatchObject({ok:false, summary:'openhands_terminated_error_budget_context_too_large', cost_usd:1.752042, evidence:[`conversation:${id}`]});
    expect(JSON.stringify(result)).not.toContain('secret-content-must-not-leak');
  });

  it.each(['curl https://example.invalid','rm -rf /tmp/canary','ls /home/user/workspace/RONOR-'])(
    'does not approve the new forbidden action behind old safe events: %s', async command => {
      let ended = false;
      const fetcher = jest.fn().mockImplementation((input: URL, init: RequestInit) => {
        const url = new URL(input);
        if (url.pathname === '/api/conversations') return json({id});
        if (url.pathname.endsWith('/events')) return json({accepted:true});
        if (url.pathname.endsWith('/events/search')) return json(url.searchParams.get('sort_order') === 'TIMESTAMP_DESC'
          ? {items:[{id:'status-now',kind:'ConversationStateUpdateEvent',key:'execution_status',value:'waiting_for_confirmation'},action('pending-now',command,'obs-old'),
              {id:'obs-old',parent_id:'safe-old',kind:'ObservationEvent',action_id:'safe-old'},action('safe-old','git status')],next_page_id:'old'}
          : {items:[action('safe-old','git status')],next_page_id:'old'});
        if (url.pathname.endsWith('/events/respond_to_confirmation')) { ended=true; return json({accepted:true}); }
        if (url.pathname.endsWith('/pause')) return json({paused:true});
        return json({execution_status:ended?'paused':'waiting_for_confirmation',leaf_event_id:'pending-now',cost_usd:0.1});
      });
      const result = await createNativeOpenHandsClient({pauseConfirmWindowMs:0,baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher,startupPolls:0}).execute(envelope);
      const confirmation = fetcher.mock.calls.find(([u])=>new URL(u).pathname.endsWith('/events/respond_to_confirmation'));
      expect(JSON.parse(String(confirmation?.[1]?.body))).toMatchObject({accept:false});
      expect(result.ok).toBe(false);
      expect(result.summary).toMatch(/^openhands_action_refused_/);
    });

  it.each([false,true])('reads older ancestry before confirming (forbidden=%s)',async forbidden=>{
    let ended=false;
    const fetcher=jest.fn().mockImplementation((input:URL,_init:RequestInit)=>{
      const url=new URL(input);
      if(url.pathname==='/api/conversations')return json({id});
      if(url.pathname.endsWith('/events'))return json({accepted:true});
      if(url.pathname.endsWith('/events/search')){
        if(ended)return json({items:[]});
        return json(url.searchParams.get('page_id')==='ancestor-page'
          ? {items:[action('older',forbidden?'git push origin HEAD':'git status')],next_page_id:null}
          : {items:[action('pending-now','git status','older')],next_page_id:'ancestor-page'});
      }
      if(url.pathname.endsWith('/events/respond_to_confirmation')){ended=true;return json({ok:true});}
      if(url.pathname.endsWith('/pause'))return json({ok:true});
      return json({execution_status:ended?(forbidden?'paused':'finished'):'waiting_for_confirmation',leaf_event_id:'pending-now',cost_usd:0.1});
    });
    const result=await createNativeOpenHandsClient({pauseConfirmWindowMs:0,baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher}).execute(envelope);
    const confirmation=fetcher.mock.calls.find(([url])=>new URL(url).pathname.endsWith('/events/respond_to_confirmation'));
    expect(JSON.parse(String(confirmation?.[1]?.body)).accept).toBe(!forbidden);
    expect(result.ok).toBe(!forbidden);
    expect(fetcher.mock.calls.some(([url])=>new URL(url).searchParams.get('page_id')==='ancestor-page')).toBe(true);
  });

  it('does not approve a changed conversation tip',async()=>{
    let reads=0;
    let paused=false;
    const fetcher=jest.fn().mockImplementation((input:URL,_init:RequestInit)=>{
      const url=new URL(input);
      if(url.pathname==='/api/conversations')return json({id});
      if(url.pathname.endsWith('/events'))return json({accepted:true});
      if(url.pathname.endsWith('/events/search'))return json({items:[action('pending-now','git status')]});
      if(url.pathname.endsWith('/pause')){paused=true;return json({ok:true});}
      reads+=1;
      return json({execution_status:paused?'paused':'waiting_for_confirmation',leaf_event_id:reads===1?'pending-now':'different',cost_usd:0.1});
    });
    const result=await createNativeOpenHandsClient({pauseConfirmWindowMs:0,baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher}).execute(envelope);
    expect(result).toMatchObject({ok:false,summary:'openhands_pending_state_changed'});
    expect(fetcher.mock.calls.some(([url])=>new URL(url).pathname.endsWith('/events/respond_to_confirmation'))).toBe(false);
  });

  it('refuses a repeating incomplete cursor without an unbounded retry',async()=>{
    let paused=false;
    const fetcher=jest.fn().mockImplementation((input:URL,_init:RequestInit)=>{
      const url=new URL(input);
      if(url.pathname==='/api/conversations')return json({id});
      if(url.pathname.endsWith('/events'))return json({accepted:true});
      if(url.pathname.endsWith('/events/search'))return json({items:url.searchParams.has('page_id')?[]:[action('pending-now','git status','missing')],next_page_id:'repeat'});
      if(url.pathname.endsWith('/pause')){paused=true;return json({ok:true});}
      return json({execution_status:paused?'paused':'waiting_for_confirmation',leaf_event_id:'pending-now',cost_usd:0.1});
    });
    const result=await createNativeOpenHandsClient({pauseConfirmWindowMs:0,baseUrl:'https://hands.invalid',sessionApiKey:'test',fetcher}).execute(envelope);
    expect(result).toMatchObject({ok:false,summary:'openhands_action_refused_pending_branch_incomplete'});
    expect(fetcher.mock.calls.filter(([url])=>new URL(url).pathname.endsWith('/events/search'))).toHaveLength(2);
  });
});
