import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveCostPolicy, parseCostDecimal, parseRequireCostBudget, estimateRequestCost,
  reserveRequestCost, describeCostPolicy, assertUnbudgetedOperatorInferenceAllowed } from '../src/llm-cost-admission.js';
import { withExecutionControl } from '../src/execution-control.js';
import { config } from '../src/config.js';
import { createTaskMetrics, withTaskMetrics } from '../src/task-metrics.js';
import { chat } from '../src/llm.js';
import { buildConfiguredRequestBody } from '../src/llm-provider.js';
import { extractMemories } from '../src/memory.js';
import { logger } from '../src/logger.js';

const profile = {
 llmProvider:'openrouter', llmModel:'qwen/qwen3.8-flash', llmApiKey:'offline',
 llmBaseUrl:'https://offline.invalid/v1', llmJsonMode:'off', llmTimeoutMs:120000,
 llmMaxOutputTokens:'', llmMaxOutputTokensBuild:4096, llmMaxOutputTokensPlan:4096,
 llmMaxOutputTokensMemory:1024, llmRequireOutputCap:true, llmOmitTemperature:true,
 llmReasoningEffortPlan:'none',llmReasoningEffortBuild:'none',llmReasoningEffortMemory:'none',llmRequireReasoningPolicy:true,
 llmRequireCostBudget:true,llmCostInputUsdPerMillion:'0.20',llmCostOutputUsdPerMillion:'0.47',
 llmMaxTheoreticalCostUsdPerExecution:'0.10',planProviderOptionsRaw:'{}',buildProviderOptionsRaw:'{}',
 planTemperature:0.2,buildTemperature:0.1,
};
const input = [{role:'user',content:'offline'}];
const context = () => ({ taskId: randomUUID(), executionId: randomUUID(), signal: new AbortController().signal, checkLease: async()=>{} });
const response = (extra={}) => new Response(JSON.stringify({choices:[{message:{content:'{}'},finish_reason:'stop'}],...extra}));
const body = (messages=input, purpose='build_decision') => JSON.stringify(buildConfiguredRequestBody(profile,purpose,{
 providerName:'openrouter',model:profile.llmModel,messages,temperature:0.1,json:true,jsonMode:'off',nativeOptions:{},
}));
const policy = (budget='0.10') => resolveCostPolicy({...profile,llmMaxTheoreticalCostUsdPerExecution:budget});
const run = (ctx,fn) => withExecutionControl(ctx,fn);

async function runtime(fn, extra={}) {
 const old={...config}, oldFetch=globalThis.fetch, oldLogger={...logger}, logs=[];
 Object.assign(config,profile,extra);
 for(const level of ['info','warn','error']) logger[level]=(event,data)=>logs.push({event,...data});
 try { await fn(logs); } finally {Object.assign(config,old);globalThis.fetch=oldFetch;Object.assign(logger,oldLogger);}
}

test('strict decimal config, zero rates, missing fields and secret-safe errors',()=>{
 assert.equal(resolveCostPolicy({}).required,false);
 for(const v of [undefined,'',false,'false']) assert.equal(parseRequireCostBudget(v),false);
 for(const v of [true,'true']) assert.equal(parseRequireCostBudget(v),true);
 for(const v of ['TRUE',1,'SECRET']) assert.throws(()=>parseRequireCostBudget(v),e=>!e.message.includes('SECRET'));
 for(const v of [0,'0','0.20',0.47,'1e-3','1e308']) assert.ok(parseCostDecimal(v));
 for(const v of [-1,'-1','NaN','Infinity',NaN,Infinity,true,{},[], ' 0.2 ', '0.2junk','SECRET', '0x10'])
  assert.throws(()=>parseCostDecimal(v),e=>e.code==='LLM_COST_CONFIG'&&!e.message.includes('SECRET'));
 for(const field of ['llmCostInputUsdPerMillion','llmCostOutputUsdPerMillion','llmMaxTheoreticalCostUsdPerExecution'])
  assert.throws(()=>resolveCostPolicy({...profile,[field]:''}),{code:'LLM_COST_BUDGET_REQUIRED'});
 assert.throws(()=>policy('0'),{code:'LLM_COST_CONFIG'});
 assert.throws(()=>policy('-1'),{code:'LLM_COST_CONFIG'});
 assert.throws(()=>policy('1e-14'),{code:'LLM_COST_CONFIG'});
 assert.throws(()=>resolveCostPolicy({llmCostInputUsdPerMillion:'SECRET'}),{code:'LLM_COST_CONFIG'});
 assert.equal(resolveCostPolicy({...profile,llmCostInputUsdPerMillion:0,llmCostOutputUsdPerMillion:0}).inputRate,0);
});

