/** Stage B only: verified ingress freeze + explicit quiescence acknowledgement. Never invoked by Stage A. */
import {writeFileSync,readFileSync,readdirSync,chmodSync} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';import {verifyFrozen} from './ops-ingress-gate.mjs';import {nativeTool} from './ops-pg-client.mjs';
import {validateAttachment,recoveryIdentity} from './ops-recovery-bundle.mjs';
import {recoveryCatalog} from './ops-recovery-catalog.mjs';
import {sourceManifest} from '../../worker/src/managed-source.js';
const sha=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const qi=s=>'"'+s.replaceAll('"','""')+'"';
let db;
try{
 const argv=process.argv.slice(2);if(!argv.includes('--ack-stage-b-quiesced'))throw Object.assign(new Error(),{code:'STAGE_B_APPROVAL_AND_QUIESCENCE_REQUIRED'});
 const i=argv.indexOf('--directory');if(i<0||!argv[i+1])throw new Error('BACKUP_DIRECTORY_REQUIRED');
 const dir=path.resolve(argv[i+1]),base=path.join(operationalRoot,'app/worker/.cutover/backups')+path.sep;
 if(!dir.startsWith(base))throw new Error('BACKUP_PRIVATE_DIRECTORY_REQUIRED');
 const c=await operationalConnect('main');db=c.db;await db.query('ROLLBACK');await db.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
 await verifyFrozen(db);
 const active=(await db.query("select (select count(*) from public.ita_tasks where status in ('queued','running'))::int tasks,(select count(*) from public.ita_preview_recoveries where status in ('queued','running'))::int preview,(select count(*) from public.ita_project_deletions where status in ('pending','running'))::int deletion")).rows[0];
 if(Object.values(active).some(n=>n!==0))throw new Error('ACTIVE_DB_WORK_REMAINS');
 if((await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed)throw new Error('BACKUP_EXPECTS_PRE_0006');
 const attachment=validateAttachment(dir);if(readdirSync(dir).some(n=>n!=='paused-legacy'))throw new Error('BACKUP_DIRECTORY_NOT_FRESH');
 const paused=(await db.query('select status,execution_id,worker_id,lease_until from public.ita_tasks where id=$1',[recoveryIdentity.task_id])).rows[0];
 const source=sourceManifest((await db.query('select path,content from public.ita_files where project_id=$1 and not deleted order by path',[recoveryIdentity.project_id])).rows);
 if(paused?.status!=='paused'||paused.execution_id||paused.worker_id||paused.lease_until||source.files.length!==10||source.code_hash!==attachment.db_code_hash)throw new Error('SIDECAR_DB_BASIS_CHANGED');
 const snapshot=(await db.query('select pg_export_snapshot() snapshot')).rows[0].snapshot;
 const tables=(await db.query("select schemaname,tablename from pg_tables where schemaname in ('public','auth') order by schemaname,tablename")).rows;
 await db.query("SET LOCAL TIME ZONE 'UTC'");
 const counts=[];
 for(const t of tables){
  const name=`${qi(t.schemaname)}.${qi(t.tablename)}`,digest=createHash('sha256');
  const rows=(await db.query(`select to_jsonb(r)::text body from ${name} r order by to_jsonb(r)::text collate "C"`)).rows;
  for(const r of rows)digest.update(r.body+'\n');
  counts.push({...t,count:String(rows.length),data_hash:digest.digest('hex')});
 }
 const catalog=await recoveryCatalog(db);
 const fk=(await db.query("select c.relname child,pc.relname parent from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class pc on pc.oid=k.confrelid join pg_namespace pn on pn.oid=pc.relnamespace where k.contype='f' and n.nspname='auth' and pn.nspname='auth'")).rows;
 const left=new Set(tables.filter(t=>t.schemaname==='auth'&&t.tablename!=='schema_migrations').map(t=>t.tablename)),order=[];
 while(left.size){const ready=[...left].filter(n=>!fk.some(f=>f.child===n&&left.has(f.parent)));if(!ready.length)throw new Error('AUTH_FK_CYCLE');for(const n of ready){order.push(n);left.delete(n);}}
 const pgargs=['--format=custom','--no-publications','--no-subscriptions',`--snapshot=${snapshot}`];
 const dumps=await Promise.allSettled([
  nativeTool({target:'main',tool:'pg_dump',args:[...pgargs,'--schema=public',`--file=${dir}/public.dump`]}),
  nativeTool({target:'main',tool:'pg_dump',args:[...pgargs,'--data-only','--schema=auth','--exclude-table=auth.schema_migrations',`--file=${dir}/auth-data.dump`]})
 ]);
 for(const r of dumps)if(r.status==='rejected')throw r.reason;
 for(const n of ['public.dump','auth-data.dump'])chmodSync(path.join(dir,n),0o600);
 const toc=(await nativeTool({target:'main',tool:'pg_restore',args:['--list',dir+'/auth-data.dump']})).result.toString();
 const lines=toc.split('\n'),data=lines.filter(l=>!l.startsWith(';')&&l.trim());
 const rank=l=>{if(/ (ENCODING|STDSTRINGS|SEARCHPATH) /.test(l))return -1;const m=/ TABLE DATA auth (\S+) /.exec(l);if(m){const r=order.indexOf(m[1]);if(r<0)throw new Error('AUTH_TOC_UNKNOWN_TABLE');return r;}if(/ SEQUENCE SET auth /.test(l))return order.length;throw new Error('AUTH_TOC_UNEXPECTED_ENTRY');};
 data.sort((a,b)=>rank(a)-rank(b));writeFileSync(dir+'/auth-order.list',lines.filter(l=>l.startsWith(';')).concat(data).join('\n'),{mode:0o600});
 for(const [file,args] of [
  ['public-pre.sql',['--section=pre-data',dir+'/public.dump']],
  ['public-data.sql',['--section=data',dir+'/public.dump']],
  ['public-post.sql',['--section=post-data',dir+'/public.dump']],
  ['auth-data.sql',['--use-list='+dir+'/auth-order.list',dir+'/auth-data.dump']]
 ]){
  const out=await nativeTool({target:'main',tool:'pg_restore',args:['--file=-',...args]});let text=out.result.toString();
  if(file==='public-pre.sql')text=text.replace(/^CREATE SCHEMA public;\r?\n/m,''); // target managed public schema already exists
  writeFileSync(dir+'/'+file,text,{mode:0o600,flag:'wx'});
 }
 const files=['public.dump','auth-data.dump','auth-order.list','public-pre.sql','public-data.sql','public-post.sql','auth-data.sql'];
 const manifest={version:2,recovery_set_id:attachment.recovery_set_id,recovery_attachment:attachment,paused_db_source:{project_id:recoveryIdentity.project_id,task_id:recoveryIdentity.task_id,files:10,code_hash:source.code_hash,legacy_lockfile_in_db:false},source_ref:c.config.ref,target_ref:'zynvesyeqsoeqssgwubj',created_at:new Date().toISOString(),shared_exported_snapshot:true,counts,catalog,auth_order:order,excluded:['auth.schema_migrations','managed Supabase schema definitions','roles/passwords','Storage binary objects','Daytona filesystem'],archives:Object.fromEntries(files.map(f=>[f,sha(path.join(dir,f))]))};
 writeFileSync(dir+'/manifest.json',JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({status:'PASS',source_ref:c.config.ref,target_ref:manifest.target_ref,directory:dir,files:files.length,main_modified:false,restore_performed:false}));
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||e.message||'BACKUP_FAILED',private_error_log:e.errorFile}));process.exitCode=1;}
finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
