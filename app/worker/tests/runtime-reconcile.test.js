import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Workspace} from '../src/workspace.js';
import {sourceManifest} from '../src/managed-source.js';
function fixture(status={terminal:true,active:false,leaseActive:false},actual=null){
 const manifest=sourceManifest([{path:'src/a.ts',content:'A'}]);
 const state={revision:6,state:'uncertain',code_hash:manifest.code_hash,files:manifest.files,pending:[],
 writer:{token:'old-token',epoch:3,kind:'preview',result:{error:'transport failure'}}};
 let stopped=0,retired=0,cleared=0;
 const w=new Workspace({projectId:'p',workerId:'w',executionId:'new',sandboxId:'s',rpc:async(name,args)=>{
  if(name==='ita_workspace_read')return {data:structuredClone(state)};
  assert.equal(name,'ita_workspace_reconcile');assert.equal(args.p_old_token,'old-token');assert.equal(args.p_quiesced,true);
  assert.equal(args.p_hash,manifest.code_hash);cleared++;state.writer=null;state.state='confirmed';return {data:{state:'not_applied'}};
 }});
 w.gateway.run=async mode=>{assert.equal(mode,'retire');retired++;return {manifest:actual||manifest};};
 const run=()=>w.reconcileRuntime({inspect:async()=>status,quiesce:async()=>{stopped++;return {stopped:true};}});
 return {run,state,counts:()=>({stopped,retired,cleared})};
}
test('terminal runtime reconciliation requires stopped executor AND exact manifest, preserves revision/evidence',async()=>{
 const f=fixture();await f.run();assert.deepEqual(f.counts(),{stopped:1,retired:1,cleared:1});assert.equal(f.state.revision,6);assert.equal(f.state.writer,null);
});
test('active, nonterminal or leased execution never triggers stop/retire/clear',async()=>{
 for(const status of [{terminal:false},{terminal:true,active:true},{terminal:true,leaseActive:true}]){
  const f=fixture(status);await assert.rejects(f.run(),{code:'WORKSPACE_UNCERTAIN'});assert.deepEqual(f.counts(),{stopped:0,retired:0,cleared:0});
 }
});
test('quiesced but unknown source stays blocked; no automatic overwrite or database clear',async()=>{
 const f=fixture(undefined,sourceManifest([{path:'src/a.ts',content:'drift'}]));
 await assert.rejects(f.run(),{code:'WORKSPACE_CONFLICT'});assert.equal(f.counts().cleared,0);assert.ok(f.state.writer);
});

test('a resumed/active execution during quiescence prevents final clear',async()=>{
 const f=fixture();let inspections=0;
 // Exercise the production method with activity changing between the two checks.
 const manifest=sourceManifest([{path:'a.ts',content:'A'}]);let clears=0;
 const state={revision:1,state:'uncertain',code_hash:manifest.code_hash,files:manifest.files,writer:{kind:'preview',token:'t'},pending:[]};
 const ws=new Workspace({rpc:async name=>name==='ita_workspace_read'?{data:state}:(clears++,{data:{}}),projectId:'p',executionId:'e'});
 ws.gateway.run=async()=>{throw Error('must not retire after renewed activity');};
 await assert.rejects(ws.reconcileRuntime({inspect:async()=>({terminal:true,active:++inspections>1}),quiesce:async()=>({stopped:true})}),{code:'WORKSPACE_UNCERTAIN'});
 assert.equal(clears,0);assert.ok(f.state.writer);
});
