import {test} from 'node:test';import assert from 'node:assert/strict';
import {userApplyPolicy,userApplyHealthFingerprint,userApplyHealthResult} from '../src/user-apply-validation.js';
import {runDeterministicValidation} from '../src/agent.js';import {sourceManifest,buildFingerprint,verifyFingerprint,sha256} from '../src/managed-source.js';
import {RUNNER_SOURCE,PLAYWRIGHT_VERSION} from '../src/verify.js';
const files=[{path:'package.json',content:JSON.stringify({scripts:{build:'vite build',dev:'vite'},dependencies:{react:'1'}})},{path:'src/App.tsx',content:'export const A = 1;'}];
const acceptance=[{id:'A1',action:'click',expect:'changed',external:false,severity:'core',steps:[{op:'click',selector:'button'},{op:'expectText',contains:'done'}]}];
const healthy={base:{blocking:[],warnings:[],placeholder:false,chars:20,visible:8},checks:[]};
test('dependency unchanged / source-only edit skips install; manifest and config changes escalate for real reasons',()=>{
 assert.deepEqual(userApplyPolicy(files,[files[0],{path:'src/App.tsx',content:'changed'}]),{install:'SKIPPED_UNCHANGED',mode:'health',escalationReason:null});
 for(const path of ['package.json','package-lock.json','.npmrc','pnpm-lock.yaml'])assert.equal(userApplyPolicy(files,[...files.filter(f=>f.path!==path),{path,content:'new'}]).install,'REQUIRED');
 assert.deepEqual(userApplyPolicy(files,[...files,{path:'vite.config.ts',content:'config'}]),{install:'SKIPPED_UNCHANGED',mode:'full',escalationReason:'runtime_config_changed'});
});
test('health evidence is distinct from feature acceptance; no fabricated passed interaction; fatal render/runtime blocks',()=>{
 const fast=userApplyHealthFingerprint(acceptance,'build');
 assert.notEqual(fast,verifyFingerprint(acceptance,{runnerHash:sha256(RUNNER_SOURCE),playwrightVersion:PLAYWRIGHT_VERSION,buildBasis:'build'}));
 assert.equal(userApplyHealthResult(healthy,acceptance).kind,'inconclusive');
 assert.equal(userApplyHealthResult(healthy,acceptance).items[0].status,'inconclusive');
 assert.equal(userApplyHealthResult({...healthy,base:{...healthy.base,blocking:['页面异常']}},acceptance).kind,'blocker');
 assert.equal(userApplyHealthResult({...healthy,base:{...healthy.base,chars:0,visible:0}},acceptance).kind,'blocker');
 assert.equal(userApplyHealthResult({toolError:'broken browser'},acceptance).kind,'tool_error');
});
async function fixture({dependency=false,dead=false,compileFail=false,renderFail=false}={}){
 const commands=[],steps=[],calls=[],evidences=[],manifest=sourceManifest(files);let port=!dead,started=0;
 const sb={workdir:'/app',readFile:async(_id,path)=>files.find(f=>f.path===path)?.content,listFiles:async()=>files.map(f=>f.path),
 exec:async(_id,cmd)=>{commands.push(cmd);if(cmd.includes('curl'))return {exitCode:0,stdout:'200'};return {exitCode:cmd==='npm run --ignore-scripts build'&&compileFail?1:0,stdout:'ok',stderr:''};},
 isPortListening:async()=>port,startBackground:async()=>{started++;port=true;return {commandId:'dev'};},readLogs:async()=>'',previewUrl:async()=>{throw Error('healthy saved URL must not be resolved');}};
 const ws={state:{revision:3},manifest,assertCurrent:async r=>assert.equal(r,3),runtime:async(kind,fn)=>{calls.push(kind);return fn();},valid:()=>false,evidence:async(...args)=>evidences.push(args)};
 const task={id:'t',project_id:'p',user_id:'u',steps,tool_steps:0,fix_rounds:0};
 const basis={acceptance,buildBasis:buildFingerprint({command:'build'}),verifyBasis:'health',userApplyPolicy:{install:dependency?'REQUIRED':'SKIPPED_UNCHANGED',mode:dependency?'full':'health',escalationReason:dependency?'dependency_inputs_changed':null}};
 const oldFetch=globalThis.fetch;globalThis.fetch=async()=>({ok:true});
 try{const result=await runDeterministicValidation(task,sb,'s',ws,basis,{checkLease:async()=>{},updateProject:async()=>{},updateTask:async()=>{},appendStep:async(_t,s)=>steps.push(s),
 verifyApp:async input=>{if(dependency)assert.equal(input.checks.length,1);else assert.deepEqual(input.checks,[]);return renderFail?{...healthy,base:{...healthy.base,blocking:['页面异常: crash']}}:dependency?{...healthy,checks:[{id:'A1',status:'pass'}]}:healthy;}},
 {existingPreviewUrl:'https://stable.test/'});
 return {result,commands,steps,evidences,started,calls};
 }catch(e){e.fixture={commands,steps,evidences,started,calls};throw e;}finally{globalThis.fetch=oldFetch;}
}
test('real deterministic pipeline skips install and feature clicks, reuses healthy server/URL and records health evidence',async()=>{
 const f=await fixture();assert.ok(!f.commands.some(c=>c.startsWith('npm install')));assert.equal(f.started,0);assert.equal(f.result.previewUrl,'https://stable.test/');assert.equal(f.result.verificationKind,'inconclusive');
 assert.equal(f.steps.find(s=>s.tool==='install').result.status,'SKIPPED_UNCHANGED');assert.equal(f.steps.find(s=>s.tool==='start_dev'&&s.event==='finished').result.runtime,'reused');
 assert.equal(f.evidences.find(e=>e[0]==='verify')[3].featureChecksRun,false);
});
test('changed dependencies run normal install and fuller fixed validation; dead dev server starts once',async()=>{
 assert.ok((await fixture({dependency:true})).commands.some(c=>c.startsWith('npm install')));
 assert.equal((await fixture({dead:true})).started,1);
});
test('fatal compile/render errors stop before successful validation/checkpoint without LLM repair',async()=>{
 for(const options of [{compileFail:true},{renderFail:true}])await assert.rejects(fixture(options),e=>{assert.ok(e.fixture);assert.ok(!e.fixture.calls.includes('checkpoint'));return /USER_APPLY_VALIDATION_FAILED|VERIFY/.test(e.code);});
});
