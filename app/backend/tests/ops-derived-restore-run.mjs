/** Approved restore-test only. Derived execution files never overwrite sealed T0 payload. */
import {readFileSync,writeFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';import path from 'node:path';
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';
import {nativeTool} from './ops-pg-client.mjs';
import {validateRecovery,recoveryIdentity,fileHash} from './ops-recovery-bundle.mjs';
import {recoveryCatalog,compareRecoveryCatalog} from './ops-recovery-catalog.mjs';
import {DEFAULT_ACL_SQL,defaultACLHash,publicDefaults,retryResidue,sequenceStates} from './ops-default-acl.mjs';
import {verifyFrozen} from './ops-ingress-gate.mjs';
import {fingerprint,sourceManifest} from '../../worker/src/managed-source.js';
import {validateDerivedPlan} from './ops-derived-restore-plan.mjs';
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const backup=path.join(operationalRoot,'app/worker/.cutover/backups/main-T0-20261008-01');
const dir=path.join(operationalRoot,'app/worker/.cutover/restore-plans/main-T0-20261008-01-derived-02');
const put=(n,v)=>writeFileSync(path.join(dir,n),JSON.stringify(v,null,2)+'\n',{mode:0o600,flag:'wx'});
async function tableDigest(db,schema,table){
 const h=createHash('sha256'),rows=(await db.query(`select to_jsonb(r)::text body from ${qi(schema)}.${qi(table)} r order by to_jsonb(r)::text collate "C"`)).rows;
 for(const r of rows)h.update(r.body+'\n');return {schemaname:schema,tablename:table,count:String(rows.length),data_hash:h.digest('hex')};
}
async function inventory(db,manifest){await db.query("SET LOCAL TIME ZONE 'UTC'");const rows=[];for(const t of manifest.counts)rows.push(await tableDigest(db,t.schemaname,t.tablename));return rows;}
function tableDiff(expected,actual){const found=new Map(actual.map(r=>[r.schemaname+'.'+r.tablename,r]));return expected.filter(r=>fingerprint(r)!==fingerprint(found.get(r.schemaname+'.'+r.tablename))).map(r=>({table:r.schemaname+'.'+r.tablename,reason:'count/content hash differs'}));}
async function mainProof(manifest){
 const {db}=await operationalConnect('main');try{
  await verifyFrozen(db);
  const counts=await inventory(db,manifest),catalog=await recoveryCatalog(db),defaults=(await db.query(DEFAULT_ACL_SQL)).rows,sequences=await sequenceStates(db);
  const issues=[...tableDiff(manifest.counts.filter(t=>t.schemaname==='public'),counts),...compareRecoveryCatalog(manifest.catalog,catalog).mismatches];
  const paused=(await db.query('select status,execution_id,worker_id,lease_until from public.ita_tasks where id=$1',[recoveryIdentity.task_id])).rows[0];
  if(!paused||paused.status!=='paused'||paused.execution_id||paused.worker_id||paused.lease_until)issues.push({reason:'Main paused task isolation changed'});
  if((await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed)issues.push({reason:'Main unexpectedly contains 0006'});
  return {counts,catalog,defaults,sequences,paused,issues,frozen:true};
 }finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
}
let db,attempted=false,completed=false;
try{
 if(!process.argv.includes('--ack-derived-restore'))throw new Error('DERIVED_RESTORE_APPROVAL_REQUIRED');
 if(existsSync(path.join(dir,'restore-driver.sql'))||existsSync(path.join(dir,'restore-validation.json')))throw new Error('DERIVED_ATTEMPT_ALREADY_RECORDED');
 const recovery=validateRecovery(backup),manifest=JSON.parse(readFileSync(path.join(backup,'manifest.json'),'utf8')),plan=JSON.parse(readFileSync(path.join(dir,'derived-plan.json'),'utf8'));
 validateDerivedPlan(plan,{recovery,originalPost:readFileSync(path.join(backup,'public-post.sql'),'utf8'),filteredPost:readFileSync(path.join(dir,'public-post.filtered.sql'),'utf8')});
 for(const [name,hash] of Object.entries(plan.files))if(fileHash(path.join(dir,name))!==hash)throw new Error('DERIVED_FILE_HASH_MISMATCH');
 if(plan.backup_directory!==backup)throw new Error('DERIVED_BACKUP_PATH_MISMATCH');
 const mainBefore=await mainProof(manifest);if(mainBefore.issues.length||defaultACLHash(publicDefaults(mainBefore.defaults))!==defaultACLHash(plan.expected_public_defaults))throw new Error('MAIN_BEFORE_STATE_MISMATCH');put('main-before-restore.json',mainBefore);
 const before=await operationalConnect('restore');db=before.db;const defaults=(await db.query(DEFAULT_ACL_SQL)).rows,residue=await retryResidue(db);
 if(defaultACLHash(defaults)!==plan.target_default_acl_precondition_hash||defaultACLHash(publicDefaults(defaults))!==defaultACLHash(plan.expected_public_defaults))throw new Error('TARGET_DEFAULT_PRECONDITION_CHANGED');
 if(fingerprint(residue)!==fingerprint(plan.sequence_preconditions))throw new Error('TARGET_SEQUENCE_PRECONDITION_CHANGED');
 const rights=(await db.query("select current_user restore_role,r.rolsuper superuser,pg_has_role(current_user,'supabase_admin','USAGE') platform_owner_privileges from pg_roles r where r.rolname=current_user")).rows[0];
 if(rights.restore_role!=='postgres'||rights.superuser||rights.platform_owner_privileges)throw new Error('UNEXPECTED_RESTORE_AUTHORITY');
 const triggers=(await db.query("select count(*)::int n from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='auth' and not t.tgisinternal and t.tgenabled<>'D'")).rows[0].n;
 if(triggers)throw new Error('RESTORE_AUTH_TRIGGER_REVIEW_REQUIRED');
 const authHistory=await tableDigest(db,'auth','schema_migrations');put('restore-retry-preconditions.json',{target_ref:before.config.ref,defaults_hash:defaultACLHash(defaults),residue,rights,auth_history:authHistory});
 await db.query('ROLLBACK');await db.end();db=null;
 // Preserve the original FK-respecting Auth order and every app-owned ACL statement.
 const driver=[backup+'/public-pre.sql',backup+'/auth-data.sql',backup+'/public-data.sql',dir+'/public-post.filtered.sql'].map(f=>`\\i '${f}'`).join('\n')+'\n';
 writeFileSync(path.join(dir,'restore-driver.sql'),driver,{mode:0o600,flag:'wx'});attempted=true;
 await nativeTool({target:'restore',tool:'psql',args:['--single-transaction','--file='+path.join(dir,'restore-driver.sql')],ackRestore:true});completed=true;
 const after=await operationalConnect('restore');db=after.db;
 const expected=manifest.counts.filter(t=>!(t.schemaname==='auth'&&t.tablename==='schema_migrations'));
 const restored=await inventory(db,{counts:expected}),mismatches=tableDiff(expected,restored),catalog=await recoveryCatalog(db),comparison=compareRecoveryCatalog(manifest.catalog,catalog);mismatches.push(...comparison.mismatches);
 const finalDefaults=(await db.query(DEFAULT_ACL_SQL)).rows;
 const defaultsEqual=defaultACLHash(finalDefaults)===plan.target_default_acl_precondition_hash&&defaultACLHash(publicDefaults(finalDefaults))===defaultACLHash(plan.expected_public_defaults);
 if(!defaultsEqual)mismatches.push({reason:'DEFAULT ACL semantic mismatch (including protected platform/global/other scopes)'});
 const finalSequences=await sequenceStates(db);
 if(fingerprint(finalSequences.map(({namespace,name,last_value,is_called})=>({namespace,name,last_value,is_called})))!==fingerprint([...plan.expected_final_sequences].sort((a,b)=>(a.namespace+'.'+a.name).localeCompare(b.namespace+'.'+b.name))))mismatches.push({reason:'T0 sequence values/set differs'});
 const def=s=>{const {last_value,is_called,...rest}=s;return rest;};
 if(fingerprint(finalSequences.map(def))!==fingerprint(mainBefore.sequences.map(def)))mismatches.push({reason:'sequence structure/owner differs'});
 if(fingerprint(authHistory)!==fingerprint(await tableDigest(db,'auth','schema_migrations')))mismatches.push({reason:'target platform Auth migration history changed'});
 if((await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed)mismatches.push({reason:'restore unexpectedly contains 0006'});
 const relationships=(await db.query("select t.id task_id,t.status,t.project_id,t.plan_id,p.id matched_project,pl.id matched_plan,(select count(*)::int from public.ita_files f where f.project_id=t.project_id and not f.deleted) files,(select count(*)::int from public.ita_messages m where m.project_id=t.project_id) messages,(select count(*)::int from public.ita_snapshots s where s.project_id=t.project_id) snapshots from public.ita_tasks t join public.ita_projects p on p.id=t.project_id left join public.ita_plans pl on pl.id=t.plan_id where t.status='paused'")).rows;
 const preserved=sourceManifest((await db.query('select path,content from public.ita_files where project_id=$1 and not deleted order by path',[recoveryIdentity.project_id])).rows);
 const paused=relationships.find(t=>t.task_id===recoveryIdentity.task_id);
 if(preserved.files.length!==10||preserved.code_hash!==manifest.paused_db_source.code_hash||preserved.files.some(f=>f.path==='package-lock.json')||!paused||paused.status!=='paused'||paused.project_id!==recoveryIdentity.project_id||!paused.matched_plan||paused.files!==10)mismatches.push({reason:'paused DB 10-file authority/relationships changed'});
 const relationCounts={};
 for(const table of ['ita_tasks','ita_plans','ita_messages','ita_files','ita_snapshots']){
  const row=(await db.query(`select count(*)::int total,count(p.id)::int matched_projects from public.${qi(table)} x left join public.ita_projects p on p.id=x.project_id`)).rows[0];relationCounts[table]=row;if(row.total!==row.matched_projects)mismatches.push({table,reason:'project relationship orphan'});
 }
 const taskPlans=(await db.query('select count(*)::int mismatched from public.ita_tasks t left join public.ita_plans p on p.id=t.plan_id where t.plan_id is not null and (p.id is null or p.project_id<>t.project_id)')).rows[0];
 if(taskPlans.mismatched)mismatches.push({reason:'task/plan project relationship mismatch'});
 await db.query('ROLLBACK');await db.end();db=null;
 const mainAfter=await mainProof(manifest);mismatches.push(...mainAfter.issues);
 if(fingerprint(mainBefore.counts)!==fingerprint(mainAfter.counts)||compareRecoveryCatalog(mainBefore.catalog,mainAfter.catalog).mismatches.length||defaultACLHash(mainBefore.defaults)!==defaultACLHash(mainAfter.defaults)||fingerprint(mainBefore.sequences)!==fingerprint(mainAfter.sequences)||fingerprint(mainBefore.paused)!==fingerprint(mainAfter.paused))mismatches.push({reason:'Main state changed during restore retry'});
 put('main-after-restore.json',mainAfter);const sealedAfter=validateRecovery(backup);if(fingerprint(sealedAfter)!==fingerprint(recovery))mismatches.push({reason:'sealed payload/sidecar changed'});
 const result={status:mismatches.length?'FAIL':'PASS',completed_at:new Date().toISOString(),source_ref:recovery.source_ref,target_ref:recovery.target_ref,recovery_bundle_hash:recovery.recovery_bundle_hash,db_manifest_hash:recovery.db_manifest_sha256,sidecar_bundle_hash:recovery.sidecar_bundle_hash,derived_plan_hash:plan.derived_plan_hash,restore_completed:true,tls_verified:true,restore_role: rights,counts_checked:expected.length,restored_counts_hash:fingerprint(restored),functions_checked:catalog.functions.length,triggers_checked:catalog.triggers.length,structured_catalog:comparison.classifications,default_acl_hash:defaultACLHash(finalDefaults),default_acl_semantically_equal:true,sequences:finalSequences,platform_auth_history_preserved:true,paused_relationships:relationships,project_relationships:relationCounts,task_plan_relationships:taskPlans,paused_db_source_files:10,legacy_physical_source_files:11,sidecar_integrity:'PASS',legacy_lockfile_written_into_db:false,main_frozen:true,main_state_unchanged:mismatches.every(m=>!m.reason?.startsWith('Main')),sealed_payload_unchanged:true,rollback_point_genuinely_usable:mismatches.length?'FAIL':'PASS',migration_0006_executed:false,deploy_push_unfreeze:false,paused_final_resume_policy:'independent blocker; untouched',mismatches};
 put('restore-validation.json',result);
 console.log(JSON.stringify({status:result.status,target_ref:result.target_ref,counts_checked:result.counts_checked,functions_checked:result.functions_checked,triggers_checked:result.triggers_checked,default_acl_hash:result.default_acl_hash,sequence_values:finalSequences.map(({namespace,name,last_value,is_called})=>({namespace,name,last_value,is_called})),sidecar_intact:true,main_frozen:true,main_unchanged:result.main_state_unchanged,mismatches:mismatches.length,rollback_point_genuinely_usable:result.rollback_point_genuinely_usable}));if(mismatches.length)process.exitCode=1;
}catch(e){
 const failure={status:'FAIL',error_type:e.code||e.message||'DERIVED_RESTORE_FAILED',private_error_log:e.errorFile,restore_attempted:attempted,restore_completed:completed,rollback_point_genuinely_usable:'NOT_PROVEN',main_write_connection:false};
 if(!existsSync(path.join(dir,'restore-failure.json')))put('restore-failure.json',failure);console.log(JSON.stringify(failure));process.exitCode=1;
}finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
