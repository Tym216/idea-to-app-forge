import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { chat } from '../src/llm.js';
import { withExecutionControl } from '../src/execution-control.js';
import { sourceManifest } from '../src/managed-source.js';
import { shellQuote } from '../src/workspace.js';
import { SCAFFOLD_FILES } from '../src/scaffold.js';
import { buildFingerprint } from '../src/managed-source.js';
import { extractMemories } from '../src/memory.js';

const profile={
 environmentId:'atoms-demo', // same stable namespace as the real Demo Worker
 llmProvider:'openrouter',llmModel:'qwen/qwen3.8-flash',llmApiKey:'offline',
 llmBaseUrl:'https://offline.invalid/v1',llmJsonMode:'off',llmTimeoutMs:120000,
 llmMaxOutputTokens:'',llmMaxOutputTokensPlan:4096,llmMaxOutputTokensMemory:1024,llmMaxOutputTokensBuild:4096,
 llmRequireOutputCap:true,llmOmitTemperature:true,llmRequireReasoningPolicy:true,
 llmReasoningEffortPlan:'none',llmReasoningEffortMemory:'none',llmReasoningEffortBuild:'none',
 llmRequireCostBudget:true,llmCostInputUsdPerMillion:'0.20',llmCostOutputUsdPerMillion:'0.47',
 llmMaxTheoreticalCostUsdPerExecution:'0.10',planProviderOptionsRaw:'{}',buildProviderOptionsRaw:'{}',
 planTemperature:0.2,buildTemperature:0.1,maxToolSteps:40,maxFixRounds:1,actionFusionEnabled:true,
 fusionMaxFiles:8,fusionMaxBytes:131072,
};
const design={
 scenario:'Customer records',style:'simple',
 layout:{type:'single-column',description:'single column'},
 colors:{background:'#F7F7F5',surface:'#FFFFFF',text:'#1F2328',textMuted:'#5B636E',
 primary:'#2F5BD3',onPrimary:'#FFFFFF',border:'#E2E4E8',danger:'#B42318',success:'#1E7F4F'},
 typography:{fontFamily:'system-ui',scale:{h1:'28px',h2:'18px',body:'16px',small:'13px'}},
 spacing:[4,8,12,16,24,32],breakpoints:{mobile:640,desktop:1024},states:['empty','hover','focus','disabled'],
};
const acceptance=[{id:'A1',action:'open app',expect:'records visible',external:false,
 steps:[{op:'expectText',selector:'main',contains:'records'}]}];
const passed={base:{blocking:[],warnings:[]},checks:[{id:'A1',status:'pass'}],screenshots:[]};

/** Link the unchanged agent.js to offline persistence/sandbox adapters.
 * executeTask, runBuild, tool pipeline, common chat, memory and completion call stay real.
 * No source on disk is rewritten, and no SDK/DB/provider operation can escape the mocks.
 */
