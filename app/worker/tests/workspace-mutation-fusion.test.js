import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Workspace} from '../src/workspace.js';
import {sourceManifest,applySourceChanges,sourceDiff,sourceError} from '../src/managed-source.js';
function fixture({drift=false,promoteError=null}={}){
 const base=sourceManifest([{path:'src/a.ts',content:'A'}]);
 const target=applySourceChanges(base,[{operation:'write',path:'src/a.ts',content:'B'}]);
 const modes=[],blocks=[];let commits=0,finished=0,reads=0;
 const w=new Workspace({taskId:'task'});
 w.read=async()=>{reads++;w.state={revision:1,state:'confirmed',writer:null};w.manifest=base;};
 w.acquire=async()=>({token:'writer',epoch:1});
 w.prepare=async()=>({id:'change'});
 w.commit=async(_writer,_change,manifest)=>{assert.equal(manifest.code_hash,target.code_hash);commits++;return {changed:true,revision:2};};
 w.block=async(_writer,error,state)=>blocks.push({code:error.code,state});
 w.call=async name=>{assert.equal(name,'ita_workspace_finish_operation');finished++;};
 w.gateway={scan:async()=>{throw Error('pre-scan must be fused');},run:async(mode,_writer,values)=>{
  modes.push(mode);
  if(mode==='activate_scan')return{activated:true,manifest:drift?target:base};
  if(mode==='promote'){if(promoteError)throw promoteError;assert.equal(values.target_hash,target.code_hash);return{manifest:target};}
  if(mode==='materialize')return{manifest:base};
  throw Error('unexpected gateway '+mode);
 }};
 const change={id:'change',actor:'user',origin:'user_apply',task_id:'task',status:'prepared',base_revision:1,base_hash:base.code_hash,target_hash:target.code_hash,changes:sourceDiff(base,target)};
 return{w,base,target,change,counts:()=>({modes,blocks,commits,finished,reads})};
}
test('confirmed materialization fuses pre-scan and does not rewrite identical source',async()=>{
 const f=fixture();await f.w.initialize();assert.deepEqual(f.counts().modes,['activate_scan']);assert.equal(f.counts().finished,1);assert.equal(f.counts().commits,0);
});
test('materialization never overwrites drift in an existing sandbox',async()=>{
 const f=fixture({drift:true});await assert.rejects(f.w.initialize(),{code:'WORKSPACE_CONFLICT'});
 assert.deepEqual(f.counts().modes,['activate_scan']);assert.equal(f.counts().finished,0);assert.deepEqual(f.counts().blocks,[{code:'WORKSPACE_CONFLICT',state:'conflict'}]);
});
test('fresh sandbox still materializes the complete canonical target after fused activation',async()=>{
 const f=fixture();await f.w.initialize({newSandbox:true});assert.deepEqual(f.counts().modes,['activate_scan','materialize']);assert.equal(f.counts().finished,1);
});
for(const method of ['agent','user_apply']){
 const apply=f=>method==='agent'?f.w.apply([{operation:'write',path:'src/a.ts',content:'B'}],{baseRevision:1}):f.w.applyRequested(f.change);
 test(method+' preserves promote and commit after one fenced complete pre-scan',async()=>{
  const f=fixture();await apply(f);assert.deepEqual(f.counts().modes,['activate_scan','promote']);assert.equal(f.counts().commits,1);
 });
 test(method+' pre-write drift blocks promotion/commit and retains conflict fencing',async()=>{
  const f=fixture({drift:true});await assert.rejects(apply(f),{code:'WORKSPACE_CONFLICT'});
  assert.deepEqual(f.counts().modes,['activate_scan']);assert.equal(f.counts().commits,0);assert.equal(f.counts().blocks[0].state,'conflict');
 });
 for(const code of ['WORKSPACE_PARTIAL','WORKSPACE_UNCERTAIN','WORKSPACE_CONFLICT']){
  test(method+' '+code+' is never committed or marked successful by fusion',async()=>{
   const f=fixture({promoteError:sourceError(code,'physical result not confirmed')});await assert.rejects(apply(f),{code});
   assert.equal(f.counts().commits,0);assert.equal(f.counts().finished,0);
   assert.equal(f.counts().blocks[0].state,code==='WORKSPACE_PARTIAL'?'partial':code==='WORKSPACE_CONFLICT'?'conflict':'uncertain');
  });
 }
}
test('committed User Apply resume cannot re-enter promotion',async()=>{
 const f=fixture();f.change.status='committed';f.change.resulting_revision=2;
 assert.deepEqual(await f.w.applyRequested(f.change),{revision:2,reused:true});assert.deepEqual(f.counts().modes,[]);assert.equal(f.counts().commits,0);
});
