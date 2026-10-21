import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runtimeTaskStatus,quiesceRuntimeSandbox,reconcileBuildWorkspace} from '../src/runtime-recovery.js';
const now=Date.now(), task={id:'task',execution_id:'new',project_id:'p',user_id:'u'};
const current={...task,status:'running',lease_until:new Date(now+60000).toISOString()};
const writer={kind:'preview',execution_id:'old',result:{error:'start failed'}};
test('resumed Build excludes only its own confirmed successor lease; failed preview can reconcile',()=>{
 assert.deepEqual(runtimeTaskStatus([current],writer,task,now),{terminal:true,active:false,leaseActive:false});
 assert.equal(runtimeTaskStatus([current,{id:'other',status:'paused'}],writer,task,now).active,true);
 assert.equal(runtimeTaskStatus([current],{...writer,result:{}},task,now).terminal,false);
 assert.equal(runtimeTaskStatus([current,{id:'old',execution_id:'old',lease_until:new Date(now+60000).toISOString()}],writer,task,now).leaseActive,true);
});
test('missing, expired, mismatched or same execution cannot authorize recovery',()=>{
 for(const rows of [[],[{...current,status:'failed'}],[{...current,execution_id:'foreign'}],[{...current,lease_until:new Date(now-1).toISOString()}]])
  assert.throws(()=>runtimeTaskStatus(rows,writer,task,now),{code:'LEASE_LOST'});
 assert.throws(()=>runtimeTaskStatus([current],{...writer,execution_id:'new'},task,now),{code:'LEASE_LOST'});
});
test('retired previous execution of the same task is terminal only for a valid leased successor',()=>{
 assert.equal(runtimeTaskStatus([current],{kind:'build',task_id:'task',execution_id:'old'},task,now).terminal,true);
 assert.equal(runtimeTaskStatus([{id:'task',status:'running'}],{kind:'build',task_id:'task',execution_id:'old'}).terminal,false);
 assert.equal(runtimeTaskStatus([{id:'task',status:'succeeded_with_warnings'}],{kind:'build',task_id:'task',execution_id:'old'}).terminal,true);
});
function providerFixture(state='started',stoppedState='stopped'){
 const calls=[];let gets=0;
 return {calls,provider:{cache:new Map([['s',{}]]),client:{get:async()=>{calls.push('get');return {state:gets++?stoppedState:state};},stop:async()=>calls.push('stop'),start:async()=>calls.push('start')}}};
}
test('quiescence proves stopped lifecycle before start; transition, failed stop and lost lease cannot clear',async()=>{
 const f=providerFixture();await quiesceRuntimeSandbox(f.provider,'s',async()=>{});
 assert.deepEqual(f.calls,['get','stop','get','start']);assert.equal(f.provider.cache.has('s'),false);
 for(const f of [providerFixture('stopping'),providerFixture('started','started')]){
  await assert.rejects(quiesceRuntimeSandbox(f.provider,'s',async()=>{}),{code:'WORKSPACE_UNCERTAIN'});
  assert.ok(!f.calls.includes('start'));
 }
 const g=providerFixture();await assert.rejects(quiesceRuntimeSandbox(g.provider,'s',async()=>{throw Object.assign(Error(),{code:'LEASE_LOST'});}),{code:'LEASE_LOST'});
 assert.deepEqual(g.calls,[]);
});
test('Build recovery routes retained preview to existing exact-manifest reconciler, not source replay',async()=>{
 let inspected=0,checked=0;const f=providerFixture();
 const workspace={sandboxId:'s',state:{writer},reconcile:()=>assert.fail('must not replay source'),reconcileRuntime:async({inspect,quiesce})=>{await inspect(writer);await quiesce();}};
 await reconcileBuildWorkspace({workspace,provider:f.provider,task,checkLease:async()=>checked++,inspectWriter:async(p,u,w,options)=>{
  inspected++;assert.equal(p,'p');assert.equal(u,'u');assert.equal(w,writer);assert.equal(options.resumingTask,task);
 }});
 assert.equal(inspected,1);assert.ok(checked>=4);
});
test('source mutation and install drift retain their dedicated recovery and never stop runtime here',async()=>{
 for(const retained of [{kind:'mutation'},{kind:'materialize'},{kind:'install',changeset_id:'drift'}]){
  let calls=0;
  await reconcileBuildWorkspace({workspace:{state:{writer:retained},reconcile:async()=>calls++},task,inspectWriter:()=>assert.fail(),checkLease:()=>assert.fail()});
  assert.equal(calls,1);
 }
});


test('production runtime inspector blocks an active preview even for the valid resumed task',async()=>{
 const {admin,inspectRuntimeWriter}=await import('../src/supabase.js');
 const old=admin.from;let previewStatus='running';
 admin.from=table=>{
  const query={select(){return this;},eq(){return this;},maybeSingle:async()=>({data:{status:previewStatus}}),then(resolve){return Promise.resolve({data:[{...current,lease_until:new Date(Date.now()+60000).toISOString()}]}).then(resolve);}};
  assert.ok(['ita_tasks','ita_preview_recoveries'].includes(table));return query;
 };
 try{
  assert.equal((await inspectRuntimeWriter('p','u',writer,{resumingTask:task})).active,true);
  previewStatus='failed';assert.equal((await inspectRuntimeWriter('p','u',writer,{resumingTask:task})).active,false);
 }finally{admin.from=old;}
});