async function fixture({pathological=false, verification=passed, budget='0.10',validationResume=false,planBusy=false,truncation=null,outputCap=4096,noOpLoop=false,logicStatus=null,httpOnly=false,bootstrapFailure=false,repairOutcome=null,persistedRepair=false}={}) {
 const prior={...config},oldFetch=globalThis.fetch,oldLogger={...logger};
 Object.assign(config,profile,{llmMaxTheoreticalCostUsdPerExecution:budget,llmMaxOutputTokensBuild:outputCap,browserVerificationEnabled:!httpOnly});
 const logs=[],files=new Map(),operations=[],events=[],changesets=[],modelRequests=[];
 const task={id:randomUUID(),project_id:'offline-project',user_id:'offline-user',execution_id:randomUUID(),
  mode:'build',operation:'agent',kind:'new',prompt:'Build the approved plan',plan_id:'offline-plan',plan_version:1,
  tool_steps:0,fix_rounds:0,steps:[]};
 if(persistedRepair)task.steps.push({tool:'verification_repair',event:'started'});
 const project={id:task.project_id,user_id:task.user_id,name:'Records',description:'Customer records',
  sandbox_id:null,checkpoint_id:null};
 const plan={id:task.plan_id,project_id:task.project_id,version:1,kind:'plan',status:'approved',
  content:{understanding:'Customer records',scope:['records'],flows:['open records'],rules:['preserve data'],
   storage:'localStorage',steps:['implement'],design:'simple',acceptance,questions:[]}};
 if(validationResume) {
  task.kind='resume';
  plan.content.acceptance=[{...acceptance[0],severity:'core',steps:[{op:'click',selector:'#toggle'},...acceptance[0].steps]}];
  for(const [path,content] of Object.entries(SCAFFOLD_FILES)) files.set(path,content);
  files.set('src/App.tsx','export default function App(){return <main>records</main>}');
 }
 if(planBusy)task.mode='plan';
 let workspace,posts=0,decisions=0,memories=0,checkpoints=0,planWrites=0,logicRuns=0;
 const sb={
  workdir:'/offline',
  async ensure(){operations.push('ensure');return {sandboxId:'offline-sandbox',alive:false};},
  async readFile(_id,path){if(!files.has(path))throw new Error('missing');return files.get(path);},
  async listFiles(){return [...files.keys()];},
  async writeFile(){operations.push('verification artifact');},
  async exec(_id,command){
   operations.push(command);
   let stdout='';
   if(command.startsWith('node -e '))stdout=JSON.stringify({nodeVersion:'offline',platform:'linux',arch:'x64',environmentHash:'fixture'});
   if(command.startsWith('curl '))stdout='200';
   if(command.includes('FORGE_HTTP_CHECK:'))stdout='FORGE_HTTP_CHECK:'+JSON.stringify({blocking:[],httpStatus:200,entryStatus:200});
   const effectiveLogic=command.includes('__FORGE_LOGIC__')&&repairOutcome==='passed'&&logicRuns++>0?'passed':logicStatus;
   if(command.includes('__FORGE_LOGIC__'))stdout='__FORGE_LOGIC__'+JSON.stringify({status:effectiveLogic,tests:1,passed:effectiveLogic==='passed'?1:0,failed:effectiveLogic==='failed'?1:0,skipped:0,details:effectiveLogic==='failed'?'ERR_ASSERTION: 2 boxes != 5 goals':'test environment failure'});
   if(command==='npm --version')stdout='10.0.0';
   if(command.startsWith('printf %s'))stdout='/offline';
   if(command.includes('echo READY'))stdout='READY';
   if(command.includes('node run.mjs spec.json'))stdout='__FORGE_VERIFY__'+JSON.stringify(verification);
   return {exitCode:0,stdout,stderr:''};
  },
  async startBackground(){operations.push('start_dev');return {commandId:'offline'};},
  async isPortListening(){return true;},async readLogs(){return '';},
  async previewUrl(){return 'https://offline.invalid/preview';},
 };
 class OfflineWorkspace {
  constructor(){workspace=this;this.state={revision:0,state:'confirmed',writer:null};this.gateway={};this.manifest=sourceManifest([...files].map(([path,content])=>({path,content})));
   if(validationResume) {
    this.state.revision=1;
    this.state.build={revision:1,workspace_revision:1,code_hash:this.manifest.code_hash,status:'passed',
     basis:buildFingerprint({nodeVersion:'offline',platform:'linux',arch:'x64',environmentHash:'fixture',npmVersion:'10.0.0',
      command:'npm run --ignore-scripts build',installCommand:'npm install --no-audit --no-fund --ignore-scripts --package-lock=true'})};
    this.state.verify={revision:1,workspace_revision:1,code_hash:this.manifest.code_hash,status:'blocker',basis:'legacy-runner',
     result:{kind:'blocker',base:{blocking:[],warnings:[],placeholder:false,chars:40,visible:12},
      items:[{...plan.content.acceptance[0],status:'blocker',reason:'locator.click: Timeout 5000ms exceeded',
       stepResults:[{index:1,op:'click',ok:false}]}]}};
   }
  }
  async read(){return this.state;}
  async initialize(){}
  async assertCurrent(rev){assert.equal(rev,this.state.revision);}
  async runtime(kind,fn){operations.push('runtime:'+kind);return fn();}
  valid(kind,basis){const e=this.state[kind];return !!e&&e.revision===this.state.revision&&e.code_hash===this.manifest.code_hash&&e.basis===basis;}
  async evidence(kind,basis,status,result){this.state[kind]={basis,status,result,revision:this.state.revision,code_hash:this.manifest.code_hash};events.push('evidence:'+kind+':'+status);}
  async apply(changes,{beforeWrite=async()=>{},onWriteSuccess=async()=>{},invalidate=()=>{},origin}={}){
    changesets.push({origin,paths:changes.map(c=>c.path)});
    if(bootstrapFailure&&origin==='scaffold')throw Object.assign(new Error('bootstrap uncertain'),{code:'WORKSPACE_UNCERTAIN'});
   let changed=false;
   for(const [i,c] of changes.entries()){
    await beforeWrite(i,c.path);const different=files.get(c.path)!==c.content;
    if(different){files.set(c.path,c.content);changed=true;}
    await onWriteSuccess(i,c,different);
   }
   if(changed){this.state.revision++;this.manifest=sourceManifest([...files].map(([path,content])=>({path,content})));invalidate();}
   return {status:'succeeded',operations:changes.map(c=>({kind:'write_file',path:c.path,status:'succeeded'})),changed};
  }
  async call(name,args){
   assert.equal(name,'ita_complete_build_checkpoint');
   assert.ok(this.valid('build',args.p_build_basis));assert.equal(this.state.build.status,'passed');
   assert.ok(this.valid('verify',args.p_verify_basis));assert.ok(['passed','success_with_warnings','inconclusive'].includes(this.state.verify.status));
   assert.equal(args.p_revision,this.state.revision);assert.equal(args.p_hash,this.manifest.code_hash);
   events.push('checkpoint');checkpoints++;return {completed:true};
  }
 }
 const db={
  admin:{rpc:async()=>{throw new Error('unexpected RPC');}},
  getProject:async()=>project,getPlan:async()=>plan,getLatestPlanVersion:async()=>1,
  listFeedback:async()=>[],ensureLease:async()=>{},
  inspectRuntimeWriter:async()=>{throw new Error('unexpected runtime recovery');},
  updateTask:async()=>{},updateProject:async()=>{},
  appendStep:async(t,step)=>t.steps.push(step),
  addMessage:async()=>{},savePlan:async()=>{planWrites++;throw new Error('unexpected Plan generation');},
  listFiles:async()=>[],getLatestPlan:async()=>null,
  getRequestedChangeSet:async()=>{throw new Error('unexpected User Apply');},
  getCheckpointSource:async()=>{throw new Error('unexpected User Apply source');},
 };
 const mem={
  loadMemories:async()=>[{scope:'project',key:'design_system',value:JSON.stringify(design)}],
  renderMemories:(await import('../src/memory.js')).renderMemories,
  upsertMemory:async()=>{throw new Error('unexpected memory write');},
  extractMemories:async(arg)=>{events.push('memory');return extractMemories(arg,{
   chat,upsertMemory:async()=>{throw new Error('unexpected upsert');},
   suggestMemory:async()=>{throw new Error('unexpected suggestion');},deleteMemory:async()=>{throw new Error('unexpected delete');},
  });},
 };
 const binding='__forgeCostFixture_'+randomUUID().replaceAll('-','');
 globalThis[binding]={db,mem,ws:{Workspace:OfflineWorkspace,shellQuote},sandbox:{getSandboxProvider:()=>sb}};
 const encodeModule=(group,names)=>'data:text/javascript;base64,'+Buffer.from(
  'const f=globalThis['+JSON.stringify(binding)+'].'+group+';\n'+names.map(n=>'export const '+n+'=f.'+n+';').join('\n')).toString('base64');
 const fakeModules={
  './supabase.js':encodeModule('db',Object.keys(db)),
  './memory.js':encodeModule('mem',Object.keys(mem)),
  './workspace.js':encodeModule('ws',['Workspace','shellQuote']),
  './sandbox/index.js':encodeModule('sandbox',['getSandboxProvider']),
 };
 const source=readFileSync(new URL('../src/agent.js',import.meta.url),'utf8').replace(
  /from '(\.[^']+)'/g,(_match,path)=>'from '+JSON.stringify(fakeModules[path]||new URL(path,new URL('../src/agent.js',import.meta.url)).href));
 for(const level of ['info','warn','error'])logger[level]=(event,data)=>logs.push({event,...data});
 globalThis.fetch=async(_url,request)=>{
  const b=JSON.parse(request.body);modelRequests.push(b);assert.equal(b.reasoning.effort,'none');
  assert.equal(Object.hasOwn(b,'temperature'),false);assert.equal(b.provider.require_parameters,true);
  const last=logs.findLast(l=>l.event==='llm.cost_admission');
  assert.ok(last.admitted);assert.ok(last.execution_reserved_after<=Number(budget));posts++;
  if(planBusy)return new Response(JSON.stringify({error:{message:'provider busy',code:429}}),{status:429});
  let output;
  if(b.max_tokens===1024){memories++;output={upsert:[],remove:[]};}
  else{
   assert.equal(b.max_tokens,outputCap);decisions++;
   output=pathological?{tool:'list_files',args:{}}:decisions===(truncation==='once'?2:1)?{
    tool:'apply_changes',args:{changes:[{operation:'write',path:'src/App.tsx',content:'export default function App(){return <main>records</main>}'}],after:'build'},
   }:{tool:'finish',args:{summary:'Customer records ready'}};
  }
  if(repairOutcome&&decisions===2&&b.max_tokens!==1024)output={tool:'apply_changes',args:{changes:[{operation:'write',path:'src/App.tsx',content:'export default function App(){return <main>records corrected</main>}'}],after:'build'}};
  if(repairOutcome==='idle'&&decisions>=2&&b.max_tokens!==1024)output={tool:'list_files',args:{}};
  if(noOpLoop&&b.max_tokens!==1024)output={tool:'write_file',args:{path:'src/levels.ts',content:'export const levels = [];'}};
  if(logicStatus&&output?.tool==='apply_changes')output.args.changes.push({operation:'write',path:'src/rules.test.mjs',content:"import {test} from 'node:test'; test('rules',()=>{});"},{operation:'write',path:'forge.checks.json',content:JSON.stringify({version:1,tests:['src/rules.test.mjs']})});
  const cut=truncation&&(truncation==='always'||decisions===1)&&b.max_tokens!==1024;
  if(cut)output={tool:'write_file',args:{path:'src/never.ts',content:'not authorized'}};
  return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(output)},finish_reason:cut?'length':'stop'}],
   usage:{prompt_tokens:1,completion_tokens:1,cost:0.000001}}));
 };
 try {
  const {executeTask}=await import('data:text/javascript;base64,'+Buffer.from(source).toString('base64'));
  const control={taskId:task.id,executionId:task.execution_id,signal:new AbortController().signal,checkLease:async()=>{}};
  let result,error;
  try{result=await withExecutionControl(control,()=>executeTask(task));}catch(e){error=e;}
  return {result,error,posts,decisions,memories,checkpoints,planWrites,logs,events,operations,task,workspace,changesets,modelRequests};
 }finally{Object.assign(config,prior);globalThis.fetch=oldFetch;Object.assign(logger,oldLogger);delete globalThis[binding];}
}

