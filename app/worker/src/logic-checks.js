import {fingerprint,sha256,sourceManifest,normalizeSourcePath} from './managed-source.js';
const quote=value=>"'"+String(value).replaceAll("'","'\"'\"'")+"'";
export const LOGIC_GUIDANCE = '【核心规则检查】有明确业务规则时，把可独立测试的核心逻辑拆成纯函数 .mjs 模块；可在 src/ 下添加 *.test.mjs，并用根目录 forge.checks.json 显式启用，例如 {"version":1,"tests":["src/rules.test.mjs"]}；使用 node:test 和 node:assert/strict，覆盖已知成功流程、边界及关键数据不变量。测试只使用内存纯函数，不读写文件、不联网、不启动进程或定时后台任务。游戏应检查合法初始数据、移动/计分规则和完成条件；关卡应有已知可完成样例；标准推箱子还应断言箱子数=目标数、玩家恰好一个、已知推法能胜利、未完成时不能胜利。静态展示无需额外测试。检查是功能验收的补充，不能替换或降低已确认的 acceptance。';
export const LOGIC_RUNNER_SOURCE=String.raw`
const {spawnSync}=require('node:child_process');
const paths=JSON.parse(process.argv[1]);
const env={...process.env,FORCE_COLOR:'0',NODE_DISABLE_COLORS:'1'};
delete env.NODE_TEST_CONTEXT; // A controlled standalone run must not inherit a parent test-runner IPC context.
const child=spawnSync(process.execPath,['--test','--test-reporter=tap',...paths],{
 encoding:'utf8',timeout:8000,maxBuffer:262144,env});
const stdout=child.stdout||'',stderr=child.stderr||'';
const count=name=>Number([...stdout.matchAll(new RegExp('^# '+name+' (\\d+)\\s*$','gm'))].at(-1)?.[1]||0);
const tests=count('tests'),passed=count('pass'),failed=count('fail'),skipped=count('skipped');
let status=child.status===0&&tests>0&&passed===tests?'passed':child.status===0?'inconclusive':/code: ['"]ERR_ASSERTION['"]/.test(stdout)?'failed':'tool_error';
// Buffer overflow or externally killed children are also unconfirmed side effects.
const timedOut=Boolean(child.error||child.signal);
if(child.error||child.signal)status='tool_error';
console.log('__FORGE_LOGIC__'+JSON.stringify({status,tests,passed,failed,skipped,timedOut,
 details:status==='passed'?'':(stdout+'\n'+stderr+(child.error?'\n'+child.error.code:'')).slice(-2500)}));
`;
export const LOGIC_CONFIG='forge.checks.json';
export function logicTestPaths(files){
 const file=files.find(f=>f.path===LOGIC_CONFIG);if(!file)return [];
 let config;try{config=JSON.parse(file.content);}catch{throw new Error('forge.checks.json 不是有效 JSON');}
 if(config?.version!==1||!Array.isArray(config.tests)||!config.tests.length||config.tests.length>20)
  throw new Error('forge.checks.json 需要 version=1 和 1-20 个明确的测试路径');
 const paths=config.tests.map(p=>{
  if(typeof p!=='string'||!p.startsWith('src/')||!p.endsWith('.test.mjs')||normalizeSourcePath(p)!==p||!files.some(f=>f.path===p))
   throw new Error('forge.checks.json 包含不受支持或不存在的测试路径');
  return p;
 });
 if(new Set(paths).size!==paths.length)throw new Error('forge.checks.json 测试路径不可重复');
 return paths.sort();
}
export function logicFingerprint(files){return fingerprint({recipe:sha256(LOGIC_RUNNER_SOURCE),code_hash:sourceManifest(files).code_hash});}
export function logicEvidenceValid(files,evidence){
 try{return !logicTestPaths(files).length||evidence?.fingerprint===logicFingerprint(files)&&['passed','inconclusive'].includes(evidence.status);}
 catch{return false;}
}
export async function runLogicChecks({sandbox,sandboxId,files}){
 let paths;try{paths=logicTestPaths(files);}catch(error){return {status:'tool_error',fingerprint:logicFingerprint(files),details:error.message};}
 if(!paths.length)return null;
 const identity=logicFingerprint(files);
 if(paths.length>20)return {status:'tool_error',fingerprint:identity,details:'纯逻辑测试文件超过 20 个的受控上限'};
 const r=await sandbox.exec(sandboxId,'node -e '+quote(LOGIC_RUNNER_SOURCE)+' '+quote(JSON.stringify(paths)),{timeoutMs:15000});
 let out;
 try{
  const line=String(r.stdout||'').split('\n').find(l=>l.startsWith('__FORGE_LOGIC__'));
  out=JSON.parse(line.slice('__FORGE_LOGIC__'.length));
  if(r.exitCode!==0||!['passed','failed','inconclusive','tool_error'].includes(out.status)||!['tests','passed','failed','skipped'].every(k=>Number.isSafeInteger(out[k])&&out[k]>=0))throw Error();
 }catch{return {status:'tool_error',fingerprint:identity,timedOut:!!r.timedOut,details:'纯逻辑测试未返回可靠结果'};}
 return {...out,timedOut:!!r.timedOut||out.timedOut===true,fingerprint:identity};
}
/** Supplemental evidence never upgrades HTTP/unknown browser results to fully verified. */
export function mergeLogicResult(result,logic){
 if(!logic)return result;
 const merged={...result,logicChecks:logic,base:result.base?{...result.base,blocking:[...(result.base.blocking||[])],warnings:[...(result.base.warnings||[])]}:null};
 if(logic.status==='failed'){
  if(result.kind!=='tool_error')merged.kind='blocker';
  merged.base ||= {blocking:[],warnings:[]};merged.base.blocking.push(`核心纯逻辑断言失败（${logic.failed} 项）：${logic.details||''}`);
 }else if(logic.status==='tool_error'){
  if(result.kind!=='blocker')merged.kind='tool_error';
  merged.toolError='纯逻辑检查无法完成：'+logic.details;
 }else if(logic.status==='inconclusive'){
  if(result.kind==='passed')merged.kind='success_with_warnings';
  merged.base ||= {blocking:[],warnings:[]};merged.base.warnings.push('未执行有效的纯逻辑测试，不能宣称规则已验证');
 }
 return merged;
}
