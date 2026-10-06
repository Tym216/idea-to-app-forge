import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
const exec=promisify(execFile);
import {cfg,api,report,errorInfo} from './cutover-real-common.mjs';
import {identity,fixture,rpc,okApi,userOptions,deleteFixture,denied} from './cutover-fixture.mjs';
import {connectOperational,captureIngress,gateSQL,freezeIngress,verifyFrozen,unfreezeIngress} from './ops-ingress-gate.mjs';
let db,snapshot,restored=false;const userIds=[];
try {
 ({db}=await connectOperational('disposable'));const u=await identity();userIds.push(u.id);const baseline=await fixture(u,'ingress gate fixture');
 snapshot=await captureIngress(db,cfg.projectRef);assert.ok(snapshot.grants.some(g=>g.col&&g.name==='ita_tasks'));
 const dir=new URL('../../worker/.cutover/ingress-test-'+randomUUID()+'/',import.meta.url);mkdirSync(dir,{recursive:true,mode:0o700});
 writeFileSync(new URL('snapshot.json',dir),JSON.stringify(snapshot),{mode:0o600});writeFileSync(new URL('freeze.sql',dir),gateSQL(snapshot),{mode:0o600});writeFileSync(new URL('unfreeze.sql',dir),gateSQL(snapshot,true),{mode:0o600});
 await freezeIngress(db,snapshot);await verifyFrozen(db);
 await denied('/rest/v1/ita_tasks',{method:'POST',body:{project_id:baseline.projectId,user_id:u.id,mode:'build',prompt:'must not enqueue'},...userOptions(u)},'frozen user task INSERT');
 for(const [name,body] of [['ita_resume_task',{p_task_id:baseline.task.id}],['ita_retry_task',{p_task_id:baseline.task.id,p_kind:'new'}],['ita_approve_plan',{p_plan_id:baseline.plan.id,p_version:baseline.plan.version}],['ita_request_preview_recovery',{p_project_id:baseline.projectId}],['ita_request_project_delete',{p_project_id:baseline.projectId}]])
  await denied('/rest/v1/rpc/'+name,{method:'POST',body,...userOptions(u)},'frozen '+name);
 assert.equal((await okApi('/rest/v1/ita_projects?id=eq.'+baseline.projectId,userOptions(u))).length,1);
 const canaryId=randomUUID();
 // Only this trusted DB administrator can enter the canary path. Normal user roles stay closed.
 const requestFile=new URL('canary-request.txt',dir);writeFileSync(requestFile,'创建一个中文待办应用，支持添加、完成和删除。',{mode:0o600});
 const cli=fileURLToPath(new URL('ops-canary-enqueue.mjs',import.meta.url));
 const planResult=await exec(process.execPath,[cli,'--target','disposable','--mode','plan','--user',u.id,'--project',canaryId,'--prompt-file',fileURLToPath(requestFile)],{timeout:20000});
 assert.equal(JSON.parse(planResult.stdout).task_status,'queued');
 const worker='gate-canary-'+randomUUID();let task=(await rpc('ita_claim_task',{p_worker_id:worker,p_lease_seconds:3600}))[0];assert.equal(task.project_id,canaryId);
 const plan=await rpc('ita_worker_save_plan',{p_task_id:task.id,p_worker_id:worker,p_execution_id:task.execution_id,p_kind:'plan',p_content:{understanding:'Gate canary fixture',acceptance:baseline.acceptance}});
 assert.equal(await rpc('ita_worker_update_task',{p_task_id:task.id,p_worker_id:worker,p_execution_id:task.execution_id,p_patch:{status:'succeeded'}}),true);
 const approval=await exec(process.execPath,[cli,'--target','disposable','--mode','approve','--user',u.id,'--project',canaryId,'--plan',plan.id,'--version',String(plan.version)],{timeout:20000});
 assert.equal(JSON.parse(approval.stdout).task_status,'queued');await verifyFrozen(db);
 task=(await rpc('ita_claim_task',{p_worker_id:worker,p_lease_seconds:3600}))[0];assert.equal(task.mode,'build');assert.equal(task.project_id,canaryId);
 assert.equal(await rpc('ita_worker_update_task',{p_task_id:task.id,p_worker_id:worker,p_execution_id:task.execution_id,p_patch:{status:'failed',error:'Gate canary fixture cleanup; no build was executed'}}),true);
 report('ingress frozen / canary-only','PASS',{column_grants_revoked:true,client_mutation_denied:true,read_only_client_preserved:true,trusted_plan_approve_build_enqueued:true,global_client_execute_still_closed:true});
 await unfreezeIngress(db,snapshot);restored=true;
 assert.deepEqual((await captureIngress(db,cfg.projectRef)).grants,snapshot.grants);
 const normal=await api('/rest/v1/ita_tasks',{method:'POST',body:{project_id:canaryId,user_id:u.id,mode:'build',prompt:'restored client ingress'},...userOptions(u)});assert.equal(normal.status,201);
 const queued=await okApi('/rest/v1/ita_tasks?project_id=eq.'+canaryId+'&status=eq.queued',userOptions(u));assert.equal(queued.length,1);
 await rpc('ita_cancel_task',{p_task_id:queued[0].id},userOptions(u));
 await deleteFixture(baseline);await deleteFixture({projectId:canaryId,user:u});assert.ok((await api('/auth/v1/admin/users/'+u.id,{method:'DELETE'})).status<400);
 report('ingress exact unfreeze','PASS',{acl_restored_exactly:true,normal_authenticated_task_insert:true,fixtures_cleaned:true});
}catch(e){report('ingress gate validation','FAIL',errorInfo(e));process.exitCode=1;}
finally{if(db&&snapshot&&!restored)await unfreezeIngress(db,snapshot).catch(()=>{});if(db)await db.end();}
