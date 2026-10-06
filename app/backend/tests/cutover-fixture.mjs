import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';
import {api,cfg,report} from './cutover-real-common.mjs';
import {sourceManifest,sha256} from '../../worker/src/managed-source.js';
export async function okApi(path,options={}) {const r=await api(path,options);if(r.status>=400)throw Object.assign(new Error(r.data?.message||r.data?.msg||'API failed'),{code:r.data?.code||'HTTP_'+r.status});return r.data;}
export async function rpc(name,args,options={}) {return okApi('/rest/v1/rpc/'+name,{method:'POST',body:args,...options});}
export async function identity() {
  const email='forge-cutover-'+randomUUID()+'@example.test',password=randomBytes(24).toString('hex')+'Aa1!';
  const user=await okApi('/auth/v1/admin/users',{method:'POST',body:{email,password,email_confirm:true}});
  const login=await okApi('/auth/v1/token?grant_type=password',{method:'POST',key:cfg.anonKey,body:{email,password}});
  assert.equal(login.user.id,user.id);assert.ok(login.access_token);
  return {id:user.id,token:login.access_token};
}
export const userOptions=u=>({key:cfg.anonKey,token:u.token});
export async function fixture(user,label='protocol fixture') {
  const projectId=randomUUID();
  await okApi('/rest/v1/ita_projects',{method:'POST',body:{id:projectId,user_id:user.id,name:label},...userOptions(user)});
  await okApi('/rest/v1/ita_tasks',{method:'POST',body:{project_id:projectId,user_id:user.id,mode:'build',prompt:label},...userOptions(user)});
  const workerId='cutover-'+randomUUID();
  const task=(await rpc('ita_claim_task',{p_worker_id:workerId,p_lease_seconds:3600}))[0];assert.equal(task.project_id,projectId);
  const scope={p_project_id:projectId,p_task_id:task.id,p_worker_id:workerId,p_execution_id:task.execution_id};
  const call=(name,extra={})=>rpc(name,{...scope,...extra});
  const acceptance=[{id:'A1',action:'查看核心内容',expect:'可见 Todo',external:false,severity:'core',steps:[{op:'expectText',selector:'main',contains:'Todo'}]}];
  const plan=await rpc('ita_worker_save_plan',{p_task_id:task.id,p_worker_id:workerId,p_execution_id:task.execution_id,p_kind:'action',p_content:{understanding:label,acceptance}});
  assert.equal(await rpc('ita_worker_update_task',{p_task_id:task.id,p_worker_id:workerId,p_execution_id:task.execution_id,p_patch:{plan_id:plan.id,plan_version:plan.version}}),true);
  const empty=sourceManifest([]);
  const writer=await call('ita_workspace_acquire',{p_operation_id:randomUUID(),p_kind:'materialize',p_sandbox_id:'protocol-only-no-daytona',p_changeset_id:null});
  await call('ita_workspace_finish_operation',{p_token:writer.token,p_hash:empty.code_hash});
  const files=[{path:'src/App.jsx',content:'export default function App(){return <main>Todo</main>}'}];const source=sourceManifest(files);
  const cs=await call('ita_workspace_prepare',{p_request_id:randomUUID(),p_origin:'agent',p_base_revision:0,p_changes:files.map(f=>({...f,operation:'write'})),p_target_hash:source.code_hash});
  const mutation=await call('ita_workspace_acquire',{p_operation_id:randomUUID(),p_kind:'mutation',p_sandbox_id:'protocol-only-no-daytona',p_changeset_id:cs.id});
  const committed=await call('ita_workspace_commit',{p_token:mutation.token,p_changeset_id:cs.id,p_files:files,p_hash:source.code_hash});assert.equal(committed.revision,1);
  const buildBasis=sha256('protocol-smoke-build'),verifyBasis=sha256('protocol-smoke-verify');
  async function evidence(kind,status) {
    assert.equal(await call('ita_workspace_evidence',{p_kind:kind,p_evidence:{workspace_revision:committed.revision,code_hash:source.code_hash,basis_fingerprint:kind==='build'?buildBasis:verifyBasis,status,provenance:{protocol_smoke_only:true}}}),true);
  }
  const completion={p_key:task.id+':checkpoint',p_revision:1,p_hash:source.code_hash,p_build_basis:buildBasis,p_verify_basis:verifyBasis,p_basis_id:plan.id,p_summary:'Disposable protocol fixture; no real browser evidence',p_preview_url:null};
  return {projectId,task,plan,scope,call,user,source,cs,committed,evidence,completion,acceptance,workerId};
}
export async function deleteFixture(f) {
  assert.equal(await rpc('ita_request_project_delete',{p_project_id:f.projectId,p_request_id:randomUUID()},userOptions(f.user)),'deleting');
  const worker='cutover-delete-'+randomUUID();const job=(await rpc('ita_claim_project_deletion',{p_worker_id:worker,p_lease_seconds:300}))[0];
  assert.equal(job.project_id,f.projectId);assert.equal(job.sandbox_id,null);
  assert.equal(await rpc('ita_complete_project_deletion',{p_project_id:f.projectId,p_worker_id:worker,p_attempts:job.attempts,p_ok:true,p_error:null,p_request_id:randomUUID()}),'deleted');
}
export async function denied(path,options,label,expected='42501') {
  const r=await api(path,options);assert.ok(r.status>=400,label+' unexpectedly succeeded');assert.equal(r.data?.code,expected,label);
  const cause=/permission denied/i.test(r.data?.message||'')?'privilege':/row-level security/i.test(r.data?.message||'')?'RLS':/CHECKPOINT|IMMUTABLE|LEASE_LOST|IDEMPOTENCY|RECONCILE|FENCE/.test(r.data?.message||'')?'protocol_guard':'ownership_guard';
  report(label,'PASS',{denial:cause,http_status:r.status,sqlstate:r.data.code});return r;
}