test('real config loader and startup/doctor share cost validation; no env fallback',()=>{
 const dir=mkdtempSync(join(tmpdir(),'forge-cost-env-')), file=join(dir,'offline.env');
 const base=['FORGE_ENVIRONMENT_ID=atoms-demo','EXPECTED_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst',
 'SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co','SUPABASE_SERVICE_ROLE_KEY=sb_secret_offline',
 'LLM_PROVIDER=openrouter','LLM_MODEL=offline','OPENROUTER_API_KEY=offline','DAYTONA_API_KEY=offline',
 'LLM_MAX_OUTPUT_TOKENS_BUILD=4096','LLM_REASONING_EFFORT_BUILD=none','LLM_REQUIRE_COST_BUDGET=true',
 'LLM_COST_INPUT_USD_PER_MILLION=0.20','LLM_COST_OUTPUT_USD_PER_MILLION=0.47','LLM_MAX_THEORETICAL_COST_USD_PER_EXECUTION=0.10'];
 const env={PATH:process.env.PATH,HOME:process.env.HOME,NODE_OPTIONS:process.env.NODE_OPTIONS||'',
 FORGE_ENV_FILE:file,LANGFUSE_ENABLED:'false',FORGE_NO_MAIN:'1'};
 try {
  for(const invalid of [false,true]) {
   writeFileSync(file,base.join('\n').replace('LLM_COST_INPUT_USD_PER_MILLION=0.20',
     'LLM_COST_INPUT_USD_PER_MILLION='+(invalid?'SECRET':'0.20')));
   const child=spawnSync(process.execPath,['--input-type=module','-e',
    "const {config,assertRunnable}=await import('./src/config.js');console.log(JSON.stringify({cap:config.llmMaxOutputTokensBuild,effort:config.llmReasoningEffortBuild,problems:assertRunnable()}));"],
    {cwd:new URL('..',import.meta.url),env,encoding:'utf8'});
   assert.equal(child.status,0,child.stderr); const result=JSON.parse(child.stdout);
   assert.equal(result.cap,'4096');assert.equal(result.effort,'none');
   assert.equal(result.problems.length,invalid?1:0);assert.ok(!child.stdout.includes('SECRET'));
  }
 }finally{rmSync(dir,{recursive:true,force:true});}
});

test('input upper bound counts entire final UTF-8 body plus 2048 for small/large/Unicode/code bodies',()=>{
 for(const content of ['x','x'.repeat(200000),'\u5ba2\u6237\ud83d\ude80'.repeat(80),'const a = {x: "\\n"};\n'.repeat(300)]) {
  const serialized=body([{role:'user',content}]), estimate=estimateRequestCost(policy(),serialized,4096);
  const expected=Buffer.byteLength(serialized,'utf8')+2048;
  assert.equal(estimate.diagnostics.input_upper_bound_tokens,expected);
  assert.ok(expected>=serialized.length+2048);
  assert.equal(estimate.units,BigInt(expected)*200000n+4096n*470000n);
 }
 assert.throws(()=>estimateRequestCost(policy(),body(),null),{code:'LLM_COST_OUTPUT_CAP_REQUIRED'});
 assert.throws(()=>estimateRequestCost(policy(),body(),1024),{code:'LLM_COST_OUTPUT_CAP_REQUIRED'});
 assert.equal(describeCostPolicy(profile).ledger_allocated,false);
});

test('synchronous reservations cannot oversubscribe; same execution reentry cannot reset pool',async()=>{
 const ctx=context(), p=policy('0.003'), b=body();
 const results=await run(ctx,()=>Promise.allSettled([1,2].map(()=>Promise.resolve().then(()=>
   reserveRequestCost(p,b,4096,{purpose:'build_decision'})))));
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'LLM_COST_BUDGET_EXCEEDED');
 await assert.rejects(run({...ctx},async()=>reserveRequestCost(p,b,4096)),{code:'LLM_COST_BUDGET_EXCEEDED'});
 await assert.rejects(run(ctx,async()=>reserveRequestCost(policy('1'),b,4096)),{code:'LLM_COST_POLICY_CHANGED'});
});

