import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {getDb} from '../../src/audit/hash-chain';
import {createMission,appendMissionFabricEvent,getMission,getMissionFabric} from '../../src/runtime/mission/store';
import {signMandateAuthority} from '../../src/runtime/automation/mandate-issuer';
import {claimAutomationRun,getEffectiveAutomationMandate} from '../../src/runtime/automation/run-lease';
import {executionRunId} from '../../src/runtime/automation/runner';
import {ALWAYS_DENIED_ACTIONS,objectiveHash} from '../../src/runtime/automation/policy';
import {recoveryWorkspaceDigests} from '../../src/runtime/automation/workspace';
import {reconcileLegacyAuthorFailure, type LegacyUsageProof} from '../../src/runtime/automation/legacy-reconciliation';

const key='reconciliation-authority-test-32-bytes';
const now=new Date('2026-09-08T02:00:00Z');
const dirs:string[]=[];
afterEach(()=>{for(const dir of dirs.splice(0))fs.rmSync(dir,{recursive:true,force:true});});
function fixture(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ronor-recovery-'));dirs.push(root);
  const git=(...args:string[])=>execFileSync('git',['-C',root,...args],{stdio:'pipe'}).toString().trim();
  git('init');git('checkout','-b','agent/recovery');
  fs.writeFileSync(path.join(root,'test.txt'),'original\n');git('add','test.txt');
  git('-c','user.name=Test','-c','user.email=test@example.invalid','-c','core.hooksPath=/dev/null','commit','-m','base');
  const head=git('rev-parse','HEAD');
  fs.writeFileSync(path.join(root,'test.txt'),'original\nworker patch\n');
  const mission=createMission({title:'Recovery',objective:'Add a test',operatorId:'merlin'});
  const mandate=signMandateAuthority({mandate_id:`mandate_${crypto.randomBytes(16).toString('hex')}`,
    mission_id:mission.mission_id,issued_by:'merlin',issued_by_key_id:'key_0123456789ab',
    objective_hash:objectiveHash(mission.objective),workspace_root:root,branch_prefix:'agent/recovery',
    allowed_actions:['read_repo','edit_worktree','run_tests'],denied_actions:[...ALWAYS_DENIED_ACTIONS],
    max_cost_usd:1,max_runtime_minutes:15,max_fix_cycles:1,
    issued_at:'2026-09-08T00:45:00Z',expires_at:'2026-09-08T01:00:00Z'},key);
  const runId=executionRunId(mandate.mandate_id);
  const claim=claimAutomationRun({runId,mandate,owner:'first-worker',authorityKey:key,now:new Date('2026-09-08T00:50:00Z')});
  if(claim.outcome!=='acquired')throw new Error('fixture_claim_failed');
  claim.lease.finish('failed');
  appendMissionFabricEvent({missionId:mission.mission_id,expectedVersion:getMissionFabric(mission.mission_id)!.version,
    actor:{kind:'langgraph',id:'langgraph'},type:'checkpoint.created',
    payload:{id:`${runId}-plan-0`,plan_id:`${runId}-plan`,index:0,assignment:{id:'a1',instruction:'Add a test',actions:['read_repo']}}});
  appendMissionFabricEvent({missionId:mission.mission_id,expectedVersion:getMissionFabric(mission.mission_id)!.version,
    actor:{kind:'openhands',id:'openhands'},type:'run.status_changed',
    payload:{id:runId,run_id:runId,status:'failed',stage:'openhands',cost_usd:0,completed_assignments:0,total_assignments:1}});
  const proof:LegacyUsageProof={source:'operator-read-openhands-native',run_id:runId,mission_id:mission.mission_id,
    conversation_id:crypto.randomUUID(),model:'openai/qwen3.8-max',status:'paused',
    input_tokens:306258,output_tokens:4135,cache_read_tokens:270336,checked_at:now.toISOString()};
  const params={approved:true,runId,architectKeyId:mandate.issued_by_key_id,authorityKey:key,proof,
    expectedPatchDigest:recoveryWorkspaceDigests(root).patch,approvedRoot:root,expectedHead:head,now};
  return {root,mandate,runId,params,mission};
}
describe('explicit first-author reconciliation and reauthorization',()=>{
  it('keeps the original mandate/events/patch and acknowledges catalog usage in the same execution',()=>{
    const f=fixture();const originalJson=JSON.stringify(f.mandate);
    const events=getMission(f.mission.mission_id)!.state.fabric.events.map(e=>e.event_hash);
    const digest=recoveryWorkspaceDigests(f.root);
    const result=reconcileLegacyAuthorFailure(f.params);
    expect(result).toMatchObject({catalog_cost_usd:0.637326,execution_started:false,original_mandate_preserved:true});
    expect(getDb().prepare('SELECT mandate_json FROM runtime_automation_runs WHERE run_id=?').get(f.runId))
      .toEqual({mandate_json:originalJson});
    expect(getMission(f.mission.mission_id)!.state.fabric.events.slice(0,events.length).map(e=>e.event_hash)).toEqual(events);
    expect(getMissionFabric(f.mission.mission_id)!.runs[f.runId].cost_usd).toBe(0.637326);
    expect(recoveryWorkspaceDigests(f.root)).toEqual(digest);
    const repeated=reconcileLegacyAuthorFailure({...f.params,now:new Date(now.getTime()+1000)});
    expect(repeated.expires_at).toBe(result.expires_at);
    const resumed=claimAutomationRun({runId:f.runId,mandate:f.mandate,owner:'resuming',authorityKey:key,now});
    expect(resumed.outcome).toBe('resumed');
    if(resumed.outcome!=='resumed')throw new Error('not_resumed');
    expect(resumed.attempt).toBe(2);
    expect(resumed.mandate.max_cost_usd).toBe(1);
    expect(resumed.mandate.mandate_id).toBe(f.mandate.mandate_id);
    resumed.lease.finish('failed');
    expect(claimAutomationRun({runId:f.runId,mandate:f.mandate,owner:'third',authorityKey:key,now}).outcome).toBe('fix_cycle_limit_exceeded');
  });
  it('refuses missing approval, wrong operator, stale evidence, excess cost and a changed patch',()=>{
    const f=fixture();
    for(const change of [
      {approved:false},{architectKeyId:'key_ffffffffffff'},{expectedPatchDigest:'f'.repeat(64)},
      {proof:{...f.params.proof,checked_at:'2020-01-01'}},
      {proof:{...f.params.proof,input_tokens:1000000}},
    ])expect(()=>reconcileLegacyAuthorFailure({...f.params,...change})).toThrow('legacy_reconciliation_refused');
    expect(getEffectiveAutomationMandate(f.runId,key)).toEqual(f.mandate);
    expect(getMissionFabric(f.mission.mission_id)!.runs[f.runId].cost_usd).toBe(0);
  });
  it('refuses tampering with the stored authority or its usage proof',()=>{
    const f=fixture();reconcileLegacyAuthorFailure(f.params);
    getDb().prepare("UPDATE runtime_automation_reauthorizations SET proof_json='{}' WHERE run_id=?").run(f.runId);
    expect(()=>getEffectiveAutomationMandate(f.runId,key)).toThrow('reauthorization_integrity_failed');
    expect(claimAutomationRun({runId:f.runId,mandate:f.mandate,owner:'bad',authorityKey:key,now}).outcome).toBe('conflict');
  });
  it('does not authorize untracked or staged work as the preserved legacy patch',()=>{
    const f=fixture();fs.writeFileSync(path.join(f.root,'unknown.txt'),'not acknowledged\n');
    expect(()=>reconcileLegacyAuthorFailure(f.params)).toThrow('recovery_workspace_not_admitted');
  });
});
