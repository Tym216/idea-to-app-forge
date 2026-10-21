import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canRepairVerification, VerificationRepair, verificationRepairPrompt, VERIFY_REPAIR_LIMITS } from '../src/verification-repair.js';
const task = () => ({ operation: 'agent', steps: [{tool:'verify_attempt'}] });
const workspace = () => ({state:{state:'confirmed',writer:null,verify:{status:'blocker'}}});
const failure = {code:'VERIFY_FAILED',message:'expected=3 actual=2'};
test('only confirmed actionable blocker admits one repair; warnings/tool errors/uncertain/User Apply never call LLM', () => {
  assert.ok(canRepairVerification(task(),failure,workspace()));
  for(const code of ['VERIFY_TOOL_ERROR','WORKSPACE_UNCERTAIN','LEASE_LOST','VERIFY_REVISION_UNCHANGED'])
    assert.equal(canRepairVerification(task(),{code},workspace()),false);
  assert.equal(canRepairVerification({...task(),operation:'user_apply'},failure,workspace()),false);
  for(const state of ['partial','uncertain','conflict'])assert.equal(canRepairVerification(task(),failure,{state:{...workspace().state,state}}),false);
  assert.equal(canRepairVerification(task(),failure,{state:{...workspace().state,writer:{token:'held'}}}),false);
});
test('durable admission prevents a renewed episode on resume and exhausted verify budget prevents admission', () => {
  const t=task();t.steps.push({tool:'verification_repair',event:'started'});
  assert.equal(canRepairVerification(t,failure,workspace()),false);
  assert.equal(canRepairVerification({...task(),steps:[{tool:'verify_attempt'},{tool:'verify_attempt'}]},failure,workspace()),false);
});
test('at most four additional logical requests including format repair; no allowance renewal', () => {
  const r=new VerificationRepair({now:()=>0});
  for(let i=0;i<4;i++)assert.equal(r.nextCall(),90000);
  assert.throws(()=>r.nextCall(),e=>e.code==='VERIFY_REPAIR_LIMIT'&&e.repairReason==='model_call_limit');
});
test('one shared monotonic deadline covers reads/writes/commands and shortens remaining model deadline', () => {
  let time=0;const r=new VerificationRepair({now:()=>time});time=40000;assert.equal(r.nextCall(),50000);
  time=VERIFY_REPAIR_LIMITS.durationMs;
  assert.throws(()=>r.beforeTool('write_file'),{code:'VERIFY_REPAIR_LIMIT'});
  assert.throws(()=>r.nextCall(),{code:'VERIFY_REPAIR_LIMIT'});
});
test('short repair cannot dispatch arbitrary commands or relax confirmed checks', () => {
  const r=new VerificationRepair();assert.throws(()=>r.beforeTool('run_command'),{code:'VERIFY_REPAIR_LIMIT'});
  const prompt=verificationRepairPrompt(failure);assert.match(prompt,/expected=3 actual=2/);assert.match(prompt,/acceptance 不可修改/);assert.match(prompt,/不得删除/);
});
