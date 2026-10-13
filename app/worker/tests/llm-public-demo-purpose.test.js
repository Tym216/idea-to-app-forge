import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { chat } from '../src/llm.js';
import { withExecutionControl } from '../src/execution-control.js';
import { buildConfiguredRequestBody, providerProblems } from '../src/llm-provider.js';
import { resolveOutputCap } from '../src/llm-output-cap.js';
import { resolveReasoningPolicy } from '../src/llm-reasoning-policy.js';

const settings = {
 llmProvider:'openrouter',llmModel:'qwen/qwen3.8-flash',llmApiKey:'offline',
 llmBaseUrl:'https://offline.invalid/v1',llmJsonMode:'off',llmTimeoutMs:120000,
 llmMaxOutputTokens:'',llmMaxOutputTokensPlan:4096,llmMaxOutputTokensBuild:4096,
 llmMaxOutputTokensMemory:1024,llmMaxOutputTokensDesign:4096,llmMaxOutputTokensActionPlan:4096,
 llmRequireOutputCap:true,llmOmitTemperature:true,llmRequireReasoningPolicy:true,
 llmReasoningEffortPlan:'none',llmReasoningEffortBuild:'none',llmReasoningEffortMemory:'none',
 llmReasoningEffortDesign:'none',llmReasoningEffortActionPlan:'none',
 llmRequireCostBudget:true,llmCostInputUsdPerMillion:'0.20',llmCostOutputUsdPerMillion:'0.47',
 llmMaxTheoreticalCostUsdPerExecution:'0.10',planProviderOptionsRaw:'{}',buildProviderOptionsRaw:'{}',
};
const purposes = [
 ['design',4096,'DESIGN'],['plan',4096,'PLAN'],['action_plan',4096,'ACTION_PLAN'],
 ['build_decision',4096,'BUILD'],['memory_extraction',1024,'MEMORY'],
];
const options={providerName:'openrouter',model:settings.llmModel,messages:[{role:'user',content:'offline JSON'}],
 temperature:2,json:true,jsonMode:'off',nativeOptions:{reasoning:{effort:'high',enabled:true,max_tokens:99999},max_tokens:99999,temperature:2}};
function assertBody(body,cap){
 assert.equal(body.model,settings.llmModel);assert.equal(body.max_tokens,cap);
 assert.equal(Object.hasOwn(body,'max_completion_tokens'),false);
 assert.equal(Object.hasOwn(body,'temperature'),false);
 assert.deepEqual(body.reasoning,{effort:'none'});
 assert.equal(body.provider.require_parameters,true);
 assert.equal(body.provider.allow_fallbacks,false);
}
test('public Demo maps only five explicit purposes; native/caller settings cannot raise caps or enable thinking',()=>{
 for(const [purpose,cap,source] of purposes){
  assertBody(buildConfiguredRequestBody(settings,purpose,{...options,maxOutputTokens:99999,
   trustedReasoningEffort:'high',omitTemperature:false}),cap);
  assert.equal(resolveOutputCap(settings,purpose).outputCapSource,'LLM_MAX_OUTPUT_TOKENS_'+source);
  assert.equal(resolveReasoningPolicy(settings,purpose).reasoningPolicySource,'LLM_REASONING_EFFORT_'+source);
 }
 for(const purpose of ['doctor_probe','unspecified','future','action','design_extra'])
  for(const resolve of [resolveOutputCap,resolveReasoningPolicy])
   assert.throws(()=>resolve(settings,purpose),e=>/_REQUIRED$/.test(e.code));
});
test('missing or malformed public-purpose configuration never gets a global/default fallback',()=>{
 for(const [cap,effort,purpose] of [
  ['llmMaxOutputTokensDesign','llmReasoningEffortDesign','design'],
  ['llmMaxOutputTokensActionPlan','llmReasoningEffortActionPlan','action_plan'],
 ]){
  assert.throws(()=>resolveOutputCap({...settings,[cap]:''},purpose),{code:'LLM_OUTPUT_CAP_REQUIRED'});
  assert.throws(()=>resolveReasoningPolicy({...settings,[effort]:''},purpose),{code:'LLM_REASONING_POLICY_REQUIRED'});
  assert.ok(providerProblems({...settings,[cap]:'invalid'}).length);
  assert.ok(providerProblems({...settings,[effort]:'invalid'}).length);
 }
});
async function runtime(fn,extra={}){
 const prior={...config},fetch=globalThis.fetch,log={...logger},logs=[];
 Object.assign(config,settings,extra,{planProviderOptionsRaw:JSON.stringify(options.nativeOptions),buildProviderOptionsRaw:JSON.stringify(options.nativeOptions)});
 for(const level of ['info','warn','error'])logger[level]=(message,meta)=>logs.push({message,...meta});
 const taskId=randomUUID(),executionId=randomUUID();
 const control={taskId,executionId,signal:new AbortController().signal,checkLease:async()=>{}};
 try{await withExecutionControl(control,()=>fn({logs,taskId,executionId}));}
 finally{Object.assign(config,prior);globalThis.fetch=fetch;Object.assign(logger,log);}
}
test('real common request boundary reserves every public purpose before HTTP, sharing one authoritative execution budget',async()=>runtime(async({logs,taskId,executionId})=>{
 const bodies=[];
 globalThis.fetch=async(_url,init)=>{
  const admission=logs.findLast(x=>x.message==='llm.cost_admission');
  assert.ok(admission.admitted);assert.equal(admission.execution_id,executionId);
  assert.ok(admission.execution_reserved_after<=0.1);
  bodies.push(JSON.parse(init.body));
  return new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}]}));
 };
 for(const [purpose,cap] of purposes){
  await chat(options.messages,{taskId,purpose,temperature:2,reasoningMode:'high',maxOutputTokens:99999,
   trustedReasoningEffort:'high',omitTemperature:false});
  assertBody(bodies.at(-1),cap);
 }
 const admissions=logs.filter(x=>x.message==='llm.cost_admission');
 assert.equal(bodies.length,5);assert.deepEqual(admissions.map(x=>x.purpose),purposes.map(x=>x[0]));
 for(let i=1;i<admissions.length;i++)assert.equal(admissions[i].execution_reserved_before,admissions[i-1].execution_reserved_after);
 for(const purpose of ['doctor_probe','unspecified','unrelated'])
  await assert.rejects(chat(options.messages,{taskId,purpose}),{code:'LLM_OUTPUT_CAP_REQUIRED'});
 assert.equal(bodies.length,5);
}));
test('design/action_plan cannot bypass pre-HTTP cost refusal with a valid response format',async()=>{
 for(const purpose of ['design','action_plan'])
  await runtime(async({taskId,logs})=>{
   let posts=0;globalThis.fetch=async()=>{posts++;throw new Error('HTTP must be blocked');};
   await assert.rejects(chat(options.messages,{taskId,purpose}),{code:'LLM_COST_BUDGET_EXCEEDED'});
   assert.equal(posts,0);assert.equal(logs.findLast(x=>x.message==='llm.cost_admission').admitted,false);
  },{llmMaxTheoreticalCostUsdPerExecution:'0.0000001'});
});
