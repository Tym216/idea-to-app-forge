import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRuntimeScript } from '../src/workspace-policy.js';
import { sourceManifest } from '../src/managed-source.js';
const pkg = (scripts) => sourceManifest([{path:'package.json',content:JSON.stringify({scripts})}]);
test('runtime recipes are separate from source mutations: accepted Vite recipes; arbitrary shell/hooks are not promoted',()=>{
 assert.doesNotThrow(()=>validateRuntimeScript(pkg({build:'vite build'}),'build'));
 assert.doesNotThrow(()=>validateRuntimeScript(pkg({build:'tsc -b && vite build'}),'build'));
 assert.doesNotThrow(()=>validateRuntimeScript(pkg({dev:'vite --host 0.0.0.0 --port 5173'}),'dev'));
 for (const build of ['cp a.ts b.ts && vite build','vite build &','node mutate.js','npm run custom']) assert.throws(()=>validateRuntimeScript(pkg({build}),'build'),{code:'WORKSPACE_RUNTIME_RESTRICTED'});
});
test('a known non-404 error never creates a replacement sandbox even if its text contains not found',async()=>{
 process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';
 const {DaytonaProvider,isNotFound}=await import('../src/sandbox/daytona.js');
 assert.equal(isNotFound({statusCode:401,message:'not found'}),false);
 let created=0;
 const p=Object.create(DaytonaProvider.prototype);
 p.client={get:async()=>{throw Object.assign(new Error('network unavailable'),{statusCode:503});}};
 p.create=async()=>{created++;};
 await assert.rejects(p.ensure('old'),/network/);assert.equal(created,0);
 p.client.get=async()=>{throw {statusCode:404,message:'sandbox not found'};};
 await assert.rejects(p.ensure('old',{allowRecreate:false}));assert.equal(created,0);
});
test('browser command timeout remains uncertain rather than a reusable completed tool result',async()=>{
 const {runVerification}=await import('../src/verify.js');
 let calls=0;
 const result=await runVerification({sandboxId:'fixture',checks:[],sandbox:{exec:async()=>++calls===1?{stdout:'/home/daytona'}:{stdout:'',stderr:'timeout',timedOut:true}}});
 assert.equal(result.timedOut,true);assert.ok(result.toolError);
});
