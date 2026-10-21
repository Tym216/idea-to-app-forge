import {test} from 'node:test';
import assert from 'node:assert/strict';
import {Workspace} from '../src/workspace.js';
import {sourceManifest} from '../src/managed-source.js';
function fixture({beforeDrift=false,afterDrift=false}={}){
 const base=sourceManifest([{path:'src/a.ts',content:'A'}]),drift=sourceManifest([{path:'src/a.ts',content:'B'}]);let ran=0,finished=0;const modes=[];
 const w=new Workspace({});w.state={revision:1};w.read=async()=>{w.manifest=base;};w.acquire=async()=>({token:'t'});w.block=async()=>{};
 w.call=async name=>{assert.equal(name,'ita_workspace_finish_operation');finished++;};
 w.gateway={run:async mode=>{modes.push(mode);assert.equal(mode,'activate_scan');return {manifest:beforeDrift?drift:base};},scan:async()=>{modes.push('scan_after');return afterDrift?drift:base;}};
 return {run:()=>w.runtime('build',async()=>{ran++;return {exitCode:0};}),counts:()=>({ran,finished,modes})};
}
test('runtime fuses only activation/pre-scan; retains post-scan and database confirmation',async()=>{
 const f=fixture();await f.run();assert.deepEqual(f.counts(),{ran:1,finished:1,modes:['activate_scan','scan_after']});
});
test('pre/post source drift cannot reach runtime success or release authority',async()=>{
 for(const opts of [{beforeDrift:true},{afterDrift:true}]){
  const f=fixture(opts);await assert.rejects(f.run(),{code:'WORKSPACE_CONFLICT'});assert.equal(f.counts().finished,0);assert.equal(f.counts().ran,opts.beforeDrift?0:1);
 }
});


test('runtime test timeout remains uncertain and cannot release writer merely because a child returned',async()=>{
 const base=sourceManifest([{path:'src/a.ts',content:'A'}]);let finished=0,blocked;
 const w=new Workspace({});w.state={revision:1};w.read=async()=>{w.manifest=base;};w.acquire=async()=>({token:'t'});w.block=async(_writer,error)=>{blocked=error.code;};w.call=async()=>finished++;
 w.gateway={run:async()=>({manifest:base}),scan:async()=>base};
 await assert.rejects(w.runtime('verify',async()=>({timedOut:true})),{code:'WORKSPACE_UNCERTAIN'});assert.equal(finished,0);assert.equal(blocked,'WORKSPACE_UNCERTAIN');
});
