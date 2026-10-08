/** Strictly read-only. No restore, truncation, auth changes or migration. */
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';
import {writeFileSync,mkdirSync} from 'node:fs';import path from 'node:path';
let db;
try{
 const c=await operationalConnect('restore');db=c.db;
 const identity=(await db.query("select current_database() database,current_setting('server_version') server_version,pg_backend_pid() backend_pid,current_setting('transaction_read_only') read_only")).rows[0];
 const schema=(await db.query("select (select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p'))::int public_tables,(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^ita_')::int forge_functions,(select count(*) from auth.users)::int auth_users,(select count(*) from storage.objects)::int storage_objects")).rows[0];
 const extensions=(await db.query('select extname,extversion from pg_extension order by extname')).rows;
 const risky=(await db.query("select (select count(*) from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal)::int custom_public_triggers")).rows[0];
 const status=schema.public_tables===0&&schema.forge_functions===0&&schema.auth_users===0&&schema.storage_objects===0?'PASS':'FAIL';
 const result={stage:'restore target read-only preflight',status,project_name:'forge-main-restore-test',project_ref:c.config.ref,distinct_from_main:true,tls_verified:true,certificate_verification:true,ca_path:c.config.caPath,identity,schema,extensions,...risky,restore_executed:false,overwrite_scope:'empty Forge/public application + Auth data; managed Supabase schemas must be preserved by restore recipe'};
 const dir=path.join(operationalRoot,'app/worker/.cutover/stage-a-2026-10-08');mkdirSync(dir,{recursive:true,mode:0o700});writeFileSync(path.join(dir,'restore-preflight.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));
 if(status!=='PASS')process.exitCode=1;
}catch(e){console.log(JSON.stringify({stage:'restore target preflight',status:'FAIL',error_type:typeof e.code==='string'?e.code:'RESTORE_PREFLIGHT_ERROR'}));process.exitCode=1;}
finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
