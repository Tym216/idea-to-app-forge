import {operationalConnect,operationalRoot} from './ops-db-target.mjs';
import {writeFileSync} from 'node:fs';import path from 'node:path';let db;
try{const c=await operationalConnect('main');db=c.db;
 const rows=(await db.query(`select distinct c.relname table_name,pol.polname policy,nf.nspname function_schema,p.proname function_name,pg_get_function_identity_arguments(p.oid) identity_arguments
 from pg_policy pol join pg_class c on c.oid=pol.polrelid join pg_namespace n on n.oid=c.relnamespace
 join pg_depend d on d.classid='pg_policy'::regclass and d.objid=pol.oid and d.refclassid='pg_proc'::regclass
 join pg_proc p on p.oid=d.refobjid join pg_namespace nf on nf.oid=p.pronamespace
 where n.nspname='public' and c.relname ~ '^ita_' order by 1,2,3,4,5`)).rows;
 const helper=(await db.query("select pg_get_functiondef('public.ita_owns_project(uuid)'::regprocedure) definition")).rows[0];
 const result={main_ref:c.config.ref,tls_verified:true,policy_dependencies:rows,helper_definition:helper.definition,main_modified:false};
 writeFileSync(path.join(operationalRoot,'app/worker/.cutover/stage-b-2026-10-08/policy-dependencies.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||'POLICY_DEPENDENCY_CHECK_FAILED'}));process.exitCode=1;}finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