test('unchanged real 40-step Build loop stops at exact pre-HTTP budget boundary, never reaches checkpoint',async()=>{
 const f=await fixture({pathological:true});
 assert.equal(config.maxToolSteps,40);
 assert.equal(f.error?.code,'LLM_COST_BUDGET_EXCEEDED');assert.equal(f.checkpoints,0);
 assert.equal(f.memories,0);assert.ok(f.decisions>0&&f.decisions<40);
 assert.equal(f.task.tool_steps,f.decisions);
 const admitted=f.logs.filter(l=>l.event==='llm.cost_admission'&&l.admitted);
 const blocked=f.logs.find(l=>l.event==='llm.cost_admission'&&!l.admitted);
 assert.equal(f.posts,admitted.length);
 assert.ok(blocked.execution_reserved_before+blocked.request_theoretical_max_usd>0.1);
 assert.equal(blocked.execution_reserved_before,blocked.execution_reserved_after);
 assert.equal(blocked.execution_reserved_before,admitted.at(-1).execution_reserved_after);
 assert.ok(f.workspace.manifest.files.length>0);assert.equal(f.workspace.state.writer,null);
 console.log('offline-pathological-proof',JSON.stringify({initial_request:admitted[0].request_theoretical_max_usd,
  admitted_posts:f.posts,consumed_steps:f.task.tool_steps,ceiling:0.1,reserved:blocked.execution_reserved_before,
  blocked_next:blocked.request_theoretical_max_usd,blocked_post_count:0,checkpoints:f.checkpoints}));
});

