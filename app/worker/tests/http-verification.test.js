import {test} from 'node:test';
import assert from 'node:assert/strict';
import {browserVerificationEnabled,HTTP_CHECK_SOURCE,httpVerificationFingerprint,runHttpVerification} from '../src/http-verification.js';
import {verifyFingerprint,sha256,sourceManifest} from '../src/managed-source.js';
import {RUNNER_SOURCE,PLAYWRIGHT_VERSION,composeSummary} from '../src/verify.js';
import {runDeterministicValidation,runBuild} from '../src/agent.js';
import {config} from '../src/config.js';
const acceptance=[{id:'A1',action:'add',expect:'retained',external:false,severity:'core',steps:[{op:'click',selector:'button'},{op:'expectText',contains:'retained'}]}];
test('browser verification defaults on; explicit false opts into HTTP, malformed values fail',()=>{
 assert.equal(browserVerificationEnabled(),true);
 for(const v of [true,'true'])assert.equal(browserVerificationEnabled(v),true);
 for(const v of [false,'false'])assert.equal(browserVerificationEnabled(v),false);
 for(const v of ['',null,0,'False'])assert.throws(()=>browserVerificationEnabled(v));
});
test('HTTP evidence is distinct from full browser evidence and changes with acceptance/build basis',()=>{
 const fast=httpVerificationFingerprint(acceptance,'b');
 assert.notEqual(fast,verifyFingerprint(acceptance,{runnerHash:sha256(RUNNER_SOURCE),playwrightVersion:PLAYWRIGHT_VERSION,buildBasis:'b'}));
 assert.notEqual(fast,httpVerificationFingerprint(acceptance,'other'));
 assert.notEqual(fast,httpVerificationFingerprint([{...acceptance[0],steps:[{op:'expectText',contains:'other'}]}],'b'));
});
async function evaluate(responses){
 let calls=0,output='';
 const execute=new Function('fetch','console','return (async()=>{'+HTTP_CHECK_SOURCE+'})()');
 await execute(async url=>{
  assert.ok(String(url).startsWith('http://127.0.0.1:5173/'));
  const response=responses[calls++];if(response instanceof Error)throw response;return response;
 },{log:s=>{output+=s;}});
 return {output,calls};
}
test('actual HTTP recipe checks local HTML/entry; server errors block and no browser install/upload occurs',async()=>{
 for(const failure of [false,true]){
  const source=await evaluate([new Response('<!doctype html><html><script src="/src/main.tsx"></script></html>'),new Response('module',{status:failure?500:200})]);
  let execs=0;
  const result=await runHttpVerification({sandbox:{exec:async()=>{execs++;return{exitCode:0,stdout:source.output};},writeFile:()=>assert.fail('NO_BROWSER_UPLOAD')},sandboxId:'s',acceptance});
  assert.equal(execs,1);assert.equal(source.calls,2);
  assert.equal(result.kind,failure?'blocker':'inconclusive');
  assert.equal(result.featureChecksRun,false);assert.equal(result.browserChecksRun,false);
  assert.equal(result.items[0].status,'inconclusive');
  assert.ok(!composeSummary('ready',result).includes('已验证(浏览器实际执行)'));
 }
 const network=await evaluate([new TypeError('offline')]);
 const down=await runHttpVerification({sandbox:{exec:async()=>({exitCode:0,stdout:network.output})},sandboxId:'s',acceptance});
 assert.equal(down.kind,'blocker');
 const bad=await runHttpVerification({sandbox:{exec:async()=>({exitCode:0,stdout:'not structured'})},sandboxId:'s',acceptance});
 assert.equal(bad.kind,'tool_error');
});
test('real Agent/User Apply tool pipelines keep build/start but skip browser/LLM repair in temporary mode',async()=>{
 const previous=config.browserVerificationEnabled,fetchBefore=globalThis.fetch;
 config.browserVerificationEnabled='false';globalThis.fetch=async()=>({ok:true});
 try{
  for(const agent of [false,true,'known-blocker']){
   let browser=0,http=0,llm=0;
   const files=[{path:'package.json',content:'{"scripts":{"build":"vite build","dev":"vite"},"dependencies":{}}'},{path:'src/App.tsx',content:'export default function App(){return null;}'}];
   const steps=[],evidence=[];
   const task={id:'t',project_id:'p',user_id:'u',execution_id:'e',steps,tool_steps:0,fix_rounds:0};
   const ws={state:{revision:1},manifest:sourceManifest(files),assertCurrent:async()=>{},runtime:async(_kind,fn)=>fn(),valid:()=>false,evidence:async(...args)=>evidence.push(args)};
   const sandbox={workdir:'/app',listFiles:async()=>files.map(f=>f.path),readFile:async(_s,path)=>files.find(f=>f.path===path)?.content,
    exec:async()=>({exitCode:0,stdout:'200',stderr:''}),isPortListening:async()=>true,readLogs:async()=>'',previewUrl:async()=>assert.fail('DO_NOT_RESIGN_HEALTHY_URL')};
   const basis={acceptance,buildBasis:'build',verifyBasis:httpVerificationFingerprint(acceptance,'build'),userApplyPolicy:{install:'SKIPPED_UNCHANGED',mode:'http'}};
   const actions=['build','start_dev','verify','finish'];
   const deps={checkLease:async()=>{},updateTask:async()=>{},updateProject:async()=>{},appendStep:async(_t,s)=>steps.push(s),
    listFiles:async()=>files,chat:async()=>{llm++;return JSON.stringify({tool:actions.shift(),args:{}});},
    verifyApp:async()=>{browser++;assert.fail('BROWSER_MUST_NOT_RUN');},
    verifyHttpApp:async()=>{http++;return{kind:'inconclusive',base:{blocking:[],warnings:[]},validationMode:'http',featureChecksRun:false,items:acceptance.map(a=>({...a,status:'inconclusive',stepResults:[]}))};}};
   if(agent==='known-blocker'){
    const full=verifyFingerprint(acceptance,{runnerHash:sha256(RUNNER_SOURCE),playwrightVersion:PLAYWRIGHT_VERSION,buildBasis:'build'});
    ws.state.verify={status:'blocker',result:{base:{blocking:['runtime crash'],warnings:[]},items:acceptance.map(a=>({...a,status:'blocker',stepResults:[]}))}};
    ws.valid=(kind,b)=>kind==='verify'&&b===full;
    await assert.rejects(runDeterministicValidation(task,sandbox,'s',ws,basis,deps,{existingPreviewUrl:'https://saved.test'}),{code:'VERIFY_FAILED'});
    assert.equal(http,0);assert.equal(browser,0);assert.equal(llm,0);continue;
   }
   const result=agent?await runBuild(task,{sandbox_id:'s',preview_url:'https://saved.test'},sandbox,'s','context',deps,'',acceptance,
    {workspace:ws,buildBasis:basis.buildBasis,verifyBasis:basis.verifyBasis,verificationMode:'http',fusionEnabled:false})
    :await runDeterministicValidation(task,sandbox,'s',ws,basis,deps,{existingPreviewUrl:'https://saved.test'});
   assert.equal(browser,0);assert.equal(http,1);assert.equal(llm,agent?3:0);
   assert.equal(result.verificationKind,'inconclusive');
   assert.equal(evidence.find(e=>e[0]==='verify')[1],basis.verifyBasis);
   assert.equal(steps.find(s=>s.tool==='verify_attempt').result.mode,'http');
  }
 }finally{config.browserVerificationEnabled=previous;globalThis.fetch=fetchBefore;}
});
