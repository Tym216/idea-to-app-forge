import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cfg,api,report,errorInfo} from './cutover-real-common.mjs';
import {identity,rpc,okApi,userOptions} from './cutover-fixture.mjs';
// Even accidental Worker helper clients are pointed at disposable, before env.js is imported.
process.env.SUPABASE_URL=cfg.apiUrl;process.env.SUPABASE_SERVICE_ROLE_KEY=cfg.serviceKey;process.env.LANGFUSE_ENABLED='false';
await import('../../worker/src/env.js');
const {DaytonaProvider}=await import('../../worker/src/sandbox/daytona.js');
const {Workspace}=await import('../../worker/src/workspace.js');
const {SCAFFOLD_FILES}=await import('../../worker/src/scaffold.js');
const {renderDesignTokensCss,DESIGN_TOKENS_PATH}=await import('../../worker/src/design.js');
const {INSTALL_CMD,DEV_CMD,buildRuntimeBasis}=await import('../../worker/src/agent.js');
const {buildFingerprint,verifyFingerprint,sha256}=await import('../../worker/src/managed-source.js');
const {validateRuntimeScript}=await import('../../worker/src/workspace-policy.js');
const {runVerification,classifyResult,RUNNER_SOURCE,PLAYWRIGHT_VERSION}=await import('../../worker/src/verify.js');
let user,projectId,task,scope,plan,sandbox,sandboxId,ws,stage='setup';let buildCount=0,verifyCount=0;let completed=false;
const acceptance=[
 {id:'A1',action:'添加、完成、删除待办',expect:'条目添加后可完成并删除',external:false,severity:'core',steps:[
  {op:'fill',selector:'[data-testid=task-input]',value:'验证任务'},{op:'click',selector:'[data-testid=add]'},
  {op:'expectText',selector:'[data-testid=list]',contains:'验证任务'}, {op:'click',selector:'[data-testid=toggle]'},
  {op:'expectTrue',js:"document.querySelector('[data-testid=item]').getAttribute('data-done') === 'true'"},
  {op:'click',selector:'[data-testid=delete]'},{op:'expectCount',selector:'[data-testid=item]',equals:0}]},
 {id:'A2',action:'查看说明',expect:'展示版本已审核说明',external:false,severity:'detail',steps:[{op:'expectText',selector:'[data-testid=note]',contains:'版本已审核'}]},
];
const app=(broken)=>`import {useState} from 'react';
import {Check,Trash2} from 'lucide-react';
export default function App(){const [input,setInput]=useState('');const [items,setItems]=useState([]);
function add(){${broken?'return;':"if(input.trim()){setItems(v=>[...v,{id:Date.now(),text:input,done:false}]);setInput('');}"}}
return <main style={{maxWidth:600,margin:'32px auto',padding:24,fontFamily:'system-ui'}}><h1>待办 Todo</h1>
<input data-testid="task-input" aria-label="任务" value={input} onChange={e=>setInput(e.target.value)}/><button data-testid="add" onClick={add}>添加</button>
<ul data-testid="list">{items.map(x=><li key={x.id} data-testid="item" data-done={String(x.done)}>{x.text}
<button data-testid="toggle" aria-label="完成" onClick={()=>setItems(v=>v.map(y=>y.id===x.id?{...y,done:!y.done}:y))}><Check size={16}/></button>
<button data-testid="delete" aria-label="删除" onClick={()=>setItems(v=>v.filter(y=>y.id!==x.id))}><Trash2 size={16}/></button></li>)}</ul>
<p data-testid="note">演示版本</p></main>}`;
const call=(name,extra={})=>rpc(name,{...scope,...extra});
async function start(){
  validateRuntimeScript(ws.manifest,'dev');
  await ws.runtime('start',async()=>{
    await sandbox.startBackground(sandboxId,DEV_CMD);
    const r=await sandbox.exec(sandboxId,"for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20; do if curl -fsS http://127.0.0.1:5173/ >/dev/null; then echo READY; exit 0; fi; sleep 1; done; exit 1",{timeoutMs:60000});
    assert.equal(r.exitCode,0,'Vite dev server not ready');return r;
  });
}
async function build(basis){
  validateRuntimeScript(ws.manifest,'build');
  const r=await ws.runtime('build',()=>sandbox.exec(sandboxId,'npm run --ignore-scripts build',{timeoutMs:180000}));
  if(r.exitCode!==0) throw Object.assign(new Error('supported Vite build failed: '+String(r.stdout||r.stderr).slice(-1200)),{code:'VITE_BUILD_FAILED'});buildCount++;await ws.evidence('build',basis,'passed',{exitCode:r.exitCode,real_daytona:true});
}
async function verify(basis){
  report('browser execution','RUNNING',{sandbox_id:sandboxId,revision:ws.state.revision});
  const raw=await ws.runtime('verify',()=>runVerification({sandbox,sandboxId,checks:acceptance.map(({id,steps})=>({id,steps}))}));
  const result=classifyResult(raw,acceptance);verifyCount++;
  if(result.kind==='tool_error')throw Object.assign(new Error(result.toolError),{code:'VERIFY_TOOL_ERROR'});
  await ws.evidence('verify',basis,result.kind,result);
  report('browser conclusion','PASS',{kind:result.kind,items:result.items.map(i=>({id:i.id,status:i.status})),screenshots:raw.screenshots?.length||0});return result;
}
try {
  user=await identity();projectId=randomUUID();
  await okApi('/rest/v1/ita_projects',{method:'POST',body:{id:projectId,user_id:user.id,name:'Fresh Daytona cutover fixture'},...userOptions(user)});
  await okApi('/rest/v1/ita_tasks',{method:'POST',body:{project_id:projectId,user_id:user.id,mode:'build',prompt:'Disposable Vite Todo fixture'},...userOptions(user)});
  const worker='cutover-daytona-'+randomUUID();task=(await rpc('ita_claim_task',{p_worker_id:worker,p_lease_seconds:3600}))[0];assert.equal(task.project_id,projectId);
  scope={p_project_id:projectId,p_task_id:task.id,p_worker_id:worker,p_execution_id:task.execution_id};
  plan=await rpc('ita_worker_save_plan',{p_task_id:task.id,p_worker_id:worker,p_execution_id:task.execution_id,p_kind:'action',p_content:{understanding:'Todo fixture with pinned core/detail checks',acceptance}});
  assert.equal(await rpc('ita_worker_update_task',{p_task_id:task.id,p_worker_id:worker,p_execution_id:task.execution_id,p_patch:{plan_id:plan.id,plan_version:plan.version}}),true);
  stage='fresh_sandbox';sandbox=new DaytonaProvider();({sandboxId}=await sandbox.create({projectId,userId:user.id}));
  await okApi('/rest/v1/ita_projects?id=eq.'+projectId,{method:'PATCH',body:{sandbox_id:sandboxId}});
  const rpcAdapter=async(name,args)=>{const r=await api('/rest/v1/rpc/'+name,{method:'POST',body:args});return {data:r.status<400?r.data:null,error:r.status>=400?{message:r.data?.message||'API failed'}:null};};
  const makeWorkspace=()=>new Workspace({rpc:rpcAdapter,projectId,taskId:task.id,workerId:scope.p_worker_id,executionId:scope.p_execution_id,sandbox,sandboxId});
  ws=makeWorkspace();stage='materialize';await ws.initialize({newSandbox:true});assert.equal(ws.state.revision,0);
  report('fresh materialize','PASS',{revision:0,sandbox_id:sandboxId});
  const pkg=JSON.parse(SCAFFOLD_FILES['package.json']);pkg.dependencies['lucide-react']='0.468.0';
  const design={colors:{background:'#ffffff',surface:'#f1f5f9',text:'#111827',textMuted:'#475569',primary:'#2563eb',onPrimary:'#ffffff',border:'#cbd5e1',danger:'#b91c1c',success:'#15803d'},
    typography:{fontFamily:'system-ui',scale:{h1:'28px',h2:'18px',body:'16px',small:'13px'}},spacing:[4,8,12,16,24,32],breakpoints:{mobile:640,desktop:1024}};
  const files={...SCAFFOLD_FILES,'package.json':JSON.stringify(pkg,null,2),'src/App.tsx':app(true),[DESIGN_TOKENS_PATH]:renderDesignTokensCss(design)};
  stage='managed_source_mutation';await ws.apply(Object.entries(files).map(([path,content])=>({operation:'write',path,content})),{origin:'scaffold'});assert.equal(ws.state.revision,1);
  stage='controlled_install';report(stage,'RUNNING',{third_party_dependency:'lucide-react',ignore_scripts:true});
  const install=await ws.runtime('install',()=>sandbox.exec(sandboxId,INSTALL_CMD,{timeoutMs:240000}),{adoptLockfile:true});assert.equal(install.exitCode,0);
  assert.equal(ws.state.revision,2);assert.ok(ws.manifest.files.some(f=>f.path==='package-lock.json'));
  report(stage,'PASS',{revision:2,lockfile_changeset_committed:true});
  const b=buildFingerprint(await buildRuntimeBasis(sandbox,sandboxId));
  const v=verifyFingerprint(acceptance,{runnerHash:sha256(RUNNER_SOURCE),playwrightVersion:PLAYWRIGHT_VERSION,buildBasis:b});
  const completion=()=>({p_key:task.id+':checkpoint',p_revision:ws.state.revision,p_hash:ws.manifest.code_hash,p_build_basis:b,p_verify_basis:v,p_basis_id:plan.id,p_summary:'Real Daytona fixture: core verified; detail warning remains',p_preview_url:null});
  stage='negative_core_fixture';await build(b);await start();const negative=await verify(v);assert.equal(negative.kind,'blocker');
  const blocked=await api('/rest/v1/rpc/ita_complete_build_checkpoint',{method:'POST',body:{...scope,...completion()}});assert.equal(blocked.data?.code,'P0001');assert.match(blocked.data?.message||'',/CHECKPOINT_VERIFY_STALE/);
  const snapshots=await okApi('/rest/v1/ita_snapshots?project_id=eq.'+projectId+'&select=id');assert.equal(snapshots.length,0);report('real core blocker prohibits checkpoint','PASS',{checkpoint_count:0});
  stage='functional_fixture';await ws.apply([{operation:'write',path:'src/App.tsx',content:app(false)}]);assert.equal(ws.state.revision,3);assert.equal(ws.state.build,null);assert.equal(ws.state.verify,null);
  await build(b);await start();const positive=await verify(v);assert.equal(positive.kind,'success_with_warnings');
  const oldBuild=JSON.stringify(ws.state.build),oldVerify=JSON.stringify(ws.state.verify),oldExecution=scope.p_execution_id;
  stage='new_execution_runtime_recovery';
  assert.equal(await rpc('ita_worker_update_task',{p_task_id:task.id,p_worker_id:scope.p_worker_id,p_execution_id:oldExecution,p_patch:{status:'failed',error:'Disposable recovery evidence-reuse test'}}),true);
  await rpc('ita_retry_task',{p_task_id:task.id,p_kind:'resume'},userOptions(user));
  const next=(await rpc('ita_claim_task',{p_worker_id:scope.p_worker_id,p_lease_seconds:3600}))[0];assert.equal(next.id,task.id);assert.notEqual(next.execution_id,oldExecution);scope.p_execution_id=next.execution_id;
  sandbox=new DaytonaProvider();await sandbox.ensure(sandboxId,{projectId,userId:user.id,allowRecreate:false});ws=makeWorkspace();await ws.initialize();assert.equal(ws.state.revision,3);
  const renewedBuild=buildFingerprint(await buildRuntimeBasis(sandbox,sandboxId));assert.equal(renewedBuild,b);assert.equal(ws.valid('build',b),true);assert.equal(ws.valid('verify',v),true);
  await start();assert.equal(JSON.stringify(ws.state.build),oldBuild);assert.equal(JSON.stringify(ws.state.verify),oldVerify);
  report('cross-execution evidence reuse','PASS',{revision:3,execution_changed:true,new_builds:0,new_verifies:0});
  stage='real_checkpoint';await ws.runtime('checkpoint',async()=>({}));
  const done=await call('ita_complete_build_checkpoint',completion());assert.equal((await call('ita_complete_build_checkpoint',completion())).snapshot_id,done.snapshot_id);completed=true;
  const checkpoint=(await okApi('/rest/v1/ita_snapshots?id=eq.'+done.snapshot_id))[0];assert.equal(checkpoint.workspace_revision,3);assert.equal(checkpoint.code_hash,ws.manifest.code_hash);assert.equal(checkpoint.build_evidence.basis_fingerprint,b);assert.equal(checkpoint.verify_evidence.basis_fingerprint,v);assert.equal(checkpoint.verify_evidence.status,'success_with_warnings');
  const state=(await okApi('/rest/v1/ita_tasks?id=eq.'+task.id+'&select=phase'))[0];assert.equal(state.phase,'done_with_warnings');
  report('Step 4','PASS',{sandbox_id:sandboxId,checkpoint_id:done.snapshot_id,revision:3,builds:buildCount,real_browser_runs:verifyCount,dependency:'lucide-react',checkpoint_status:'done_with_warnings',source:'prewritten fixture, no model generation',runtime_evidence_reused:true});
  stage='cleanup';assert.equal(await rpc('ita_request_project_delete',{p_project_id:projectId,p_request_id:randomUUID()},userOptions(user)),'deleting');
  const deletionWorker='cutover-cleanup-'+randomUUID();const job=(await rpc('ita_claim_project_deletion',{p_worker_id:deletionWorker,p_lease_seconds:300}))[0];assert.equal(job.project_id,projectId);assert.equal(job.sandbox_id,sandboxId);
  await sandbox.destroy(sandboxId);assert.equal(await rpc('ita_complete_project_deletion',{p_project_id:projectId,p_worker_id:deletionWorker,p_attempts:job.attempts,p_ok:true,p_error:null,p_request_id:randomUUID()}),'deleted');
  assert.ok((await api('/auth/v1/admin/users/'+user.id,{method:'DELETE'})).status<400);report('fresh resource cleanup','PASS',{sandbox_deleted:true,disposable_project_data_deleted:true});
}catch(e){report('Step 4','FAIL',{stage,checkpoint_created:completed,...errorInfo(e)});process.exitCode=1;}
