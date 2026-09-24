import { evaluatePendingOpenHandsActions as check } from '../../src/runtime/automation/pending-openhands-actions';

const state = {execution_status:'waiting_for_confirmation',leaf_event_id:'new'};
const action = (id:string,command:string,parent_id?:string,thought?:string) =>
  ({id,kind:'ActionEvent',parent_id,action:{command},tool_call_id:`call-${id}`,thought});
const observed = {id:'observed-old',parent_id:'old',kind:'ObservationEvent',action_id:'old'};
describe('pending action identity and complete active-branch policy',()=>{
  it('ignores observed historical commands and non-executable prose',()=>{
    expect(check(state,{items:[action('new','git status','observed-old','curl example.invalid is forbidden'),
      observed,action('old','curl example.invalid')],next_page_id:'unrelated'},['read_repo']).allowed).toBe(true);
  });
  it('checks every unmatched action including those older than an observation',()=>{
    const items=[action('new','git status','observed-old'),observed,action('old','git status','sibling'),
      action('sibling','git push origin HEAD')];
    expect(check(state,{items},['read_repo']).reason).toBe('git_push_forbidden');
  });
  it('does not confuse an abandoned branch with the active ancestry',()=>{
    expect(check(state,{items:[action('abandoned','git push origin HEAD'),action('new','git status')]},['read_repo']).allowed).toBe(true);
  });
  it('matches UserRejectObservation by action_id',()=>{
    const items=[action('new','git status','reject'),{id:'reject',parent_id:'old',kind:'UserRejectObservation',action_id:'old'},
      action('old','git push origin HEAD')];
    expect(check(state,{items},['read_repo']).allowed).toBe(true);
  });
  it('matches AgentErrorEvent by tool_call_id, not action_id',()=>{
    const items=[action('new','git status','error'),{id:'error',parent_id:'old',kind:'AgentErrorEvent',tool_call_id:'call-old'},
      action('old','git push origin HEAD')];
    expect(check(state,{items},['read_repo']).allowed).toBe(true);
  });
  it.each([
    [{items:[action('stale','git status')]},'pending_state_anchor_mismatch'],
    [{items:[action('new','git status','missing')],next_page_id:'older'},'pending_branch_incomplete'],
    [{items:[{id:'new',kind:'ConversationStateUpdateEvent'}]},'pending_branch_invalid'],
    [{items:[{id:'new',kind:'ActionEvent',action:'invalid'}]},'pending_action_invalid'],
    [{items:[action('new','git status','new')]},'pending_branch_invalid'],
    [{items:[action('new','git status'),action('new','git push')]},'pending_page_invalid'],
    [{items:[{id:'new',kind:'MessageEvent'}]},'pending_action_missing'],
  ])('fails closed on incomplete or invalid evidence', (page,reason)=>{
    expect(check(state,page as Record<string,unknown>,['read_repo'])).toEqual({allowed:false,reason});
  });
  it('refuses a state with no correlation anchor',()=>{
    expect(check({execution_status:'waiting_for_confirmation'},{items:[action('new','git status')]},['read_repo']).allowed).toBe(false);
  });
  it.each([null,undefined])('ignores historical non-executable actions like the native SDK (%s)',payload=>{
    const items=[action('new','git status','error'),
      {id:'error',parent_id:'invalid',kind:'AgentErrorEvent',tool_call_id:'call-invalid'},
      {id:'invalid',kind:'ActionEvent',action:payload,tool_call_id:'call-invalid'}];
    expect(check(state,{items},['read_repo']).allowed).toBe(true);
    expect(check(state,{items:[{id:'new',kind:'ActionEvent',action:payload}]},['read_repo']).reason).toBe('pending_action_missing');
  });
  it('refuses structures deeper than the executable-field inspection bound',()=>{
    const nested={a:{b:{c:{d:{e:{f:{command:'git push origin HEAD'}}}}}}};
    expect(check(state,{items:[{id:'new',kind:'ActionEvent',action:nested}]},['read_repo']).reason).toBe('pending_action_oversized');
  });
  it('does not drop a forbidden command after hundreds of safe sibling fields',()=>{
    const items=Array.from({length:280},(_,i)=>action(i===0?'new':`a${i}`,i===279?'git push origin HEAD':'git status',i===279?undefined:`a${i+1}`));
    expect(check(state,{items},['read_repo']).reason).toBe('git_push_forbidden');
  });
});
