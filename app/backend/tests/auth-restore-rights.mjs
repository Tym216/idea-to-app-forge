import {operationalConnect,operationalRoot} from './ops-db-target.mjs';import {writeFileSync} from 'node:fs';import path from 'node:path';
const clients=[];try{
 const c=await operationalConnect('restore');clients.push(c.db);
 const privileges=(await c.db.query("select tablename,has_table_privilege(current_user,format('%I.%I',schemaname,tablename),'INSERT') insert_allowed from pg_tables where schemaname='auth' and tablename<>'schema_migrations' order by tablename")).rows;
 const triggers=(await c.db.query("select c.relname,t.tgname,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and not t.tgisinternal and t.tgenabled<>'D'")).rows;
 const m=await operationalConnect('main');clients.push(m.db);
 const fkSQL="select c.relname child,pc.relname parent,k.conname from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class pc on pc.oid=k.confrelid join pg_namespace pn on pn.oid=pc.relnamespace where k.contype='f' and n.nspname='auth' and pn.nspname='auth' order by 1,2,3";
 const fk=(await m.db.query(fkSQL)).rows,targetFK=(await c.db.query(fkSQL)).rows;
 const fkCompatible=JSON.stringify(fk)===JSON.stringify(targetFK);
 const names=privileges.map(p=>p.tablename),left=new Set(names),sorted=[];
 while(left.size){const ready=[...left].filter(n=>!fk.some(f=>f.child===n&&left.has(f.parent)));if(!ready.length)break;for(const n of ready){left.delete(n);sorted.push(n);}}
 const result={status:privileges.every(p=>p.insert_allowed)&&triggers.length===0&&left.size===0&&fkCompatible?'PASS':'FAIL',restore_role:'postgres',auth_insert_all:privileges.every(p=>p.insert_allowed),auth_fk_compatible:fkCompatible,enabled_non_fk_auth_triggers:triggers,cyclic_auth_tables:[...left],auth_restore_order:sorted,replica_mode_required:false,method:'ordinary Auth COPY with FK topological order; public triggers created after data by pg_restore section ordering',no_privilege_bypass:true};
 writeFileSync(path.join(operationalRoot,'app/worker/.cutover/stage-a-2026-10-08/auth-normal-restore-rights.json'),JSON.stringify(result,null,2),{mode:0o600});console.log(JSON.stringify(result));if(result.status==='FAIL')process.exitCode=1;
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||'AUTH_RESTORE_RIGHTS_FAILED'}));process.exitCode=1;}
finally{await Promise.allSettled(clients.map(async c=>{await c.query('ROLLBACK').catch(()=>{});await c.end();}));}
