/** Account-scoped orchestration only. Existing recovery RPC owns task/writer fencing.
 * No creation, source writes, LLM calls, background presence service or other accounts.
 */
export function createAccountPreviewWarmup({userId,listProjects,probe,recover,isActive,now=Date.now,cooldownMs=300000}) {
 let stopped=false,running=false;
 const checked=new Map();
 return {
  stop(){stopped=true;},
  async check(){
   if(stopped||running||!isActive())return;
   running=true;
   try{
    const projects=await listProjects();
    for(const p of projects){
     if(stopped||!isActive())break;
     if(p.user_id!==userId||!p.sandbox_id||!p.preview_url||!p.checkpoint_id||p.deletion_state
      ||p.workspace_state!=='confirmed'||p.workspace_writer)continue;
     const key=[p.id,p.sandbox_id,p.workspace_revision,p.workspace_hash,p.preview_url].join(':');
     if(checked.has(key)&&now()-checked.get(key)<cooldownMs)continue;
     checked.set(key,now());
     try{
      const healthy=await probe(p.preview_url);
      if(stopped||!isActive())break;
      // Unknown connectivity is not proof of a stopped sandbox. The opened project's
      // bounded entry checks handle that case; background warmup only acts on failure.
      if(healthy===false)await recover(p.id);
     }catch{/* A single blocked project must not launch retry loops or block the account. */}
    }
   }finally{running=false;}
  }
 };
}
