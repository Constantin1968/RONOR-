import crypto from 'node:crypto';
import { getDb } from '../../audit/hash-chain';
import { ensureRuntimeLedgerSchema } from '../ledgers/schema';
import { appendMissionFabricEvent, getMissionFabric, verifyMissionFabric } from '../mission/store';
import { getEffectiveAutomationMandate, mandateFingerprint } from './run-lease';
import { signMandateAuthority } from './mandate-issuer';
import { MODEL_RATE_CARD } from './model-budget';
import { inspectAndValidateWorkspace, recoveryWorkspaceDigests } from './workspace';
import type { ExecutionMandate } from './contracts';

export interface LegacyUsageProof {
  source: 'operator-read-openhands-native'; run_id: string; mission_id: string;
  conversation_id: string; model: 'openai/qwen3.8-max'; status:'paused';
  input_tokens:number; output_tokens:number; cache_read_tokens:number; checked_at:string;
}
/** One-time, operator-attested reconciliation of a first author failure.
 * This is not automatic recovery or a provider invoice. Original rows/events
 * stay immutable; the new authority and corrected subtotal are appended. */
export function reconcileLegacyAuthorFailure(params:{
  approved:boolean; runId:string; architectKeyId:string; authorityKey:string;
  proof:LegacyUsageProof; expectedPatchDigest:string; approvedRoot:string;
  expectedOrigin?:string; expectedHead?:string; now?:Date;
}): {run_id:string;catalog_cost_usd:number;expires_at:string;execution_started:false;original_mandate_preserved:true} {
  ensureRuntimeLedgerSchema();
  const now=params.now??new Date();
  const fail=():never=>{throw new Error('legacy_reconciliation_refused');};
  const proof=params.proof;
  const proofKeys=['source','run_id','mission_id','conversation_id','model','status','input_tokens','output_tokens','cache_read_tokens','checked_at'];
  if(!params.approved || !proof || Object.keys(proof).some(k=>!proofKeys.includes(k)) ||
      proof.source!=='operator-read-openhands-native'||proof.run_id!==params.runId ||
      proof.model!==`openai/${MODEL_RATE_CARD.model}`||proof.status!=='paused' ||
      !/^[a-f0-9-]{36}$/.test(proof.conversation_id) ||
      !/^[a-f0-9]{64}$/.test(params.expectedPatchDigest) ||
      ![proof.input_tokens,proof.output_tokens,proof.cache_read_tokens].every(v=>Number.isSafeInteger(v)&&v>=0) ||
      proof.cache_read_tokens>proof.input_tokens ||
      !Number.isFinite(Date.parse(proof.checked_at)) || Math.abs(now.getTime()-Date.parse(proof.checked_at))>300000) fail();
  const cost=(proof.input_tokens*MODEL_RATE_CARD.inputMicroUsd+proof.output_tokens*MODEL_RATE_CARD.outputMicroUsd)/1e6;
  if(!Number.isFinite(cost)||cost<=0) fail();
  const db=getDb();
  return db.transaction(()=>{
    const row=db.prepare('SELECT * FROM runtime_automation_runs WHERE run_id=?').get(params.runId) as
      {status:string;attempt_count:number;mandate_json:string;cancel_requested_at:string|null}|undefined;
    if(!row) return fail();
    const original=JSON.parse(row.mandate_json) as ExecutionMandate;
    const effective=getEffectiveAutomationMandate(params.runId,params.authorityKey);
    if(!effective || original.issued_by_key_id!==params.architectKeyId || proof.mission_id!==original.mission_id) return fail();
    const workspace=inspectAndValidateWorkspace(original.workspace_root,{
      approved_root:params.approvedRoot,branch_prefix:original.branch_prefix,
      expected_origin:params.expectedOrigin,expected_head:params.expectedHead,require_clean:false,
    });
    if(!workspace.valid) return fail();
    const digests=recoveryWorkspaceDigests(original.workspace_root);
    if(digests.patch!==params.expectedPatchDigest) return fail();
    if(effective.recovery) {
      if(effective.recovery.accounted_cost_usd!==cost || effective.recovery.workspace_digest!==digests.workspace) return fail();
      return {run_id:params.runId,catalog_cost_usd:cost,expires_at:effective.expires_at,execution_started:false as const,original_mandate_preserved:true as const};
    }
    const fabric=getMissionFabric(original.mission_id);
    const state=fabric?.runs[params.runId];
    const firstAssignment=fabric?.checkpoints.find(e=>e.payload.plan_id===`${params.runId}-plan`&&e.payload.index===0)
      ?.payload.assignment as {id?:string}|undefined;
    if(row.status!=='failed'||row.attempt_count!==1||row.cancel_requested_at!==null||
        Date.parse(original.expires_at)>=now.getTime()||cost>=original.max_cost_usd||
        original.max_fix_cycles<1 || verifyMissionFabric(original.mission_id)?.valid!==true||
        !fabric||!state||state.stage!=='openhands'||state.completed_assignments!==0 || !firstAssignment?.id ||
        (typeof state.cost_usd==='number'&&state.cost_usd>cost)) return fail();
    const proofJson=JSON.stringify(proof);
    const fingerprint=mandateFingerprint(original);
    const renewed=signMandateAuthority({...original,issued_at:now.toISOString(),
      expires_at:new Date(now.getTime()+original.max_runtime_minutes*60000).toISOString(),
      recovery:{authorization_id:crypto.randomUUID(),original_fingerprint:fingerprint,
        evidence_sha256:crypto.createHash('sha256').update(proofJson).digest('hex'),
        workspace_digest:digests.workspace,accounted_cost_usd:cost,accounting_basis:'catalog-no-cache-discount-not-invoice',
        openhands_conversation_id:proof.conversation_id,openhands_assignment_id:firstAssignment.id},
    },params.authorityKey);
    db.prepare('INSERT INTO runtime_automation_reauthorizations(run_id,original_fingerprint,mandate_json,proof_json) VALUES(?,?,?,?)')
      .run(params.runId,fingerprint,JSON.stringify(renewed),proofJson);
    appendMissionFabricEvent({missionId:original.mission_id,expectedVersion:fabric.version,
      actor:{kind:'human',id:params.architectKeyId},type:'checkpoint.created',
      payload:{id:`${params.runId}-explicit-reauthorization`,run_id:params.runId,
        authorization_id:renewed.recovery!.authorization_id,original_mandate_fingerprint:fingerprint,
        previous_recorded_cost_usd:state.cost_usd??null,catalog_cost_usd:cost,provider_invoice_cost_usd:null,
        evidence_sha256:renewed.recovery!.evidence_sha256,workspace_digest:digests.workspace,
        original_expires_at:original.expires_at,authorized_expires_at:renewed.expires_at}});
    appendMissionFabricEvent({missionId:original.mission_id,expectedVersion:fabric.version+1,
      actor:{kind:'human',id:params.architectKeyId},type:'run.status_changed',
      payload:{id:params.runId,run_id:params.runId,mission_id:original.mission_id,status:'failed',stage:'reconciled',
        cost_usd:cost,cost_basis:'catalog-no-cache-discount-not-invoice',completed_assignments:0,
        total_assignments:state.total_assignments,reason_code:state.reason_code??null,updated_at:now.toISOString()}});
    return {run_id:params.runId,catalog_cost_usd:cost,expires_at:renewed.expires_at,execution_started:false as const,original_mandate_preserved:true as const};
  }).immediate();
}