test('tiny fractional request costs round UP; ceiling rounds DOWN, never near-threshold overspend',async()=>{
 const p=resolveCostPolicy({...profile,llmCostInputUsdPerMillion:'0.00000000000001',
 llmCostOutputUsdPerMillion:0,llmMaxTheoreticalCostUsdPerExecution:'0.0000000000019'});
 assert.equal(p.ceiling,1n);
 const ctx=context(); assert.equal(estimateRequestCost(p,body(),4096).units,1n);
 await run(ctx,async()=>{
  reserveRequestCost(p,body(),4096);
  assert.throws(()=>reserveRequestCost(p,body(),4096),{code:'LLM_COST_BUDGET_EXCEEDED'});
 });
});

test('legacy require=false leaves common chat request behavior unchanged and needs no execution',async()=>runtime(async()=>{
 let posts=0;globalThis.fetch=async()=>{posts++;return response();};
 await chat(input,{purpose:'build_decision'});assert.equal(posts,1);
},{llmRequireCostBudget:false}));

test('missing/mismatched authoritative context, missing cap/prices and unreviewed purposes fail before POST',async()=>runtime(async()=>{
 let posts=0;globalThis.fetch=async()=>{posts++;return response();};
 await assert.rejects(chat(input,{purpose:'build_decision'}),{code:'LLM_COST_EXECUTION_REQUIRED'});
 await assert.rejects(run(context(),()=>chat(input,{taskId:'wrong',purpose:'build_decision'})),{code:'LLM_COST_EXECUTION_REQUIRED'});
 await assert.rejects(run({executionId:'x',signal:new AbortController().signal},()=>chat(input,{purpose:'build_decision'})),{code:'LLM_COST_EXECUTION_REQUIRED'});
 for(const purpose of ['action_plan','design','doctor','unspecified'])
  await assert.rejects(run(context(),()=>chat(input,{purpose})),{code:'LLM_OUTPUT_CAP_REQUIRED'});
 config.llmMaxOutputTokensBuild='';config.llmRequireOutputCap=false;
 await assert.rejects(run(context(),()=>chat(input,{purpose:'build_decision'})),{code:'LLM_COST_OUTPUT_CAP_REQUIRED'});
 config.llmCostInputUsdPerMillion='';
 await assert.rejects(run(context(),()=>chat(input,{purpose:'plan'})),{code:'LLM_COST_BUDGET_REQUIRED'});
 assert.equal(posts,0);
}));

test('execution A/B isolation and abort/stale lease: old execution cannot consume new pool',async()=>runtime(async(logs)=>{
 const a=context(),b={...context(),taskId:a.taskId},abort=new AbortController();
 a.signal=abort.signal;let posts=0;globalThis.fetch=async()=>{posts++;return response();};
 await run(a,()=>chat(input,{purpose:'build_decision'}));
 abort.abort(Object.assign(new Error('retired'),{code:'LEASE_LOST'}));
 await assert.rejects(run(a,()=>chat(input,{purpose:'build_decision'})),{code:'LEASE_LOST'});
 await run(b,()=>chat(input,{purpose:'build_decision'}));
 assert.deepEqual(logs.filter(l=>l.event==='llm.cost_admission').map(l=>l.execution_reserved_before),[0,0]);
 const stale={...context(),taskId:a.taskId,checkLease:async()=>{throw Object.assign(new Error('stale'),{code:'LEASE_LOST'});}};
 await assert.rejects(run(stale,()=>chat(input,{purpose:'build_decision'})),{code:'LEASE_LOST'});
 assert.equal(posts,2);
}));

test('cumulative real common boundary blocks exact next POST, does not refund tiny actual usage/cost',async()=>runtime(async(logs)=>{
 const ctx=context();let posts=0;
 globalThis.fetch=async()=>{posts++;return response({usage:{prompt_tokens:1,completion_tokens:1,cost:0.000001}});};
 await run(ctx,async()=>{
  await chat(input,{purpose:'build_decision'});await chat(input,{purpose:'build_decision'});
  await assert.rejects(chat(input,{purpose:'build_decision'}),{code:'LLM_COST_BUDGET_EXCEEDED'});
 });
 assert.equal(posts,2);
 const events=logs.filter(l=>l.event==='llm.cost_admission');
 assert.deepEqual(events.map(e=>e.admitted),[true,true,false]);
 assert.equal(events[1].execution_reserved_before,events[0].execution_reserved_after);
 assert.equal(events[2].execution_reserved_after,events[1].execution_reserved_after);
 assert.equal(logs.find(l=>l.event==='model.request'&&l.provider_reported_cost_usd!==null).provider_reported_cost_usd,0.000001);
},{llmMaxTheoreticalCostUsdPerExecution:'0.006'}));

