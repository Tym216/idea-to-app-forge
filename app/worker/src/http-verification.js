import {fingerprint,verifyFingerprint,sha256} from './managed-source.js';
import {PREVIEW_RUNTIME_FINGERPRINT} from './preview-platform.js';
const shellQuote = (value) => '\'' + String(value).replaceAll("'", "'\\''") + '\'';
export function browserVerificationEnabled(value = true) {
 if(value === true || value === 'true')return true;
 if(value === false || value === 'false')return false;
 throw new Error('BROWSER_VERIFICATION_ENABLED must be true or false');
}
export const HTTP_CHECK_SOURCE=String.raw`
const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),5000);
const result={blocking:[],httpStatus:null,entryStatus:null};
try {
 const url='http://127.0.0.1:5173/';
 const response=await fetch(url,{signal:controller.signal});
 result.httpStatus=response.status;
 const html=await response.text();
 if(!response.ok)result.blocking.push('HTTP '+response.status);
 else if(!/<(?:!doctype|html)\b/i.test(html)||/vite-error-overlay|Internal Server Error/i.test(html))result.blocking.push('HTTP 返回错误页或非应用 HTML');
 const scripts=[...html.matchAll(/<script[^>]+src=["']([^"']+)["']/gi)].map(m=>m[1]);
 const script=scripts.find(src=>!src.includes('/@vite/client'))||scripts[0];
 if(!result.blocking.length&&script){
  const entryUrl=new URL(script,url);
  if(entryUrl.origin!==new URL(url).origin)result.blocking.push('入口脚本不在本地服务；无法做快速检查');
  else{
   const entry=await fetch(entryUrl,{signal:controller.signal});
   result.entryStatus=entry.status;
   if(!entry.ok)result.blocking.push('入口脚本 HTTP '+entry.status);
  }
 }
} catch(e){result.blocking.push('服务请求失败: '+(e.name||'Error'));}
finally{clearTimeout(timer);}
console.log('FORGE_HTTP_CHECK:'+JSON.stringify(result));
`;
export function httpVerificationFingerprint(acceptance,buildBasis,{legacy=false}={}) {
 return fingerprint({schema:1,mode:'http_only',approvedBasis:verifyFingerprint(acceptance,{
  runnerHash:sha256(HTTP_CHECK_SOURCE),playwrightVersion:'not_used',buildBasis}),
  buildBasis,recipe:sha256(HTTP_CHECK_SOURCE),browserChecksRun:false,...(legacy?{}:{previewRuntime:PREVIEW_RUNTIME_FINGERPRINT})});
}
export async function runHttpVerification({sandbox,sandboxId,acceptance}) {
 const command='node -e '+shellQuote(HTTP_CHECK_SOURCE);
 const r=await sandbox.exec(sandboxId,command,{timeoutMs:15000});
 if(r.timedOut)return {kind:'tool_error',toolError:'HTTP 检查命令超时',timedOut:true,items:[],base:null,validationMode:'http',featureChecksRun:false};
 let http;
 try{
  const line=String(r.stdout||'').split('\n').find(x=>x.startsWith('FORGE_HTTP_CHECK:'));
  http=JSON.parse(line.slice('FORGE_HTTP_CHECK:'.length));
  if(r.exitCode!==0||!Array.isArray(http.blocking)||!http.blocking.every(x=>typeof x==='string')
   ||(!http.blocking.length&&(http.httpStatus<200||http.httpStatus>=300)))throw Error('invalid');
 }catch{return {kind:'tool_error',toolError:'HTTP 检查未返回可靠结果',items:[],base:null,validationMode:'http',featureChecksRun:false};}
 return {kind:http.blocking.length?'blocker':'inconclusive',validationMode:'http',featureChecksRun:false,browserChecksRun:false,
 base:{blocking:http.blocking,warnings:['浏览器渲染、runtime 与功能交互未检查'],httpStatus:http.httpStatus,entryStatus:http.entryStatus,renderChecked:false,runtimeChecked:false},
 items:acceptance.map(a=>({...a,status:'inconclusive',reason:'当前临时关闭浏览器验收；仅检查构建和 HTTP 服务',stepResults:[]})),screenshots:[]};
}
