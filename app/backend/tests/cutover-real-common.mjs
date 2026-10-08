import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { Client } from 'pg';
import { loadCutoverConfig, safeErrorCode } from './cutover-config.mjs';
export const cfg = loadCutoverConfig();
// User-approved fresh forge-cutover-v2-test; old disposable/Main/restore are forbidden targets.
if (cfg.projectRef !== 'vtevambqlnezprpezqyf') throw Object.assign(new Error(), {code:'UNAPPROVED_DISPOSABLE_PROJECT'});
const ca = readFileSync(new URL('../../worker/.cutover/prod-ca-2021.crt',import.meta.url),'utf8');
const certificate = new X509Certificate(ca);
if (!certificate.ca || Date.parse(certificate.validTo)<=Date.now()) throw Object.assign(new Error(),{code:'CA_INVALID_OR_EXPIRED'});
export function client() {
  const c=new Client({connectionString:cfg.databaseUrl,ssl:{ca,rejectUnauthorized:true},connectionTimeoutMillis:12000,query_timeout:50000,
    application_name:'forge-disposable-cutover',options:'-c lock_timeout=5000 -c statement_timeout=45000'});
  if(c.connectionParameters.ssl?.ca!==ca||c.connectionParameters.ssl?.rejectUnauthorized!==true)throw Object.assign(new Error(),{code:'TLS_CONFIGURATION_OVERRIDDEN'});
  c.on('error',()=>{});
  return c;
}
export async function connect() {const c=client();await c.connect();if(c.connection.stream.authorized!==true)throw Object.assign(new Error(),{code:'TLS_NOT_VERIFIED'});return c;}
export const report=(step,status,evidence={})=>console.log(JSON.stringify({step,status,project_ref:cfg.projectRef,...evidence}));
export function errorInfo(e){
  let detail=String(e?.message||'');
  for(const secret of [cfg.serviceKey,cfg.anonKey,cfg.databaseUrl,decodeURIComponent(new URL(cfg.databaseUrl).password)])if(secret)detail=detail.replaceAll(secret,'[REDACTED]');
  detail=detail.replace(/eyJ[A-Za-z0-9_.-]+|sb_(?:secret|publishable)_[A-Za-z0-9_-]+|postgres(?:ql)?:\/\/\S+/g,'[REDACTED]');
  return {error_type:safeErrorCode(e),detail:detail.slice(0,220)};
}
export async function api(path,{method='GET',body,key=cfg.serviceKey,token}={}) {
  const response=await fetch(cfg.apiUrl+path,{method,headers:{apikey:key,Authorization:'Bearer '+(token||key),'Content-Type':'application/json'},
    ...(body!==undefined?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000)});
  let data;try {data=await response.json();}catch {data=null;}
  return {status:response.status,data};
}
