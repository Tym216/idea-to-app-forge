import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {cfg,connect,api,report,errorInfo} from './cutover-real-common.mjs';
import {identity,fixture,rpc,userOptions,deleteFixture} from './cutover-fixture.mjs';
import {sourceManifest,sha256} from '../../worker/src/managed-source.js';
let dbs=[],f,user,stage='setup';const timings=[];
async function dbRpc(db,name,args){
  const keys=Object.keys(args);const sql=`select to_jsonb(public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')})) result`;
  const values=Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);
  return (await db.query(sql,values)).rows[0].result;
}
async function race(label,operations){
  const t=performance.now();const outcomes=await Promise.allSettled(operations.map(fn=>fn()));
  const ms=Math.round(performance.now()-t);timings.push({label,ms});assert.ok(ms<10000,label+' exceeded concurrency deadline');
  report(label,'PASS',{duration_ms:ms,outcomes:outcomes.map(r=>r.status==='fulfilled'?'granted':r.reason.code)});
  return outcomes;
}
const expectGuard=async(fn,pattern)=>{let denied=false;try{await fn();}catch(e){assert.equal(e.code,'P0001');assert.match(e.message,pattern);denied=true;}assert.equal(denied,true);};
async function rotateExecution(){
  assert.equal(await rpc('ita_worker_update_task',{p_task_id:f.task.id,p_worker_id:f.scope.p_worker_id,p_execution_id:f.scope.p_execution_id,p_patch:{status:'failed',error:'Disposable concurrency lifecycle rotation'}}),true);
  await rpc('ita_retry_task',{p_task_id:f.task.id,p_kind:'resume'},userOptions(user));
  const worker='cutover-concurrency-'+randomUUID();const next=(await rpc('ita_claim_task',{p_worker_id:worker,p_lease_seconds:3600}))[0];
  assert.equal(next.id,f.task.id);assert.notEqual(next.execution_id,f.scope.p_execution_id);
  f.scope.p_worker_id=worker;f.scope.p_execution_id=next.execution_id;
}
try {
  user=await identity();f=await fixture(user,'PostgreSQL concurrency protocol fixture');
  dbs=await Promise.all([connect(),connect()]);
  await Promise.all(dbs.map(db=>db.query('SET ROLE service_role')));
  const ids=await Promise.all(dbs.map(db=>db.query('select pg_backend_pid() pid')));assert.notEqual(ids[0].rows[0].pid,ids[1].rows[0].pid);
  report('dual PostgreSQL backends','PASS',{backend_pids:ids.map(r=>r.rows[0].pid)});
  const acquire=(scope)=>({...scope,p_operation_id:randomUUID(),p_kind:'build',p_sandbox_id:'protocol-only-no-daytona',p_changeset_id:null});
  stage='retired_vs_current_execution';const oldScope={...f.scope};await rotateExecution();
  const admissions=await race(stage,[()=>dbRpc(dbs[0],'ita_workspace_acquire',acquire(oldScope)),()=>dbRpc(dbs[1],'ita_workspace_acquire',acquire(f.scope))]);
  assert.equal(admissions[0].status,'rejected');assert.match(admissions[0].reason.message,/LEASE_LOST/);assert.equal(admissions[1].status,'fulfilled');
  await f.call('ita_workspace_finish_operation',{p_token:admissions[1].value.token,p_hash:f.source.code_hash});
  stage='valid_operation_writer_CAS';
  const grants=await race(stage,dbs.map(db=>()=>dbRpc(db,'ita_workspace_acquire',acquire(f.scope))));
  assert.equal(grants.filter(r=>r.status==='fulfilled').length,1);assert.match(grants.find(r=>r.status==='rejected').reason.message,/WORKSPACE_RECONCILE_REQUIRED/);
  await f.call('ita_workspace_finish_operation',{p_token:grants.find(r=>r.status==='fulfilled').value.token,p_hash:f.source.code_hash});
  stage='partial_fence';
  const target=sourceManifest([{path:'src/App.jsx',content:'export default function App(){return <main>Updated Todo</main>}'}]);
  const cs=await f.call('ita_workspace_prepare',{p_request_id:randomUUID(),p_origin:'agent',p_base_revision:1,p_changes:target.files.map(f=>({operation:'write',path:f.path,content:f.content})),p_target_hash:target.code_hash});
  const writer=await f.call('ita_workspace_acquire',{p_operation_id:randomUUID(),p_kind:'mutation',p_sandbox_id:'protocol-only-no-daytona',p_changeset_id:cs.id});
  await f.call('ita_workspace_result',{p_token:writer.token,p_state:'partial',p_result:{protocol_fixture:true}});
  await expectGuard(()=>dbRpc(dbs[0],'ita_workspace_acquire',acquire(f.scope)),/WORKSPACE_RECONCILE_REQUIRED/);
  await f.call('ita_workspace_result',{p_token:writer.token,p_state:'uncertain',p_result:{protocol_fixture:true}});
  await rotateExecution();
  await expectGuard(()=>dbRpc(dbs[0],'ita_workspace_acquire',acquire(f.scope)),/WORKSPACE_RECONCILE_REQUIRED/);
  stage='reconcile_vs_normal_writer';
  const takeover=await race(stage,[()=>dbRpc(dbs[0],'ita_workspace_reconcile',{...f.scope,p_old_token:writer.token,p_quiesced:true,p_hash:f.source.code_hash,p_files:f.source.files}),()=>dbRpc(dbs[1],'ita_workspace_acquire',acquire(f.scope))]);
  assert.equal(takeover[0].status,'fulfilled');assert.equal(takeover[1].status,'rejected');assert.match(takeover[1].reason.message,/WORKSPACE_RECONCILE_REQUIRED/);
  const resumed=takeover[0].value.writer;assert.notEqual(resumed.token,writer.token);
  await expectGuard(()=>dbRpc(dbs[1],'ita_workspace_commit',{...f.scope,p_token:writer.token,p_changeset_id:cs.id,p_files:target.files,p_hash:target.code_hash}),/WORKSPACE_FENCE_LOST/);
  const committed=await dbRpc(dbs[0],'ita_workspace_commit',{...f.scope,p_token:resumed.token,p_changeset_id:cs.id,p_files:target.files,p_hash:target.code_hash});assert.equal(committed.revision,2);
  stage='concurrent_completion';
  const b=sha256('concurrent protocol build'),v=sha256('concurrent protocol verify');
  for(const kind of ['build','verify'])await f.call('ita_workspace_evidence',{p_kind:kind,p_evidence:{workspace_revision:2,code_hash:target.code_hash,basis_fingerprint:kind==='build'?b:v,status:kind==='build'?'passed':'inconclusive',provenance:{protocol_smoke_only:true}}});
  const request={...f.scope,...f.completion,p_revision:2,p_hash:target.code_hash,p_build_basis:b,p_verify_basis:v};
  const complete=await race(stage,dbs.map(db=>()=>dbRpc(db,'ita_complete_build_checkpoint',request)));
  assert.ok(complete.every(r=>r.status==='fulfilled'));assert.equal(complete[0].value.snapshot_id,complete[1].value.snapshot_id);
  const counts=await dbs[0].query("select (select count(*) from public.ita_snapshots where project_id=$1)::int checkpoints,(select count(*) from public.ita_messages where project_id=$1 and meta ? 'checkpointId')::int completion_facts",[f.projectId]);assert.deepEqual(counts.rows[0],{checkpoints:1,completion_facts:1});
  await deleteFixture(f);assert.ok((await api('/auth/v1/admin/users/'+user.id,{method:'DELETE'})).status<400);
  report('Step 3','PASS',{lock_timeout_ms:5000,deadlocks:0,checkpoint_count:1,completion_fact_count:1,timings,
    execution_test:'real lifecycle retired/current executions; same-project active task uniqueness preserved',source_scope:'protocol-only manifests; no sandbox side effects claimed'});
}catch(e){report('Step 3','FAIL',{stage,...errorInfo(e),lock_sequences:['acquire: project -> execution task -> changeset','reconcile: project -> execution task -> changeset','completion: project -> execution task/basis -> snapshot/message'],sql_path:stage});process.exitCode=1;}
finally{await Promise.allSettled(dbs.map(db=>db.end()));}
