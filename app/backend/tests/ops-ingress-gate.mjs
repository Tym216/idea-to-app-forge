/** Temporary operational ACL gate. No workspace authority, task state or Phase 2 schema changes. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import path from 'node:path';
import {parseEnv} from 'node:util';
import {Client} from 'pg';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const qi=s=>'"'+String(s).replaceAll('"','""')+'"';
const qr=r=>r==='PUBLIC'?'PUBLIC':qi(r);
const roles=['PUBLIC','anon','authenticated'];
// Explicit RLS read dependency, not a volatility/security-definer capability heuristic.
export const READ_ONLY_POLICY_HELPERS=Object.freeze(['public.ita_owns_project(uuid)']);
export const isPolicyHelperGrant=g=>g.kind==='function'&&g.schema==='public'&&g.name==='ita_owns_project'&&g.signature==='p_project_id uuid';
export async function assertPolicyDependencies(db) {
 const dependencies=(await db.query(`select distinct nf.nspname schema,p.proname name,pg_get_function_identity_arguments(p.oid) signature
 from pg_policy pol join pg_class c on c.oid=pol.polrelid join pg_namespace n on n.oid=c.relnamespace
 join pg_depend d on d.classid='pg_policy'::regclass and d.objid=pol.oid and d.refclassid='pg_proc'::regclass
 join pg_proc p on p.oid=d.refobjid join pg_namespace nf on nf.oid=p.pronamespace
 where n.nspname='public' and c.relname ~ '^ita_' and nf.nspname<>'pg_catalog' order by 1,2,3`)).rows;
 for(const d of dependencies)if(!(d.schema==='auth'&&d.name==='uid'&&d.signature==='')&&!isPolicyHelperGrant({...d,kind:'function'}))throw Object.assign(new Error(),{code:'UNREVIEWED_POLICY_HELPER'});
 return dependencies;
}
export async function assertPolicyHelperPrivileges(db) {
 const checks=(await db.query(`select to_regprocedure('public.ita_owns_project(uuid)') is not null present,
 has_function_privilege('authenticated','public.ita_owns_project(uuid)','EXECUTE') authenticated,
 has_function_privilege('service_role','public.ita_owns_project(uuid)','EXECUTE') service_role,
 has_function_privilege('anon','public.ita_owns_project(uuid)','EXECUTE') anon`)).rows[0];
 if(!checks?.present||!checks.authenticated||!checks.service_role||checks.anon)throw Object.assign(new Error(),{code:'POLICY_HELPER_EXECUTE_MISMATCH'});
 return checks;
}
export async function connectOperational(target,{ackMain=false}={}) {
 if(target==='disposable'){const {connect,cfg}=await import('./cutover-real-common.mjs');return {db:await connect(),ref:cfg.projectRef};}
 if(target!=='main'||!ackMain)throw Object.assign(new Error(),{code:'MAIN_MAINTENANCE_ACK_REQUIRED'});
 const e=parseEnv(readFileSync(path.join(root,'app/worker/.env.main-cutover'),'utf8'));
 if(!e.MAIN_DATABASE_URL||!e.MAIN_CA_FILE)throw Object.assign(new Error(),{code:'MAIN_DB_OR_CA_MISSING'});
 const u=new URL(e.MAIN_DATABASE_URL),ref='vfzyimhapttcdxeabvur';
 const direct=/^db\.([a-z0-9]{20})\.supabase\.co$/.exec(u.hostname)?.[1];
 const tenant=/\.([a-z0-9]{20})$/.exec(decodeURIComponent(u.username))?.[1];
 if(!['postgres:','postgresql:'].includes(u.protocol)||(direct||(/\.pooler\.supabase\.com$/.test(u.hostname)?tenant:null))!==ref)throw Object.assign(new Error(),{code:'MAIN_DB_REF_MISMATCH'});
 if(u.searchParams.has('sslmode')&&!['require','verify-full','verify-ca'].includes(u.searchParams.get('sslmode')))throw Object.assign(new Error(),{code:'TLS_REQUIRED'});
 u.searchParams.delete('sslmode');
 const ca=readFileSync(path.resolve(root,e.MAIN_CA_FILE),'utf8');
 const db=new Client({connectionString:u.toString(),ssl:{ca,rejectUnauthorized:true},connectionTimeoutMillis:12000,query_timeout:15000,options:'-c lock_timeout=5000 -c statement_timeout=12000',application_name:'forge-operational-gate'});
 if(db.connectionParameters.ssl?.rejectUnauthorized!==true||db.connectionParameters.ssl?.ca!==ca)throw Object.assign(new Error(),{code:'TLS_CONFIGURATION_OVERRIDDEN'});
 db.on('error',()=>{});await db.connect();if(db.connection.stream.authorized!==true)throw Object.assign(new Error(),{code:'TLS_NOT_VERIFIED'});
 return {db,ref};
}
export async function captureIngress(db,ref) {
 const query=`with objects as (
 select n.nspname schema,c.relname name,null::text col,c.relacl acl from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname ~ '^ita_'
 union all select n.nspname,c.relname,a.attname,a.attacl from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname ~ '^ita_' and a.attnum>0 and not a.attisdropped)
 select o.schema,o.name,o.col,case when a.grantee=0 then 'PUBLIC' else r.rolname end grantee,a.privilege_type privilege,a.is_grantable grantable,null::text signature,'table' kind
 from objects o cross join lateral aclexplode(case when array_ndims(o.acl)=1 then o.acl else null end) a left join pg_roles r on r.oid=a.grantee
 where (a.grantee=0 or r.rolname in ('anon','authenticated')) and a.privilege_type in ('INSERT','UPDATE','DELETE')
 union all select n.nspname,p.proname,null,case when a.grantee=0 then 'PUBLIC' else r.rolname end,a.privilege_type,a.is_grantable,pg_get_function_identity_arguments(p.oid),'function'
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join lateral aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a left join pg_roles r on r.oid=a.grantee
 where n.nspname='public' and p.proname ~ '^ita_' and (a.grantee=0 or r.rolname in ('anon','authenticated')) and a.privilege_type='EXECUTE'
 order by kind,name,col,grantee,privilege`;
 const grants=(await db.query(query)).rows;
 for(const g of grants)if(g.kind==='table'&&(['ita_files','ita_snapshots','ita_changesets'].includes(g.name)||(g.name==='ita_projects'&&(/^(workspace_|checkpoint_id$)/.test(g.col||'')||(!g.col&&['INSERT','UPDATE'].includes(g.privilege))))))throw Object.assign(new Error(),{code:'BASELINE_CLIENT_SOURCE_GRANT_DRIFT'});
 return {version:1,ref,captured_at:new Date().toISOString(),grants};
}
export function gateSQL(snapshot,restore=false) {
 if(snapshot.version!==1||!['dfixexlufeyrdublqcxu','vfzyimhapttcdxeabvur'].includes(snapshot.ref))throw new Error('GATE_SNAPSHOT_INVALID');
 return snapshot.grants.filter(g=>restore||!isPolicyHelperGrant(g)).map(g=>{
  if(g.schema!=='public'||!/^ita_[a-z0-9_]+$/.test(g.name)||!roles.includes(g.grantee)||!['INSERT','UPDATE','DELETE','EXECUTE'].includes(g.privilege))throw new Error('GATE_SCOPE_INVALID');
  if(g.kind==='table'){const badTable=['ita_files','ita_snapshots','ita_changesets'].includes(g.name);const badAuthority=g.name==='ita_projects'&&(/^(workspace_|checkpoint_id$)/.test(g.col||'')||(!g.col&&['INSERT','UPDATE'].includes(g.privilege)));if(badTable||badAuthority)throw new Error('GATE_SOURCE_GRANT_FORBIDDEN');}
  const object=g.kind==='function'?`FUNCTION ${qi(g.schema)}.${qi(g.name)}(${g.signature})`:`TABLE ${qi(g.schema)}.${qi(g.name)}`;
  const priv=g.privilege+(g.col?` (${qi(g.col)})`:'');
  return restore?`GRANT ${priv} ON ${object} TO ${qr(g.grantee)}${g.grantable?' WITH GRANT OPTION':''};`:`REVOKE ${priv} ON ${object} FROM ${qr(g.grantee)};`;
 }).join('\n');
}
export async function verifyFrozen(db) {
 await assertPolicyDependencies(db);await assertPolicyHelperPrivileges(db);
 const violations=(await db.query(`select r.rolname,c.relname object from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join pg_roles r
 where n.nspname='public' and c.relkind='r' and c.relname ~ '^ita_' and r.rolname in ('anon','authenticated')
 and (has_table_privilege(r.oid,c.oid,'INSERT,UPDATE,DELETE') or has_any_column_privilege(r.oid,c.oid,'INSERT,UPDATE'))
 union all select r.rolname,p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace cross join pg_roles r
 where n.nspname='public' and p.proname ~ '^ita_' and r.rolname in ('anon','authenticated') and p.oid<>'public.ita_owns_project(uuid)'::regprocedure and has_function_privilege(r.oid,p.oid,'EXECUTE')`)).rows;
 if(violations.length)throw Object.assign(new Error('Remaining client write privileges'),{code:'INGRESS_NOT_FROZEN'});
 return {client_write_grants:0,client_mutation_rpc_execute:0,read_grants_preserved:true,read_only_policy_helpers:READ_ONLY_POLICY_HELPERS};
}
export async function freezeIngress(db,snapshot) {
 await db.query('BEGIN');try{await assertPolicyDependencies(db);await assertPolicyHelperPrivileges(db);for(const sql of gateSQL(snapshot).split('\n').filter(Boolean))await db.query(sql);await verifyFrozen(db);await db.query('COMMIT');}
 catch(e){await db.query('ROLLBACK');throw e;}
}
export async function unfreezeIngress(db,snapshot) {
 await db.query('BEGIN');try{for(const sql of gateSQL(snapshot,true).split('\n').filter(Boolean))await db.query(sql);const after=await captureIngress(db,snapshot.ref);if(JSON.stringify(after.grants)!==JSON.stringify(snapshot.grants))throw Object.assign(new Error(),{code:'UNFREEZE_ACL_MISMATCH'});await db.query('COMMIT');}
 catch(e){await db.query('ROLLBACK');throw e;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href) {
 const args=process.argv.slice(2),value=n=>{const i=args.indexOf(n);if(i<0||!args[i+1]||args[i+1].startsWith('--'))throw Object.assign(new Error(),{code:'CLI_ARGUMENT_REQUIRED'});return args[i+1];};let db;
 try {
  const target=value('--target'),mode=value('--mode'),file=path.resolve(value('--snapshot'));
  const c=await connectOperational(target,{ackMain:args.includes('--ack-main-maintenance')});db=c.db;
  let snapshot;
  if(mode==='capture') {
   snapshot=await captureIngress(db,c.ref);mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
   writeFileSync(file,JSON.stringify(snapshot,null,2),{flag:'wx',mode:0o600});
   writeFileSync(file+'.freeze.sql',gateSQL(snapshot),{flag:'wx',mode:0o600});writeFileSync(file+'.unfreeze.sql',gateSQL(snapshot,true),{flag:'wx',mode:0o600});
  }else{snapshot=JSON.parse(readFileSync(file,'utf8'));if(snapshot.ref!==c.ref)throw new Error('GATE_TARGET_MISMATCH');}
  if(mode==='freeze')await freezeIngress(db,snapshot);
  else if(mode==='verify'||mode==='canary-only')await verifyFrozen(db);
  else if(mode==='unfreeze')await unfreezeIngress(db,snapshot);
  else if(mode!=='capture')throw new Error('GATE_MODE_INVALID');
  console.log(JSON.stringify({mode,target,ref:c.ref,status:'PASS',canary_channel:mode==='canary-only'?'trusted DB administrator executes existing business commands; client mutation EXECUTE remains closed; explicit RLS read helper retained':undefined}));
 }catch(e){console.log(JSON.stringify({status:'FAIL',error_type:typeof e.code==='string'?e.code:'OPERATIONAL_GATE_ERROR'}));process.exitCode=1;}
 finally{if(db)await db.end();}
}
