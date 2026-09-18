// Read-only operator evidence for the one preserved legacy run. Never print secrets.
const {requiredSecret:r}=require('/app/dist/runtime/automation/services/secret-files.js');
(async()=>{
  const id='e9b2ae3e-8bfc-4fcc-9d10-1ac8c1e11b6c';
  const response=await fetch(`${r('RONOR_OPENHANDS_AGENT_SERVER_URL')}/api/conversations/${id}`,{
    headers:{'X-Session-API-Key':r('RONOR_OPENHANDS_SESSION_API_KEY')},
    redirect:'error',signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw Error();
  const state=await response.json();
  if(state.execution_status!=='paused'||state.agent?.llm?.model!=='openai/qwen3.8-max'||
      state.confirmation_policy?.kind!=='AlwaysConfirm'||state.workspace?.working_dir!=='/workspace/project')throw Error();
  const metrics=Object.values(state.stats?.usage_to_metrics??{});
  if(!metrics.length)throw Error();
  const totals={input_tokens:0,output_tokens:0,cache_read_tokens:0};
  for(const m of metrics){
    if(m.model_name!=='openai/qwen3.8-max')throw Error();
    for(const [name,native] of Object.entries({input_tokens:'prompt_tokens',output_tokens:'completion_tokens',cache_read_tokens:'cache_read_tokens'})){
      const value=m.accumulated_token_usage?.[native];
      if(!Number.isSafeInteger(value)||value<0)throw Error();
      totals[name]+=value;
    }
  }
  console.log(JSON.stringify({source:'operator-read-openhands-native',
    run_id:'run_89afa1fe1d6c3438449e',mission_id:'msn_mtrqvmv8_ed4ab0a5',
    conversation_id:id,model:'openai/qwen3.8-max',status:'paused',...totals,checked_at:new Date().toISOString()}));
})().catch(()=>{console.error('legacy_native_proof_refused');process.exitCode=1;});