test('short real executeTask Build+Memory share reservations and reach normal evidence-checked checkpoint caller',async()=>{
 const f=await fixture();assert.ifError(f.error);assert.equal(f.result.completed,true);
 assert.equal(f.decisions,2);assert.equal(f.memories,1);assert.equal(f.posts,3);assert.equal(f.checkpoints,1);
 const admissions=f.logs.filter(l=>l.event==='llm.cost_admission');
 assert.equal(admissions.length,3);
 assert.deepEqual(admissions.map(l=>l.purpose),['build_decision','build_decision','memory_extraction']);
 for(let i=1;i<3;i++)assert.equal(admissions[i].execution_reserved_before,admissions[i-1].execution_reserved_after);
 assert.ok(f.events.indexOf('checkpoint')>f.events.indexOf('memory'));
 assert.ok(f.events.includes('evidence:build:passed'));assert.ok(f.events.includes('evidence:verify:passed'));
 console.log('offline-success-proof',JSON.stringify({initial_request:admissions[0].request_theoretical_max_usd,
  posts:f.posts,reserved_total:admissions.at(-1).execution_reserved_after,purposes:admissions.map(l=>l.purpose),
  checkpoint_count:f.checkpoints,steps:f.task.tool_steps}));
});

test('bounded blocker repair and tool_error cannot checkpoint or spend Memory budget',async()=>{
 for(const verification of [{toolError:'offline verifier failure'},{...passed,base:{blocking:['runtime crash'],warnings:[]}}]){
  const f=await fixture({verification});assert.ok(['VERIFY_TOOL_ERROR','AGENT_STALLED'].includes(f.error?.code));
  assert.equal(f.checkpoints,0);assert.equal(f.memories,0);assert.equal(f.posts,verification.toolError?1:4);
 }
});

