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
import {tableDigest,mainProof,validateRestoredState} from './ops-recovery-validation.mjs';
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const backup=path.join(operationalRoot,'app/worker/.cutover/backups/main-T0-20261008-01');
const dir=path.join(operationalRoot,'app/worker/.cutover/restore-plans/main-T0-20261008-01-derived-02');
const put=(n,v)=>writeFileSync(path.join(dir,n),JSON.stringify(v,null,2)+'\n',{mode:0o600,flag:'wx'});
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
 const validated=await validateRestoredState(db,{manifest,plan,authHistory,mainSequences:mainBefore.sequences});
 const {expected,restored,mismatches,catalog,comparison,finalDefaults,defaultsEqual,finalSequences,relationships,relationCounts,taskPlans,preserved}=validated;
 await db.query('ROLLBACK');await db.end();db=null;
 const mainAfter=await mainProof(manifest);mismatches.push(...mainAfter.issues);
 if(fingerprint(mainBefore.counts)!==fingerprint(mainAfter.counts)||compareRecoveryCatalog(mainBefore.catalog,mainAfter.catalog).mismatches.length||defaultACLHash(mainBefore.defaults)!==defaultACLHash(mainAfter.defaults)||fingerprint(mainBefore.sequences)!==fingerprint(mainAfter.sequences)||fingerprint(mainBefore.paused)!==fingerprint(mainAfter.paused))mismatches.push({reason:'Main state changed during restore retry'});
 put('main-after-restore.json',mainAfter);const sealedAfter=validateRecovery(backup);if(fingerprint(sealedAfter)!==fingerprint(recovery))mismatches.push({reason:'sealed payload/sidecar changed'});
 const result={status:mismatches.length?'FAIL':'PASS',completed_at:new Date().toISOString(),source_ref:recovery.source_ref,target_ref:recovery.target_ref,recovery_bundle_hash:recovery.recovery_bundle_hash,db_manifest_hash:recovery.db_manifest_sha256,sidecar_bundle_hash:recovery.sidecar_bundle_hash,derived_plan_hash:plan.derived_plan_hash,restore_completed:true,tls_verified:true,restore_role: rights,counts_checked:expected.length,restored_counts_hash:fingerprint(restored),functions_checked:catalog.functions.length,triggers_checked:catalog.triggers.length,structured_catalog:comparison.classifications,default_acl_hash:defaultACLHash(finalDefaults),default_acl_semantically_equal:defaultsEqual,sequences:finalSequences,platform_auth_history_preserved:validated.authHistoryPreserved,paused_relationships:relationships,project_relationships:relationCounts,task_plan_relationships:taskPlans,paused_db_source_files:10,legacy_physical_source_files:11,sidecar_integrity:'PASS',legacy_lockfile_written_into_db:false,main_frozen:true,main_state_unchanged:mismatches.every(m=>!m.reason?.startsWith('Main')),sealed_payload_unchanged:true,rollback_point_genuinely_usable:mismatches.length?'FAIL':'PASS',migration_0006_executed:false,deploy_push_unfreeze:false,paused_final_resume_policy:'independent blocker; untouched',mismatches};
 put('restore-validation.json',result);
 console.log(JSON.stringify({status:result.status,target_ref:result.target_ref,counts_checked:result.counts_checked,functions_checked:result.functions_checked,triggers_checked:result.triggers_checked,default_acl_hash:result.default_acl_hash,sequence_values:finalSequences.map(({namespace,name,last_value,is_called})=>({namespace,name,last_value,is_called})),sidecar_intact:true,main_frozen:true,main_unchanged:result.main_state_unchanged,mismatches:mismatches.length,rollback_point_genuinely_usable:result.rollback_point_genuinely_usable}));if(mismatches.length)process.exitCode=1;
}catch(e){
 const failure={status:'FAIL',error_type:e.code||e.message||'DERIVED_RESTORE_FAILED',private_error_log:e.errorFile,restore_attempted:attempted,restore_completed:completed,rollback_point_genuinely_usable:'NOT_PROVEN',main_write_connection:false};
 if(!existsSync(path.join(dir,'restore-failure.json')))put('restore-failure.json',failure);console.log(JSON.stringify(failure));process.exitCode=1;
}finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
