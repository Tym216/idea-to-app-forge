import {fingerprint,verifyFingerprint,sha256} from './managed-source.js';
import {RUNNER_SOURCE,PLAYWRIGHT_VERSION,classifyResult} from './verify.js';
const dependencyPath=p=>/(^|\/)(package\.json|package-lock\.json|npm-shrinkwrap\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.npmrc|\.yarnrc(?:\.yml)?|pnpm-workspace\.yaml)$/.test(p);
const runtimePath=p=>/(^|\/)(vite\.config\.[^/]+|tsconfig(?:\.[^/]+)?\.json|index\.html)$/.test(p);
const selectedHash=(files,match)=>fingerprint(files.filter(f=>match(f.path)).map(f=>[f.path,sha256(f.content)]).sort(([a],[b])=>a.localeCompare(b)));
export function userApplyPolicy(stableFiles,targetFiles,changes=[]){
 // Immutable recorded diffs retain install/restart requirements across committed resumes.
 const touched=match=>changes.some(c=>c.before_hash!==c.after_hash&&match(c.path));
 const dependencyChanged=touched(dependencyPath)||selectedHash(stableFiles,dependencyPath)!==selectedHash(targetFiles,dependencyPath);
 const runtimeChanged=touched(runtimePath)||selectedHash(stableFiles,runtimePath)!==selectedHash(targetFiles,runtimePath);
 return {install:dependencyChanged?'REQUIRED':'SKIPPED_UNCHANGED',mode:dependencyChanged||runtimeChanged?'full':'health',
 escalationReason:dependencyChanged?'dependency_inputs_changed':runtimeChanged?'runtime_config_changed':null};
}
/** Health and feature evidence have distinct, stable identities. Never claim acceptance passed. */
export function userApplyHealthFingerprint(acceptance,buildBasis){
 return fingerprint({schema:1,mode:'user_apply_health',approvedBasis:verifyFingerprint(acceptance,{runnerHash:sha256(RUNNER_SOURCE),playwrightVersion:PLAYWRIGHT_VERSION,buildBasis}),
 runnerHash:sha256(RUNNER_SOURCE),playwrightVersion:PLAYWRIGHT_VERSION,buildBasis,checks:[]});
}
export function userApplyHealthResult(raw,acceptance){
 const health=classifyResult(raw,[]);
 if(['blocker','tool_error'].includes(health.kind))return {...health,validationMode:'health',featureChecksRun:false};
 if(!health.base||health.base.placeholder!==false||(health.base.chars<=0&&health.base.visible<3))
  return {kind:'blocker',base:health.base,items:[],validationMode:'health',featureChecksRun:false,toolError:'未确认应用实际渲染'};
 return {...health,kind:'inconclusive',validationMode:'health',featureChecksRun:false,
 items:acceptance.map(a=>({...a,status:'inconclusive',reason:'本次编辑仅验证编译、HTTP、实际渲染及 runtime；未运行功能交互检查',stepResults:[]}))};
}