test('automation-only resume reuses valid build, performs fixed verification and checkpoints with zero LLM/source writes',async()=>{
 const f=await fixture({validationResume:true,verification:{
  base:{blocking:[],warnings:[],placeholder:false,chars:40,visible:12},
  checks:[{id:'A1',status:'fail',reason:'locator.click: Timeout 5000ms exceeded',
   stepResults:[{index:1,op:'click',ok:false,failureType:'automation_error'}]}],screenshots:[],
 }});
 assert.ifError(f.error);assert.equal(f.result.completed,true);
 assert.equal(f.posts,0);assert.equal(f.decisions,0);assert.equal(f.memories,0);assert.equal(f.checkpoints,1);
 assert.equal(f.workspace.state.revision,1);assert.equal(f.workspace.state.verify.status,'success_with_warnings');
 assert.ok(!f.events.includes('memory'));assert.ok(!f.operations.includes('start_dev'));
 assert.ok(!f.operations.some(op=>op.startsWith('npm run')||op.startsWith('npm install')));
});

test('real Plan 429: one bounded physical retry, per-request admission, no Workspace/writer or duplicate Plan write',async()=>{
 const f=await fixture({planBusy:true});
 assert.equal(f.error?.code,'LLM_PROVIDER_BUSY');assert.equal(f.posts,2);
 assert.equal(f.planWrites,0);assert.equal(f.workspace,undefined);assert.equal(f.checkpoints,0);assert.equal(f.memories,0);
 assert.equal(f.logs.filter(l=>l.event==='llm.cost_admission'&&l.admitted).length,2);
});