test('each retry reserves again: allowed budget two POSTs, insufficient budget no second POST',async()=>{
 for(const budget of ['0.006','0.003']) await runtime(async(logs)=>{
  let posts=0;globalThis.fetch=async()=>++posts===1?new Response('transient',{status:503}):response();
  const promise=run(context(),()=>chat(input,{purpose:'build_decision'}));
  if(budget==='0.006') await promise;else await assert.rejects(promise,{code:'LLM_COST_BUDGET_EXCEEDED'});
  assert.equal(posts,budget==='0.006'?2:1);
  const events=logs.filter(l=>l.event==='llm.cost_admission');
  assert.equal(events.length,2);assert.equal(events[1].physical_attempt,2);
  assert.equal(events[1].execution_reserved_before,events[0].execution_reserved_after);
 },{llmMaxTheoreticalCostUsdPerExecution:budget});
});

test('reservation survives timeout, unknown billing, 429 rejection, 5xx and successful short output',async()=>{
 for(const kind of ['timeout','unknown','429','503','short']) await runtime(async(logs)=>{
  let posts=0;globalThis.fetch=async()=>{
   posts++;
   if(kind==='timeout')throw new DOMException('timeout','TimeoutError');
   if(kind==='429')return new Response('unpriced rejection',{status:429});
   if(kind==='503')return new Response('transient',{status:503});
   return response(kind==='short'?{usage:{prompt_tokens:1,completion_tokens:1,cost:0.000001}}:{});
  };
  await run(context(),async()=>{
   if(['timeout','429','503'].includes(kind))await assert.rejects(chat(input,{purpose:'build_decision'}));
   else await chat(input,{purpose:'build_decision'});
   await assert.rejects(chat(input,{purpose:'build_decision'}),{code:'LLM_COST_BUDGET_EXCEEDED'});
  });
  assert.equal(posts,1);
  assert.ok(logs.filter(l=>l.event==='llm.cost_admission').slice(1).every(l=>l.execution_reserved_before>0));
 },{llmMaxTheoreticalCostUsdPerExecution:'0.003'});
});

test('Memory shares Build ledger; insufficient Memory admission is auxiliary warning, no separate pool',async()=>runtime(async(logs)=>{
 let posts=0;globalThis.fetch=async()=>{posts++;return response();};
 const ctx=context();await run(ctx,async()=>{
  await chat(input,{purpose:'build_decision'});
  await extractMemories({userId:'u',projectId:'p',userPrompt:'tiny',summary:'done',taskId:ctx.taskId});
 });
 assert.equal(posts,1);
 const rejected=logs.find(l=>l.event==='llm.cost_admission'&&!l.admitted);
 assert.equal(rejected.purpose,'memory_extraction');assert.ok(rejected.execution_reserved_before>0);
 assert.ok(logs.some(l=>l.event==='memory.extract.failed'&&l.auxiliary===true));
},{llmMaxTheoreticalCostUsdPerExecution:'0.003'}));

test('actual concurrent common requests admit exactly one POST when only one reservation fits',async()=>runtime(async(logs)=>{
 let posts=0;globalThis.fetch=async()=>{posts++;return response();};
 const ctx=context();
 const results=await run(ctx,()=>Promise.allSettled([chat(input,{purpose:'build_decision'}),chat(input,{purpose:'build_decision'})]));
 assert.equal(posts,1);assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
 assert.equal(results.find(r=>r.status==='rejected').reason.code,'LLM_COST_BUDGET_EXCEEDED');
 assert.equal(logs.filter(l=>l.event==='llm.cost_admission'&&l.admitted).length,1);
},{llmMaxTheoreticalCostUsdPerExecution:'0.003'}));

