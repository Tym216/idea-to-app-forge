import {operationalConnect,operationalRoot} from './ops-db-target.mjs';import {writeFileSync} from 'node:fs';import path from 'node:path';
const clients=[];try{
 const [main,restore]=await Promise.all(['main','restore'].map(async t=>{const c=await operationalConnect(t);clients.push(c.db);return c;}));
 const sql="select c.relname table_name,a.attname column_name,format_type(a.atttypid,a.atttypmod) type,a.attnotnull not_null,pg_get_expr(d.adbin,d.adrelid) default_expr from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='auth' and c.relkind in ('r','p') and c.relname<>'schema_migrations' and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum";
 const a=(await main.db.query(sql)).rows,b=(await restore.db.query(sql)).rows;
 const key=r=>r.table_name+'.'+r.column_name;const am=new Map(a.map(x=>[key(x),x])),bm=new Map(b.map(x=>[key(x),x]));
 const mismatches=[];for(const x of a){const y=bm.get(key(x));if(!y||x.type!==y.type)mismatches.push({column:key(x),source_type:x.type,target_type:y?.type||null});}
 for(const y of b)if(!am.has(key(y))&&y.not_null&&!y.default_expr)mismatches.push({column:key(y),reason:'extra target NOT NULL without default'});
 const rights={};for(const c of [main,restore])rights[c.config.target]=(await c.db.query("select r.rolbypassrls bypassrls,has_function_privilege(current_user,'pg_catalog.pg_export_snapshot()','EXECUTE') export_snapshot,has_parameter_privilege(current_user,'session_replication_role','SET') replica_set from pg_roles r where r.rolname=current_user")).rows[0];
 const result={status:mismatches.length===0&&rights.main.bypassrls&&rights.main.export_snapshot&&rights.restore.bypassrls?'PASS':'FAIL',auth_tables:[...new Set(a.map(x=>x.table_name))],mismatches,rights,restore_method:'ordinary COPY; FK ordering and target insert/trigger checks are separate prerequisites',replica_mode_required:false,excluded_managed_table:'auth.schema_migrations',schema_mutated:false};
 writeFileSync(path.join(operationalRoot,'app/worker/.cutover/stage-a-2026-10-08/auth-restore-compatibility.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));if(result.status!=='PASS')process.exitCode=1;
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||'AUTH_COMPATIBILITY_CHECK_FAILED'}));process.exitCode=1;}
finally{await Promise.allSettled(clients.map(async c=>{await c.query('ROLLBACK').catch(()=>{});await c.end();}));}
