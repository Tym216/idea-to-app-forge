import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { prepareRequest, resolveProvider, providerProblems, normalizeResponse, validateResponse } from '../src/llm-provider.js';
import { describeLlm } from '../src/doctor-llm.js';
import { resolveCostPolicy, estimateRequestCost, reserveRequestCost, describeCostPolicy, estimateUsageCost } from '../src/llm-cost-admission.js';
import { withExecutionControl } from '../src/execution-control.js';
import { chat } from '../src/llm.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';

const baseUrl = 'https://ws-offline.cn-beijing.maas.aliyuncs.com/compatible-mode/v1';
const profile = {
 llmProvider:'aliyun', llmModel:'qwen3.8-flash', llmBaseUrl:baseUrl, llmApiKey:'offline',
 llmJsonMode:'off', llmTimeoutMs:120000, planProviderOptionsRaw:'{}', buildProviderOptionsRaw:'{}',
 llmMaxOutputTokens:'', llmMaxOutputTokensPlan:4096, llmMaxOutputTokensBuild:4096,
 llmMaxOutputTokensDesign:4096, llmMaxOutputTokensActionPlan:4096, llmMaxOutputTokensMemory:1024,
 llmRequireOutputCap:true, llmOmitTemperature:true, llmRequireReasoningPolicy:true,
 llmReasoningEffortPlan:'none', llmReasoningEffortBuild:'none', llmReasoningEffortDesign:'none',
 llmReasoningEffortActionPlan:'none', llmReasoningEffortMemory:'none',
 llmRequireCostBudget:true, llmCostCurrency:'CNY', llmCostInputPerMillion:'0.8',
 llmCostOutputPerMillion:'2.7', llmMaxTheoreticalCostPerExecution:'0.50',
 llmCostInputUsdPerMillion:'', llmCostOutputUsdPerMillion:'', llmMaxTheoreticalCostUsdPerExecution:'',
};
const options = {providerName:'aliyun',model:profile.llmModel,messages:[{role:'user',content:'输出 JSON'}],
 temperature:0.1,json:true,jsonMode:'off',maxOutputTokens:4096,requireOutputCap:true,
 trustedReasoningEffort:'none',requireReasoningPolicy:true,nativeOptions:{enable_thinking:true}};
const context = () => ({taskId:randomUUID(),executionId:randomUUID(),signal:new AbortController().signal,checkLease:async()=>{}});

test('Aliyun uses workspace Chat Completions URL and requires its own explicit key/model',()=>{
 assert.equal(resolveProvider(profile).url,baseUrl+'/chat/completions');
 assert.deepEqual(providerProblems(profile),[]);
 assert.ok(providerProblems({...profile,llmApiKey:''}).some(x=>x.includes('API_KEY')));
 assert.ok(providerProblems({...profile,llmModel:''}).some(x=>x.includes('MODEL')));
 assert.throws(()=>resolveProvider({...profile,llmBaseUrl:baseUrl.replace('/compatible-mode/v1','/apps/anthropic')}),/compatible-mode/);
});

test('Aliyun trusted off/cap replace optional enablement without OpenRouter/DeepSeek fields',()=>{
 for(const model of ['qwen3.8-flash','qwen3.8-max','deepseek-v4-pro']) {
  const {body,capability}=prepareRequest({...options,model});
  assert.equal(body.enable_thinking,false);
  assert.equal(body.max_completion_tokens,4096);
  assert.equal(body.temperature,0.1);
  for(const field of ['max_tokens','provider','reasoning','thinking','extra_body','response_format']) assert.ok(!Object.hasOwn(body,field));
  assert.equal(capability.outputCapField,'max_completion_tokens');
  assert.equal(capability.effectiveReasoningEffort,'none');
 }
 assert.equal(prepareRequest({...options,omitTemperature:true}).body.temperature,undefined);
 assert.deepEqual(prepareRequest({...options,jsonMode:'on'}).body.response_format,{type:'json_object'});
 assert.throws(()=>prepareRequest({...options,model:'thirdparty/deepseek-v4-pro'}),{code:'LLM_OUTPUT_CAP_UNSUPPORTED'});
 assert.throws(()=>prepareRequest({...options,trustedReasoningEffort:'high'}),{code:'LLM_REASONING_POLICY_UNSUPPORTED'});
 const unknown=prepareRequest({...options,model:'unknown',maxOutputTokens:null,requireOutputCap:false,trustedReasoningEffort:null,requireReasoningPolicy:false});
 assert.equal(unknown.body.enable_thinking,undefined);
 assert.ok(unknown.capability.warnings.length);
});

