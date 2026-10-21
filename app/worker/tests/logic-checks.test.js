import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {runLogicChecks,logicEvidenceValid,logicFingerprint,mergeLogicResult} from '../src/logic-checks.js';
async function fixture(t,source,path="src/rules.test.mjs"){
 const dir=await mkdtemp(join(tmpdir(),'forge-pure-tests-'));t.after(()=>rm(dir,{recursive:true,force:true}));await mkdir(join(dir,'src'));
 await writeFile(join(dir,path),source);const files=[{path,content:source},{path:'forge.checks.json',content:JSON.stringify({version:1,tests:[path]})}];
 const sandbox={exec:async(_id,command)=>({exitCode:0,stdout:execFileSync('/bin/sh',['-c',command],{cwd:dir,encoding:'utf8'}),timedOut:false})};
 return {files,sandbox};
}
test('old apps without pure tests require zero extra sandbox calls',async()=>{
 const files=[{path:'src/App.tsx',content:'app'},{path:'src/old.test.mjs',content:'unrelated old test'}];
 assert.equal(await runLogicChecks({files,sandbox:{exec:()=>assert.fail('must not call')},sandboxId:'s'}),null);
 assert.equal(logicEvidenceValid(files,null),true);
});
test('real Node pure tests pass and bind canonical source/recipe identity, including quoted paths',async t=>{
 const f=await fixture(t,"import {test} from 'node:test';import assert from 'node:assert/strict';test('win',()=>assert.equal(2,2));","src/it's rules.test.mjs");
 const result=await runLogicChecks({...f,sandboxId:'s'});
 assert.equal(result.status,'passed',JSON.stringify(result));assert.equal(result.tests,1);assert.equal(result.passed,1);
 assert.equal(logicEvidenceValid(f.files,result),true);assert.equal(logicEvidenceValid([...f.files,{path:'src/game.mjs',content:'changed'}],result),false);
 assert.equal(logicEvidenceValid(f.files,{...result,fingerprint:'old-recipe'}),false);
});
test('real assertion false is a blocker; passing pure tests never upgrade HTTP evidence',async t=>{
 const f=await fixture(t,"import {test} from 'node:test';import assert from 'node:assert/strict';test('boxes equal goals',()=>assert.equal(2,5));");
 const logic=await runLogicChecks({...f,sandboxId:'s'});assert.equal(logic.status,'failed',JSON.stringify(logic));assert.equal(logic.failed,1);
 const http={kind:'inconclusive',items:[],base:{blocking:[],warnings:[]},featureChecksRun:false};
 const result=mergeLogicResult(http,logic);assert.equal(result.kind,'blocker');assert.match(result.base.blocking[0],/断言失败/);
 const pass=mergeLogicResult(http,{...logic,status:'passed',failed:0,passed:1});assert.equal(pass.kind,'inconclusive');assert.equal(pass.featureChecksRun,false);
 assert.equal(http.base.blocking.length,0);
});
test('syntax/runtime test errors are tool faults; skipped tests do not claim passed',async t=>{
 const f=await fixture(t,'this is invalid javascript');assert.equal((await runLogicChecks({...f,sandboxId:'s'})).status,'tool_error');
 const g=await fixture(t,"import {test} from 'node:test';test.skip('unknown win',()=>{});");const skipped=await runLogicChecks({...g,sandboxId:'s'});
 assert.equal(skipped.status,'inconclusive');assert.equal(logicEvidenceValid(g.files,skipped),true);
 assert.equal(mergeLogicResult({kind:'passed',items:[],base:{blocking:[],warnings:[]}},skipped).kind,'success_with_warnings');
});
test('missing result/command timeout stays unconfirmed; recipe failures cannot masquerade as assertions',async()=>{
 const files=[{path:'src/a.test.mjs',content:'test'},{path:'forge.checks.json',content:JSON.stringify({version:1,tests:['src/a.test.mjs']})}];
 for(const timedOut of [false,true]){
  const result=await runLogicChecks({files,sandboxId:'s',sandbox:{exec:async()=>({stdout:'',exitCode:0,timedOut})}});
  assert.equal(result.status,'tool_error');assert.equal(result.timedOut,timedOut);assert.equal(result.fingerprint,logicFingerprint(files));
 }
});


test('explicit opt-in configuration faults fail before running any test command',async()=>{
 for(const content of ['broken',JSON.stringify({version:2,tests:['src/a.test.mjs']}),JSON.stringify({version:1,tests:['src/missing.test.mjs']}),JSON.stringify({version:1,tests:['../outside.test.mjs']})]){
  const files=[{path:'forge.checks.json',content}];const result=await runLogicChecks({files,sandbox:{exec:()=>assert.fail('no test execution')},sandboxId:'s'});
  assert.equal(result.status,'tool_error');assert.equal(logicEvidenceValid(files,result),false);
 }
});