test('real provider normalization retains length reason; two charged truncated replies never mutate or checkpoint',async()=>{
 const f=await fixture({truncation:'always'});
 assert.equal(f.error?.code,'LLM_OUTPUT_TRUNCATED');assert.equal(f.posts,2);assert.equal(f.decisions,2);
 assert.equal(f.checkpoints,0);assert.equal(f.memories,0);
 assert.ok(!f.workspace.manifest.files.some(x=>x.path==='src/never.ts'));
 assert.equal(f.logs.filter(x=>x.event==='llm.cost_admission'&&x.admitted).length,2);
});
test('8192 output cap remains subject to admission while smaller corrected action reaches normal checkpoint',async()=>{
 const f=await fixture({truncation:'once',outputCap:8192});
 assert.equal(f.error,undefined);assert.equal(f.checkpoints,1);assert.equal(f.decisions,3);
 assert.ok(!f.workspace.manifest.files.some(x=>x.path==='src/never.ts'));
 const admitted=f.logs.filter(x=>x.event==='llm.cost_admission'&&x.admitted);
 assert.ok(admitted.every(x=>x.execution_reserved_after<=0.1));
 assert.ok(admitted.filter(x=>x.purpose==='build_decision').every(x=>x.output_upper_bound_tokens===8192));
});


test('real Agent loop stops confirmed no-op write churn after three warnings without spending all tool steps',async()=>{
 const f=await fixture({noOpLoop:true});
 assert.equal(f.error?.code,'AGENT_STALLED');assert.match(f.error.message,/没有源码变化/);
 assert.equal(f.decisions,4);assert.equal(f.checkpoints,0);assert.equal(f.memories,0);
 assert.ok(f.workspace.manifest.files.some(x=>x.path==='src/levels.ts'&&x.content==='export const levels = [];'));
 assert.equal(f.task.steps.filter(x=>x.tool==='write_file'&&x.event==='finished'&&x.code_changed===true).length,1);
});


test('supplemental core assertion failure blocks checkpoint without rewriting the successful build fact',async()=>{
 const f=await fixture({logicStatus:'failed'});assert.equal(f.error?.code,'AGENT_STALLED');assert.equal(f.checkpoints,0);assert.equal(f.memories,0);
 assert.equal(f.workspace.state.build.status,'passed');assert.equal(f.workspace.state.verify.status,'blocker');assert.equal(f.workspace.state.verify.result.logicChecks.status,'failed');
 assert.ok(f.task.steps.some(s=>s.tool==='logic_check'&&s.ok===false));
});
test('pure test tool fault cannot publish a checkpoint or be mislabeled as a code assertion',async()=>{
 const f=await fixture({logicStatus:'tool_error'});assert.equal(f.error?.code,'VERIFY_TOOL_ERROR');assert.equal(f.checkpoints,0);assert.equal(f.workspace.state.build.status,'passed');assert.equal(f.workspace.state.verify.status,'tool_error');
});
test('passing logic checks preserve HTTP-only inconclusive semantics and normal immutable checkpoint path',async()=>{
 const f=await fixture({logicStatus:'passed',httpOnly:true});assert.equal(f.error,undefined);assert.equal(f.checkpoints,1);assert.equal(f.workspace.state.verify.status,'inconclusive');assert.equal(f.workspace.state.verify.result.logicChecks.status,'passed');assert.equal(f.workspace.state.verify.result.featureChecksRun,false);
});


test('real executeTask uses one committed bootstrap and sends its accurate source context without extra model turns',async()=>{
 const f=await fixture();assert.ifError(f.error);assert.equal(f.checkpoints,1);
 const bootstrap=f.changesets.filter(c=>c.origin==='scaffold');assert.equal(bootstrap.length,1);
 assert.deepEqual(new Set(bootstrap[0].paths),new Set([...Object.keys(SCAFFOLD_FILES),'src/forge-persistence.ts','src/forge-use-app-state.ts','src/design-tokens.css']));
 const context=f.modelRequests[0].messages[1].content;
 for(const path of bootstrap[0].paths)assert.ok(context.includes('--- '+path+' ---'),path+' missing from first model context');
 assert.ok(!context.includes('(空项目,尚未生成任何业务代码)'));
 assert.equal(f.task.contextParts.initial_code,context.slice(context.indexOf('当前已有代码:')+'当前已有代码:\n'.length,context.indexOf('\n\n本轮用户需求:')).length);
 assert.equal(f.decisions,2);assert.equal(f.memories,1);assert.equal(f.planWrites,0);
});
test('unconfirmed bootstrap cannot enter the model loop, Memory or checkpoint',async()=>{
 const f=await fixture({bootstrapFailure:true});assert.equal(f.error?.code,'WORKSPACE_UNCERTAIN');
 assert.equal(f.posts,0);assert.equal(f.checkpoints,0);assert.equal(f.memories,0);assert.equal(f.changesets.length,1);
});