test('Aliyun response normalization keeps reasoning out of executable JSON and preserves usage',()=>{
 const result=normalizeResponse({choices:[{message:{content:'{"tool":"read_file","args":{"path":"package.json"}}',reasoning_content:'private reasoning'},finish_reason:'stop'}],
  usage:{prompt_tokens:100,completion_tokens:40,total_tokens:140,completion_tokens_details:{reasoning_tokens:10}}});
 assert.equal(JSON.parse(result.text).args.path,'package.json');
 assert.equal(result.reasoning,'private reasoning');
 assert.equal(result.usage.outputTokens,40);
 assert.equal(result.usage.details.completion_tokens_details.reasoning_tokens,10);
 validateResponse(result,'json_action');
 assert.throws(()=>validateResponse({...result,text:''},'json_action'),{code:'LLM_INVALID_RESPONSE'});
});

test('CNY prices never inherit/mix USD fields; doctor reports actual cap, currency and padded reservation',()=>{
 const report=describeLlm(profile);
 assert.deepEqual(report.problems,[]);
 assert.equal(report.cost.cost_currency,'CNY');
 assert.equal(report.cost.execution_budget,0.50);
 assert.equal(report.stages.plan.outputCap,4096);
 assert.equal(report.stages.build.theoreticalProjection.output_upper_bound_tokens,4106);
 assert.equal(report.cost.execution_budget_usd,undefined);
 assert.throws(()=>resolveCostPolicy({...profile,llmCostInputUsdPerMillion:0.20}),{code:'LLM_COST_CONFIG'});
 assert.throws(()=>resolveCostPolicy({...profile,llmCostCurrency:'wrong'}),{code:'LLM_COST_CONFIG'});
 assert.throws(()=>resolveCostPolicy({...profile,llmCostCurrency:''}),{code:'LLM_COST_CONFIG'});
 assert.throws(()=>resolveCostPolicy({...profile,llmCostOutputPerMillion:''}),{code:'LLM_COST_BUDGET_REQUIRED'});
 const serialized=JSON.stringify(prepareRequest(options).body);
 const estimate=estimateRequestCost(resolveCostPolicy(profile),serialized,4096);
 assert.equal(estimate.units,BigInt(Buffer.byteLength(serialized)+2048)*800000n+4106n*2700000n);
 assert.equal(estimate.diagnostics.cost_currency,'CNY');
 assert.equal(estimate.diagnostics.request_theoretical_max_usd,undefined);
 assert.deepEqual(estimateUsageCost(resolveCostPolicy(profile),{inputTokens:100000,outputTokens:20000}),
  {currency:'CNY',input_tokens:100000,output_tokens:20000,estimated_cost:0.134,billing_verified:false,cache_discounts_applied:false});
 assert.equal(estimateUsageCost(resolveCostPolicy(profile),{inputTokens:null,outputTokens:1}),null);
 assert.throws(()=>estimateRequestCost(resolveCostPolicy(profile),JSON.stringify({...JSON.parse(serialized),max_tokens:4096}),4096),{code:'LLM_COST_OUTPUT_CAP_REQUIRED'});
});

test('currency belongs to ledger identity; same execution cannot switch units and refill budget',async()=>{
 const serialized=JSON.stringify(prepareRequest(options).body);
 const cny=resolveCostPolicy(profile), usd=resolveCostPolicy({...profile,llmCostCurrency:'USD'});
 await withExecutionControl(context(),async()=>{
  reserveRequestCost(cny,serialized,4096);
  assert.throws(()=>reserveRequestCost(usd,serialized,4096),{code:'LLM_COST_POLICY_CHANGED'});
 });
 assert.equal(describeCostPolicy({llmRequireCostBudget:true,llmCostInputUsdPerMillion:0.2,llmCostOutputUsdPerMillion:0.47,llmMaxTheoreticalCostUsdPerExecution:0.1}).cost_currency,'USD');
});