test('real doctor direct inference exit fails before timedFetch, even if caps/reasoning otherwise permit it',async()=>{
 const source=readFileSync(new URL('../src/doctor.js',import.meta.url),'utf8');
 const start=source.indexOf('async function checkLlm('),end=source.indexOf('\nasync function checkDaytona',start);
 assert.ok(start>=0&&end>start);
 let posts=0,failures=[];
 const settings={...profile,llmMaxOutputTokens:4096,llmRequireReasoningPolicy:false};
 const execute=new Function('config','providerProblems','resolveProvider','assertUnbudgetedOperatorInferenceAllowed',
  'timedFetch','skip','bad','ok','buildConfiguredRequestBody','requestHeaders','console',
  source.slice(start,end)+'\nreturn checkLlm;')(settings,()=>[],()=>({model:'offline',url:'https://offline.invalid',requiresKey:false}),
  assertUnbudgetedOperatorInferenceAllowed,async()=>{posts++;throw new Error('must not POST');},
  ()=>{},message=>failures.push(message),()=>{},()=>({}),()=>({}),{log:()=>{}});
 await execute({provider:'openrouter',llmKeyName:'OFFLINE'});
 assert.equal(posts,0);assert.match(failures.join(),/explicit cost-authorized execution/);
 assert.doesNotThrow(()=>assertUnbudgetedOperatorInferenceAllowed({}));
});

test('smoke common inference has no implicit operator budget; required mode fails before provider POST',async()=>runtime(async()=>{
 const {runSmoke}=await import('../src/smoke-llm.js');
 let posts=0;globalThis.fetch=async()=>{posts++;return response();};
 await assert.rejects(runSmoke(),{code:'LLM_COST_EXECUTION_REQUIRED'});assert.equal(posts,0);
}));

test('budget-blocked attempts do not inflate physical provider-request/usage-missing metrics',async()=>runtime(async()=>{
 let posts=0;globalThis.fetch=async()=>{posts++;return response({usage:{prompt_tokens:1,completion_tokens:1}});};
 const ctx=context(),metrics=createTaskMetrics({id:ctx.taskId,execution_id:ctx.executionId});
 await withTaskMetrics(metrics,()=>run(ctx,async()=>{
  await chat(input,{purpose:'build_decision'});
  await assert.rejects(chat(input,{purpose:'build_decision'}),{code:'LLM_COST_BUDGET_EXCEEDED'});
 }));
 assert.equal(posts,1);assert.equal(metrics.model_request_count,1);
 assert.equal(metrics.model_success_count,1);assert.equal(metrics.model_failure_count,0);
 assert.equal(metrics.usage_missing_count,0);assert.equal(metrics.logical_model_turn_count,2);
},{llmMaxTheoreticalCostUsdPerExecution:'0.003'}));

test('equivalent decimal spelling keeps one execution policy; optional disabled zero budget is valid',async()=>{
 assert.equal(resolveCostPolicy({llmRequireCostBudget:false,llmMaxTheoreticalCostUsdPerExecution:'0'}).budgetUsd,0);
 const ctx=context();
 await run(ctx,async()=>{
  const first=reserveRequestCost(policy('0.10'),body(),4096);
  const equivalent=resolveCostPolicy({...profile,llmCostInputUsdPerMillion:'0.2',llmCostOutputUsdPerMillion:'4.7e-1',
    llmMaxTheoreticalCostUsdPerExecution:'0.1'});
  const second=reserveRequestCost(equivalent,body(),4096);
  assert.equal(second.execution_reserved_before,first.execution_reserved_after);
 });
});


test('budget refusal explains Forge cumulative exposure in Chinese and retains exact hard ceiling',async()=>{
 for(const currency of ['CNY','USD']) {
  const settings=currency==='CNY'?{llmRequireCostBudget:true,llmCostCurrency:'CNY',llmCostInputPerMillion:'0.8',llmCostOutputPerMillion:'2.7',llmMaxTheoreticalCostPerExecution:'0.000001'}:{...profile,llmMaxTheoreticalCostUsdPerExecution:'0.000001'};
  const p=resolveCostPolicy(settings);
  await run(context(),async()=>{
   assert.throws(()=>reserveRequestCost(p,body(),4096),error=>{
    assert.equal(error.code,'LLM_COST_BUDGET_EXCEEDED');
    assert.match(error.message,/Forge 本次执行的模型预算保护/);
    assert.match(error.message,/不是供应商余额不足/);
    assert.match(error.message,/该请求尚未发送/);
    assert.match(error.message,/不是实际扣费/);
    assert.ok(error.message.includes(currency+' 0.000001'));
    assert.equal(error.budgetSetting,currency==='CNY'?'LLM_MAX_THEORETICAL_COST_PER_EXECUTION':'LLM_MAX_THEORETICAL_COST_USD_PER_EXECUTION');
    assert.equal(error.costAdmission.admitted,false);
    assert.equal(error.costAdmission.execution_reserved_after,0);
    return true;
   });
  });
 }
});
