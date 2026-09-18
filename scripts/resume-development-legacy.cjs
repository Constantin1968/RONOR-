// Requires a distinct, explicit approval to resume models, not merely to install code.
const fs=require('node:fs');
const {requiredSecret:r}=require('/app/dist/runtime/automation/services/secret-files.js');
let phase='validate-approval';
(async()=>{
  if(!process.argv.includes('--approved-resume'))throw Error('resume_approval_missing');
  const proof=JSON.parse(fs.readFileSync(0,'utf8'));
  const {main}=await import('/app/scripts/ronor-develop.mjs');
  const clientEnv={...process.env,RONOR_DEVELOPMENT_URL:'http://127.0.0.1:3010',
    RONOR_DEVELOPMENT_API_KEY_FILE:process.env.RONOR_ARCHITECT_API_KEY_FILE};
  phase='readiness-before-reauthorization';
  if((await main(['readiness'],clientEnv)).ready!==true)throw Error('resume_readiness_refused');
  phase='reconcile-and-reauthorize';
  const response=await fetch('http://127.0.0.1:3010/api/development/reconcile-author-failure',{
    method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
    headers:{Authorization:`Bearer ${r('RONOR_ARCHITECT_API_KEY')}`,'content-type':'application/json'},
    body:JSON.stringify({approved:true,run_id:'run_89afa1fe1d6c3438449e',proof,
      expected_patch_digest:'fba7cc3f403a4286097562e15fa908e1ea16ebd788afb296f5367c170c35a426'})});
  if(!response.ok)throw Error(`controller_http_${response.status}`);
  const receipt=await response.json();
  if(receipt.ok!==true||receipt.run_id!=='run_89afa1fe1d6c3438449e'||receipt.execution_started!==false)throw Error('resume_receipt_invalid');
  console.log(JSON.stringify({phase,receipt}));
  const request='/tmp/ronor-development-regression-request.json';
  fs.writeFileSync(request,JSON.stringify({
    objective:'Add one focused regression test in tests/runtime/development-controller.test.ts proving that an empty objective and a whitespace-only objective are rejected with HTTP 400. Reuse the existing fixtures and a valid unique idempotency identifier. Change only this test file; do not change implementation, dependencies, configuration, or other files. Run the relevant existing test suite. If the required test already exists, verify it without duplicating it. At most one local commit is permitted on the existing development branch. Never push, merge, release, deploy, alter history, or read credentials.',
    max_cost_usd:1,max_runtime_minutes:15,max_fix_cycles:1,
  }),{mode:0o600});
  phase='resume-same-run';
  const result=await main(['start',`--request=${request}`,'--id=ronor-empty-objective-regression-20260907'],clientEnv);
  console.log(JSON.stringify({phase,result}));
})().catch(error=>{
  const code=/^(resume_approval_missing|resume_receipt_invalid|resume_readiness_refused|controller_http_[0-9]{3})$/.test(error.message)?error.message:'recovery_step_failed';
  console.error(JSON.stringify({ok:false,phase,error:code}));process.exitCode=1;
});
