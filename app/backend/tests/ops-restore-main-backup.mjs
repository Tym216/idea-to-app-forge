/** Restore ONLY the approved Main T0 backup into the pinned empty restore-test. No Main connection. */
import {readFileSync,writeFileSync} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';import {nativeTool} from './ops-pg-client.mjs';
import {validateRecovery,recoveryIdentity} from './ops-recovery-bundle.mjs';
import {recoveryCatalog,compareRecoveryCatalog} from './ops-recovery-catalog.mjs';
import {sourceManifest} from '../../worker/src/managed-source.js';
const qi=s=>'"'+s.replaceAll('"','""')+'"';
let db;
try{
 const args=process.argv.slice(2);if(!args.includes('--ack-stage-b-restore'))throw Object.assign(new Error(),{code:'STAGE_B_RESTORE_APPROVAL_REQUIRED'});
 const at=args.indexOf('--directory');if(at<0||!args[at+1])throw new Error('BACKUP_DIRECTORY_REQUIRED');
 const dir=path.resolve(args[at+1]),prefix=path.join(operationalRoot,'app/worker/.cutover/backups')+path.sep;
 if(!dir.startsWith(prefix)||!/^[-\w/\.]+$/.test(dir))throw new Error('BACKUP_PRIVATE_DIRECTORY_REQUIRED');
 const recovery=validateRecovery(dir);
 const manifest=JSON.parse(readFileSync(dir+'/manifest.json','utf8'));
 if(manifest.version!==2||manifest.source_ref!=='vfzyimhapttcdxeabvur'||manifest.target_ref!=='zynvesyeqsoeqssgwubj'||manifest.source_ref===manifest.target_ref)throw new Error('RESTORE_IDENTITY_GUARD');
 const required=['public.dump','auth-data.dump','auth-order.list','public-pre.sql','public-data.sql','public-post.sql','auth-data.sql'];
 if(required.some(f=>createHash('sha256').update(readFileSync(dir+'/'+f)).digest('hex')!==manifest.archives?.[f]))throw new Error('BACKUP_HASH_MISMATCH');
 const target=await operationalConnect('restore');db=target.db;
 const n=(await db.query("select (select count(*) from pg_tables where schemaname='public')::int public_tables,(select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^ita_')::int forge_functions,(select count(*) from storage.objects)::int storage_objects,(select count(*) from storage.buckets)::int storage_buckets")).rows[0];
 if(Object.values(n).some(n=>n!==0))throw new Error('RESTORE_TARGET_NOT_EMPTY');
 const tables=(await db.query("select tablename from pg_tables where schemaname='auth' and tablename<>'schema_migrations'")).rows;
 for(const t of tables)if((await db.query(`select count(*)::int n from auth.${qi(t.tablename)}`)).rows[0].n!==0)throw new Error('RESTORE_AUTH_NOT_EMPTY');
 const triggers=(await db.query("select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and not t.tgisinternal and t.tgenabled<>'D'")).rows[0].n;
 if(triggers)throw new Error('RESTORE_AUTH_TRIGGER_REVIEW_REQUIRED');
 await db.query('ROLLBACK');await db.end();db=null;
 // One transaction; normal Auth foreign keys remain enabled. Public user triggers are post-data.
 const driver=['public-pre.sql','auth-data.sql','public-data.sql','public-post.sql'].map(f=>`\\i '${dir}/${f}'`).join('\n')+'\n';
 writeFileSync(dir+'/restore-driver.sql',driver,{mode:0o600,flag:'wx'});
 await nativeTool({target:'restore',tool:'psql',args:['--single-transaction','--file='+dir+'/restore-driver.sql'],ackRestore:true});
 const after=await operationalConnect('restore');db=after.db;
 const mismatches=[];await db.query("SET LOCAL TIME ZONE 'UTC'");
 for(const row of manifest.counts){if(row.schemaname==='auth'&&row.tablename==='schema_migrations')continue;
  const actual=(await db.query(`select count(*)::text n from ${qi(row.schemaname)}.${qi(row.tablename)}`)).rows[0].n;
  if(actual!==row.count)mismatches.push({table:row.schemaname+'.'+row.tablename,expected:row.count,actual});
  const digest=createHash('sha256'),rows=(await db.query(`select to_jsonb(r)::text body from ${qi(row.schemaname)}.${qi(row.tablename)} r order by to_jsonb(r)::text collate "C"`)).rows;
  for(const r of rows)digest.update(r.body+'\n');if(digest.digest('hex')!==row.data_hash)mismatches.push({table:row.schemaname+'.'+row.tablename,reason:'restored row/source content hash differs'});
 }
 const catalog=await recoveryCatalog(db),catalogComparison=compareRecoveryCatalog(manifest.catalog,catalog);mismatches.push(...catalogComparison.mismatches);
 const v6=(await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed;
 if(v6)mismatches.push({reason:'restore unexpectedly contains 0006'});
 const relationships=(await db.query("select t.id task_id,t.status,t.project_id,t.plan_id,p.id matched_project,pl.id matched_plan,(select count(*)::int from public.ita_files f where f.project_id=t.project_id) files,(select count(*)::int from public.ita_messages m where m.project_id=t.project_id) messages,(select count(*)::int from public.ita_snapshots s where s.project_id=t.project_id) snapshots from public.ita_tasks t join public.ita_projects p on p.id=t.project_id left join public.ita_plans pl on pl.id=t.plan_id where t.status='paused'")).rows;
 const preserved=sourceManifest((await db.query('select path,content from public.ita_files where project_id=$1 and not deleted order by path',[recoveryIdentity.project_id])).rows);
 if(preserved.files.length!==10||preserved.code_hash!==manifest.paused_db_source.code_hash||preserved.files.some(f=>f.path==='package-lock.json'))mismatches.push({reason:'paused DB authority must remain exactly the backed-up 10 files'});
 const paused=relationships.find(t=>t.task_id===recoveryIdentity.task_id);if(!paused||paused.status!=='paused'||paused.project_id!==recoveryIdentity.project_id||!paused.matched_plan||paused.files!==10)mismatches.push({reason:'paused relationships not preserved'});
 const sidecarAfter=validateRecovery(dir);if(sidecarAfter.recovery_bundle_hash!==recovery.recovery_bundle_hash)mismatches.push({reason:'sidecar/recovery integrity changed during restore'});
 const result={status:mismatches.length?'FAIL':'PASS',source_ref:manifest.source_ref,target_ref:after.config.ref,main_connected:false,main_modified:false,migration_0006_executed:false,counts_checked:manifest.counts.length-1,functions_checked:catalog.functions.length,triggers_checked:catalog.triggers.length,structured_catalog:catalogComparison.classifications,sidecar_validated:true,recovery_bundle_hash:recovery.recovery_bundle_hash,paused_db_source_files:preserved.files.length,legacy_lockfile_materialized_into_db:false,mismatches,paused_relationships:relationships,auth_migration_history_preserved:true,tls_verified:true};
 writeFileSync(dir+'/restore-validation.json',JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({status:result.status,source_ref:result.source_ref,target_ref:result.target_ref,main_connected:false,counts_checked:result.counts_checked,functions_checked:result.functions_checked,mismatches:mismatches.length}));
 if(mismatches.length)process.exitCode=1;
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||e.message||'RESTORE_FAILED',private_error_log:e.errorFile}));process.exitCode=1;}
finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
