import {test} from 'node:test';
import assert from 'node:assert/strict';
import {assertUserApplyExecution,executeUserApply,userApplyBasis} from '../src/user-apply.js';
const task={id:'t',project_id:'p',user_id:'u',operation:'user_apply',requested_changeset_id:'c',context_workspace_revision:42};
const change={id:'c',project_id:'p',user_id:'u',task_id:'t',actor:'user',origin:'user_apply',submission_fingerprint:'fixed',base_revision:42,base_hash:'hash',status:'prepared'};
test('stale execution / mismatched identity rejected; committed own install revision may resume without source rewrite',()=>{
 const state={revision:42,code_hash:'hash',writer:null};
 for(const mutation of [{revision:43},{code_hash:'other'},{writer:{task_id:'other'}}])assert.throws(()=>assertUserApplyExecution(task,change,{...state,...mutation}));
 assert.doesNotThrow(()=>assertUserApplyExecution({...task,context_workspace_revision:44},{...change,status:'committed'},{revision:44}));
 assert.throws(()=>assertUserApplyExecution(task,{...change,actor:'agent'},state));
});
test('User Apply calls no LLM; persisted content applied once; committed resume only validates; invalid basis stops before mutation',async()=>{
 let calls=0,writes=0;let c={...change};
 const workspace={state:{revision:42,code_hash:'hash'},read:async()=>{},applyRequested:async()=>{writes++;c={...c,status:'committed'};}};
 const args={task,workspace,loadChange:async()=>c,validateBasis:async()=>({fixed:true}),validateAndComplete:async b=>b,chat:()=>{calls++;throw Error('never');}};
 assert.deepEqual(await executeUserApply(args),{fixed:true});assert.equal(writes,1);
 await executeUserApply(args);assert.equal(writes,1);assert.equal(calls,0);
 c={...change};await assert.rejects(executeUserApply({...args,validateBasis:async()=>{throw Error('basis');}}),/basis/);assert.equal(writes,1);
});

test('existing action keeps confirmed user styling; initial/formal Plan or explicit design change retains design generation',async()=>{
 const {preserveIterationDesign}=await import('../src/agent.js');
 assert.equal(preserveIterationDesign({checkpoint_id:'v1'},{kind:'action'},'增加标签筛选'),true);
 assert.equal(preserveIterationDesign({checkpoint_id:'v1'},{kind:'action'},'改成深色主题'),false);
 assert.equal(preserveIterationDesign({checkpoint_id:'v1'},{kind:'plan'},'按批准计划构建'),false);
 assert.equal(preserveIterationDesign({},{kind:'action'},'生成应用'),false);
});


test('validation reads immutable submission basis, never a mutable failure/reconcile result',()=>{
 const basis={checkpoint_id:'checkpoint',basis_id:'plan',build_basis:'build',verify_basis:'verify'};
 for(const result of [{},null,{basis_id:'wrong',build_basis:'wrong',verify_basis:'wrong'},{error:'partial'}])
  assert.deepEqual(userApplyBasis({...change,submission_basis:basis,result}),basis);
 assert.throws(()=>userApplyBasis({...change,result:basis}),/immutable submission basis is missing/);
});
