/** Operational DB identity/TLS only. Env is explicit and file-only; no credentials fallback. */
import {readFileSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {X509Certificate} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {Client} from 'pg';
export const operationalRoot=fileURLToPath(new URL('../../../',import.meta.url));
const targets={main:{ref:'vfzyimhapttcdxeabvur',file:'.env.main-cutover',db:'MAIN_DATABASE_URL',ca:'MAIN_CA_FILE'},restore:{ref:'zynvesyeqsoeqssgwubj',file:'.env.main-restore',db:'RESTORE_DATABASE_URL',ca:'RESTORE_CA_FILE'}};
const fail=code=>{throw Object.assign(new Error(),{code});};
export function operationalConfig(target,{source,root=operationalRoot}={}) {
 const t=targets[target];if(!t)fail('OPERATIONAL_TARGET_INVALID');
 source??=readFileSync(path.join(root,'app/worker',t.file),'utf8');const env=parseEnv(source);
 for(const k of [t.db,t.ca])if(!env[k]||(source.match(new RegExp('^\\s*'+k+'\\s*=','gm'))||[]).length!==1)fail('OPERATIONAL_CONFIG_MISSING_OR_DUPLICATE');
 const u=new URL(env[t.db]);const direct=/^db\.([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname)?.[1];
 const user=decodeURIComponent(u.username),tenant=/\.([a-z0-9]{20})$/.exec(user)?.[1];
 const ref=direct||(/\.pooler\.supabase\.com$/.test(u.hostname)?tenant:null);
 if(!['postgres:','postgresql:'].includes(u.protocol)||!u.password||ref!==t.ref||(tenant&&tenant!==ref)||u.hash)fail('OPERATIONAL_TARGET_REF_MISMATCH');
 if(!['','/postgres'].includes(u.pathname))fail('OPERATIONAL_DATABASE_INVALID');
 for(const k of u.searchParams.keys())if(k!=='sslmode')fail('UNSUPPORTED_CONNECTION_OPTION');
 if(u.searchParams.has('sslmode')&&!['require','verify-full','verify-ca'].includes(u.searchParams.get('sslmode')))fail('TLS_REQUIRED');
 u.searchParams.delete('sslmode');
 return {target,ref,file:t.file,caPath:path.resolve(root,env[t.ca]),databaseUrl:u.toString()};
}
export async function operationalConnect(target) {
 const config=operationalConfig(target);const ca=readFileSync(config.caPath,'utf8');const cert=new X509Certificate(ca);
 if(!cert.ca||Date.parse(cert.validTo)<=Date.now())fail('OPERATIONAL_CA_INVALID');
 const db=new Client({connectionString:config.databaseUrl,ssl:{ca,rejectUnauthorized:true},connectionTimeoutMillis:12000,query_timeout:20000,options:'-c lock_timeout=5000 -c statement_timeout=15000',application_name:'forge-stage-a-readonly'});
 if(db.connectionParameters.ssl?.rejectUnauthorized!==true||db.connectionParameters.ssl?.ca!==ca)fail('TLS_CONFIGURATION_OVERRIDDEN');
 db.on('error',()=>{});try{await db.connect();if(db.connection.stream.authorized!==true||db.connection.stream.encrypted!==true)fail('TLS_NOT_VERIFIED');await db.query('BEGIN TRANSACTION READ ONLY');}catch(e){await db.end().catch(()=>{});throw e;}
 return {db,config};
}
