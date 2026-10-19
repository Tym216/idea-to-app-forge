import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createAccountPreviewWarmup} from '../src/lib/accountPreviewWarmup.js';
const project=(id,extra={})=>({id,user_id:'owner',sandbox_id:'sandbox-'+id,preview_url:'https://app.example/'+id,checkpoint_id:'v1',workspace_state:'confirmed',workspace_writer:null,workspace_revision:1,workspace_hash:'hash',...extra});
test('warmup only checks the signed-in account confirmed, published previews; warm and unknown runtimes do not enqueue recovery',async()=>{
 const checked=[],recovered=[];
 const candidates=[project('warm'),project('cold'),project('unknown'),project('foreign',{user_id:'other'}),project('draft',{checkpoint_id:null}),project('writer',{workspace_writer:{token:'held'}}),project('uncertain',{workspace_state:'uncertain'}),project('deleting',{deletion_state:'deleting'})];
 const w=createAccountPreviewWarmup({userId:'owner',listProjects:async()=>candidates,isActive:()=>true,
  probe:async url=>{checked.push(url);return url.endsWith('/warm')?true:url.endsWith('/cold')?false:null;},recover:async id=>recovered.push(id)});
 await w.check();assert.equal(checked.length,3);assert.deepEqual(recovered,['cold']);
});
test('offline/hidden/logout checks never list, probe or enqueue; logout during probe cannot wake a sandbox',async()=>{
 let active=false,calls=0;let finish;
 const w=createAccountPreviewWarmup({userId:'owner',listProjects:async()=>{calls++;return[project('cold')];},isActive:()=>active,
  probe:()=>new Promise(resolve=>{finish=resolve;}),recover:async()=>{throw Error('must never enqueue');}});
 await w.check();assert.equal(calls,0);active=true;const pass=w.check();await Promise.resolve();w.stop();finish(false);await pass;assert.equal(calls,1);await w.check();assert.equal(calls,1);
});
test('account warmup serializes checks, enforces five-minute cooldown and never overlaps recovery submissions',async()=>{
 let time=0,probes=0,recoveries=0,release;
 const w=createAccountPreviewWarmup({userId:'owner',now:()=>time,isActive:()=>true,listProjects:async()=>[project('cold')],
  probe:async()=>{probes++;return false;},recover:()=>{recoveries++;return new Promise(resolve=>{release=resolve;});}});
 const first=w.check();await Promise.resolve();await Promise.resolve();await w.check();assert.equal(recoveries,1);release();await first;
 await w.check();assert.equal(probes,1);time=300000;const next=w.check();await Promise.resolve();await Promise.resolve();assert.equal(recoveries,2);release();await next;
});
test('one RPC conflict cannot block another project or trigger blind retries',async()=>{
 const calls=[];const w=createAccountPreviewWarmup({userId:'owner',isActive:()=>true,listProjects:async()=>[project('busy'),project('cold')],probe:async()=>false,
 recover:async id=>{calls.push(id);if(id==='busy')throw Error('writer held');}});
 await w.check();await w.check();assert.deepEqual(calls,['busy','cold']);
});
