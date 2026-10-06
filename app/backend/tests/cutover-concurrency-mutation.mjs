/** Additional source-mutation CAS proof; no fabricated active tasks or authority DML. */
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {connect,api,report,errorInfo} from './cutover-real-common.mjs';
import {identity,fixture,rpc,userOptions,deleteFixture} from './cutover-fixture.mjs';
import {sourceManifest} from '../../worker/src/managed-source.js';
let dbs=[];
const sqlRpc=async(db,name,args)=>{const keys=Object.keys(args);return (await db.query(`select to_jsonb(public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')})) result`,Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v))).rows[0].result;};
try {
 const user=await identity(),f=await fixture(user,'source mutation concurrent writer fixture');
 dbs=await Promise.all([connect(),connect()]);await Promise.all(dbs.map(c=>c.query('SET ROLE service_role')));
 const old={...f.scope};
 assert.equal(await rpc('ita_worker_update_task',{p_task_id:f.task.id,p_worker_id:old.p_worker_id,p_execution_id:old.p_execution_id,p_patch:{status:'failed',error:'Disposable mutation competition lifecycle'}}),true);
 await rpc('ita_retry_task',{p_task_id:f.task.id,p_kind:'resume'},userOptions(user));
 const worker='source-concurrency-'+randomUUID();const current=(await rpc('ita_claim_task',{p_worker_id:worker,p_lease_seconds:3600}))[0];assert.equal(current.id,f.task.id);
 f.scope.p_worker_id=worker;f.scope.p_execution_id=current.execution_id;
 const times=[];
 for(const [i,label] of ['retired/current source mutation acquire','two eligible operation source mutation CAS'].entries()) {
   const target=sourceManifest([{path:'src/App.jsx',content:`export default function App(){return <main>Concurrent ${i}</main>}`}]);
   const cs=await f.call('ita_workspace_prepare',{p_request_id:randomUUID(),p_origin:'agent',p_base_revision:1+i,p_changes:target.files.map(({path,content})=>({operation:'write',path,content})),p_target_hash:target.code_hash});
   const scopes=i===0?[old,f.scope]:[f.scope,f.scope];
   const t=performance.now();
   const out=await Promise.allSettled(dbs.map((db,j)=>sqlRpc(db,'ita_workspace_acquire',{...scopes[j],p_operation_id:randomUUID(),p_kind:'mutation',p_sandbox_id:'protocol-only-no-daytona',p_changeset_id:cs.id})));
   const ms=Math.round(performance.now()-t);assert.ok(ms<10000);times.push(ms);
   assert.equal(out.filter(o=>o.status==='fulfilled').length,1);
   const loser=out.find(o=>o.status==='rejected');assert.equal(loser.reason.code,'P0001');assert.match(loser.reason.message,i===0?/LEASE_LOST/:/WORKSPACE_RECONCILE_REQUIRED/);
   const winner=out.find(o=>o.status==='fulfilled').value;
   const committed=await f.call('ita_workspace_commit',{p_token:winner.token,p_changeset_id:cs.id,p_files:target.files,p_hash:target.code_hash});assert.equal(committed.revision,2+i);
   report(label,'PASS',{kind:'mutation',writers_granted:1,duration_ms:ms,resulting_revision:committed.revision});
 }
 await deleteFixture(f);assert.ok((await api('/auth/v1/admin/users/'+user.id,{method:'DELETE'})).status<400);
 report('Step 3 source-mutation supplement','PASS',{durations_ms:times,deadlocks:0,fixture_cleaned:true});
}catch(e){report('Step 3 source-mutation supplement','FAIL',errorInfo(e));process.exitCode=1;}finally{await Promise.allSettled(dbs.map(c=>c.end()));}