test('blocked logic evidence reaches persisted report and resume prompt without completing or calling Memory',async()=>{
 const f=await fixture({logicStatus:'failed',httpOnly:true,persistedRepair:true});assert.equal(f.error?.code,'VERIFY_FAILED');
 const report=f.task.steps.findLast(s=>s.tool==='verify_report').result;
 assert.equal(report.validationMode,'http');assert.equal(report.base.httpStatus,200);
 assert.equal(report.logicChecks.status,'failed');assert.equal(report.logicChecks.failed,1);
 assert.match(f.error.message,/ERR_ASSERTION/);assert.equal(f.error.verification.logicStatus,'failed');
 assert.equal(f.checkpoints,0);assert.equal(f.memories,0);assert.equal(report.items[0].status,'inconclusive');
});


test('one evidence-driven repair updates source then validates same fixed basis and checkpoints without another finish turn',async()=>{
 const f=await fixture({logicStatus:'failed',httpOnly:true,repairOutcome:'passed'});assert.ifError(f.error);
 assert.equal(f.decisions,2);assert.equal(f.memories,0);assert.equal(f.checkpoints,1);
 assert.equal(f.task.steps.filter(s=>s.tool==='verification_repair'&&s.event==='started').length,1);
 assert.equal(f.task.steps.filter(s=>s.tool==='verify_attempt').length,2);
 const reports=f.task.steps.filter(s=>s.tool==='verify_report');assert.equal(reports[0].result.kind,'blocker');assert.equal(reports[1].result.kind,'inconclusive');
 assert.equal(f.workspace.state.verify.result.logicChecks.status,'passed');
 const requests=f.modelRequests.filter(b=>b.max_tokens!==1024);
 assert.ok(requests[1].messages.some(m=>m.content.includes('ERR_ASSERTION')));
 assert.deepEqual(f.workspace.state.verify.result.items.map(i=>i.id),['A1']);
 const timing=f.logs.filter(l=>l.event==='model.request_started');assert.ok(timing[1].timeout_ms<=90000);
});
test('still-blocked second check stops rather than starting another episode, preserves successful build and no version',async()=>{
 const f=await fixture({logicStatus:'failed',httpOnly:true,repairOutcome:'failed'});
 assert.equal(f.error?.code,'VERIFY_FAILED');assert.equal(f.decisions,2);assert.equal(f.memories,0);assert.equal(f.checkpoints,0);
 assert.equal(f.task.steps.filter(s=>s.tool==='verification_repair'&&s.event==='started').length,1);
 assert.equal(f.task.steps.filter(s=>s.tool==='verify_attempt').length,2);
 assert.equal(f.workspace.state.build.status,'passed');assert.equal(f.workspace.state.verify.status,'blocker');
});
test('persisted repair admission survives resume; no automatic extra LLM after another blocker',async()=>{
 const f=await fixture({logicStatus:'failed',httpOnly:true,persistedRepair:true});
 assert.equal(f.error?.code,'VERIFY_FAILED');assert.equal(f.decisions,1);assert.equal(f.checkpoints,0);
});

test('real Agent repair has at most four additional model turns even without repeated failures',async()=>{
 const f=await fixture({logicStatus:'failed',httpOnly:true,repairOutcome:'idle'});
 assert.equal(f.error?.code,'VERIFY_REPAIR_LIMIT');assert.equal(f.decisions,5);assert.equal(f.memories,0);assert.equal(f.checkpoints,0);
 assert.equal(f.task.steps.filter(s=>s.tool==='verify_attempt').length,1);
 assert.equal(f.task.steps.filter(s=>s.tool==='verification_repair'&&s.event==='started').length,1);
});