test('Aliyun common chat preserves all purpose guards and reserves each identical physical retry',async()=>{
 const old={...config},oldFetch=globalThis.fetch,oldLogger={...logger},calls=[],logs=[];
 Object.assign(config,profile);
 for(const level of ['info','warn','error']) logger[level]=(event,data)=>logs.push({event,...data});
 try {
  globalThis.fetch=async(url,init)=>{
   calls.push({url,init});
   if(calls.length===1)return new Response('temporary failure',{status:503});
   return new Response(JSON.stringify({choices:[{message:{content:'{"ok":true}'},finish_reason:'stop'}],usage:{prompt_tokens:10,completion_tokens:3}}));
  };
  await withExecutionControl(context(),async()=>{
   for(const purpose of ['design','plan','action_plan','build_decision','memory_extraction'])
    assert.equal(await chat([{role:'user',content:'JSON'}],{purpose,json:true}),'{"ok":true}');
  });
  assert.equal(calls.length,6);
  assert.equal(calls[0].init.body,calls[1].init.body);
  for(const call of calls){
   assert.equal(call.url,baseUrl+'/chat/completions');
   assert.equal(call.init.headers.Authorization,'Bearer offline');
   const body=JSON.parse(call.init.body);
   assert.equal(body.enable_thinking,false);
   assert.equal(body.provider,undefined);
   assert.equal(body.temperature,undefined);
   assert.equal(body.max_completion_tokens,call===calls.at(-1)?1024:4096);
  }
  const admissions=logs.filter(x=>x.event==='llm.cost_admission');
  assert.equal(admissions.length,6);
  assert.equal(admissions[1].execution_reserved_before,admissions[0].execution_reserved_after);
  assert.ok(admissions.every(x=>x.cost_currency==='CNY'&&x.admitted));
  const estimates=logs.filter(x=>x.event==='model.request'&&x.usage_cost_estimate).map(x=>x.usage_cost_estimate);
  assert.equal(estimates.length,5);
  assert.ok(estimates.every(x=>x.currency==='CNY'&&x.estimated_cost===0.0000161&&!x.billing_verified));
  const before=calls.length;
  await withExecutionControl(context(),async()=>{
   config.llmMaxTheoreticalCostPerExecution='0.000001';
   await assert.rejects(chat([],{purpose:'plan'}),{code:'LLM_COST_BUDGET_EXCEEDED'});
  });
  assert.equal(calls.length,before);
 } finally {Object.assign(config,old);globalThis.fetch=oldFetch;Object.assign(logger,oldLogger);}
});

test('explicit Aliyun env loads generic currency and missing key fails locally without fallback',()=>{
 const dir=mkdtempSync(join(tmpdir(),'forge-aliyun-')),file=join(dir,'test.env');
 try {
  const source='FORGE_ENVIRONMENT_ID=atoms-demo\nEXPECTED_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst\nSUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=sb_secret_offline\nDAYTONA_API_KEY=offline\nLLM_PROVIDER=aliyun\nLLM_MODEL=qwen3.8-flash\nLLM_BASE_URL='+baseUrl+'\nLLM_REQUIRE_COST_BUDGET=true\nLLM_COST_CURRENCY=CNY\nLLM_COST_INPUT_PER_MILLION=0.8\nLLM_COST_OUTPUT_PER_MILLION=2.7\nLLM_MAX_THEORETICAL_COST_PER_EXECUTION=0.50\n';
  for(const key of ['', 'LLM_API_KEY=offline\n']){
   writeFileSync(file,source+key);
   const child=spawnSync(process.execPath,['--input-type=module','-e',"const {config,assertRunnable}=await import('./src/config.js'); console.log(JSON.stringify({currency:config.llmCostCurrency,problems:assertRunnable()}));"],
    {cwd:new URL('..',import.meta.url),encoding:'utf8',env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_OPTIONS:process.env.NODE_OPTIONS||'',FORGE_ENV_FILE:file}});
   assert.equal(child.status,0,child.stderr);
   const result=JSON.parse(child.stdout);
   assert.equal(result.currency,'CNY');
   assert.equal(result.problems.length,key?0:1);
  }
 } finally {rmSync(dir,{recursive:true,force:true});}
});
