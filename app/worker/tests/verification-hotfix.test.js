import {test} from 'node:test';
import assert from 'node:assert/strict';
import {classifyResult,formatObservation,composeSummary,reclassifyStoredVerification} from '../src/verify.js';
import {verificationContinuationCandidate,assertVerificationContinuationBasis} from '../src/verification-continuation.js';
const base={blocking:[],warnings:[],placeholder:false,chars:40,visible:12};
const a={id:'A1',action:'完成任务',expect:'状态变为完成',external:false,severity:'core',steps:[{op:'click',selector:'#checkbox'},{op:'expectTrue',js:'document.querySelector("#item").classList.contains("completed")'}]};
const diagnostics={bodyText:'INTERNAL_BODY_DUMP',elements:[{selector:'#add',disabled:true},{selector:'#checkbox',disabled:false}]};
const fail={id:'A1',status:'fail',reason:'步骤 1 click: locator.click: Timeout 5000ms exceeded',stepResults:[{index:1,op:'click',ok:false,observed:diagnostics}]};
test('click timeout with proven root/asset/runtime health is a warning, unrelated disabled button never proves core failure',()=>{
 const v=classifyResult({base,checks:[fail]},[a]);
 assert.equal(v.kind,'success_with_warnings');assert.equal(v.items[0].status,'warning');
 assert.equal(v.items[0].code,'AUTOMATION_INCONCLUSIVE');assert.equal(v.items[0].reason,fail.reason);
 assert.deepEqual(v.items[0].stepResults[0].observed,diagnostics);
 assert.ok(!formatObservation(v,1,2).includes('locator.click'));assert.ok(!formatObservation(v,1,2).includes('INTERNAL_BODY_DUMP'));
 assert.ok(!composeSummary('完成',v).includes('locator.click'));
});
test('HTTP/asset/root/runtime failures and verifier tool faults remain blocking even with locator errors',()=>{
 for(const reason of ['HTTP 500 document /','请求失败 script /main.js','页面只有占位内容','页面异常: crash'])
  assert.equal(classifyResult({base:{...base,blocking:[reason]},checks:[fail]},[a]).kind,'blocker');
 assert.equal(classifyResult({base,checks:[{...fail,blocking:['页面异常: crash']}]},[a]).kind,'blocker');
 assert.equal(classifyResult({toolError:'browser unavailable'},[a]).kind,'tool_error');
 const unknown=classifyResult({base:{blocking:[],warnings:[]},checks:[fail]},[a]);
 assert.equal(unknown.kind,'inconclusive');assert.notEqual(unknown.items[0].status,'verified');
});
test('a definite core assertion false stays a blocker and is never confused with automation inconclusive',()=>{
 const v=classifyResult({base,checks:[{...fail,reason:'步骤 2 expectTrue: 表达式为假',
  stepResults:[{index:2,op:'expectTrue',ok:false,actual:false,observed:diagnostics}]}]},[a]);
 assert.equal(v.kind,'blocker');assert.equal(v.items[0].status,'blocker');
});
test('legacy automation-only blocker can enter deterministic continuation; no other execution or stale basis can',()=>{
 const old={...classifyResult({base,checks:[fail]},[a]),kind:'blocker'};
 old.items[0].status='blocker';delete old.items[0].code;
 const task={mode:'build',operation:'agent',kind:'resume',plan_id:'plan',plan_version:1};
 const workspace={manifest:{code_hash:'hash'},state:{revision:6,state:'confirmed',writer:null,build:{status:'passed'},
  verify:{status:'blocker',workspace_revision:6,code_hash:'hash',result:old}},valid:(_kind,basis)=>basis==='build-basis'};
 assert.equal(reclassifyStoredVerification(old,[a]).kind,'success_with_warnings');
 assert.equal(verificationContinuationCandidate(task,workspace),true);
 const plan={id:'plan',version:1,status:'approved'};
 assert.doesNotThrow(()=>assertVerificationContinuationBasis(task,workspace,plan,[a],'build-basis'));
 for(const other of [{...task,kind:'new'},{...task,operation:'user_apply'},{...task,mode:'plan'}])
  assert.equal(verificationContinuationCandidate(other,workspace),false);
 for(const alter of [
  ()=>{workspace.state.writer={token:'busy'};},
  ()=>{workspace.state.verify.workspace_revision=5;},
  ()=>{workspace.state.verify.code_hash='changed';},
 ]){
  const saved=structuredClone(workspace.state);alter();
  assert.throws(()=>assertVerificationContinuationBasis(task,workspace,plan,[a],'build-basis'),{code:'WORKSPACE_EVIDENCE_STALE'});
  workspace.state=saved;
 }
 assert.throws(()=>assertVerificationContinuationBasis(task,workspace,plan,[{...a,steps:[]}],'build-basis'),{code:'WORKSPACE_EVIDENCE_STALE'});
 assert.throws(()=>assertVerificationContinuationBasis(task,workspace,plan,[a],'new-build-basis'),{code:'WORKSPACE_EVIDENCE_STALE'});
});