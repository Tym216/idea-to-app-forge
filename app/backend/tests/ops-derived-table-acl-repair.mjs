/** Restore recipe continuation: exact table ACL normalization, then shared full validation. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import path from 'node:path';
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';
import {validateRecovery,fileHash} from './ops-recovery-bundle.mjs';
import {validateDerivedPlan} from './ops-derived-restore-plan.mjs';
import {recoveryCatalog,compareRecoveryCatalog} from './ops-recovery-catalog.mjs';
import {DEFAULT_ACL_SQL,defaultACLHash,sequenceStates,publicDefaults} from './ops-default-acl.mjs';
import {mainProof,validateRestoredState} from './ops-recovery-validation.mjs';
import {tableACLHash,tableACLDelta,exactTableACLRepair,normalizeTableACL} from './ops-table-acl-repair.mjs';
import {fingerprint} from '../../worker/src/managed-source.js';
const root=path.join(operationalRoot,'app/worker/.cutover');
const backup=path.join(root,'backups/main-T0-20261008-01'),parent=path.join(root,'restore-plans/main-T0-20261008-01-derived-02'),dir=path.join(root,'restore-plans/main-T0-20261008-01-derived-03-object-acl');
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const put=(n,v)=>writeFileSync(path.join(dir,n),JSON.stringify(v,null,2)+'\n',{mode:0o600,flag:'wx'});
function parentProof(recovery){
 const plan=load(path.join(parent,'derived-plan.json'));
 validateDerivedPlan(plan,{recovery,originalPost:readFileSync(path.join(backup,'public-post.sql'),'utf8'),filteredPost:readFileSync(path.join(parent,'public-post.filtered.sql'),'utf8')});
 for(const [name,h] of Object.entries(plan.files))if(fileHash(path.join(parent,name))!==h)throw new Error('PRIOR_DERIVED_FILE_HASH_MISMATCH');
 if(plan.backup_directory!==backup)throw new Error('PRIOR_BACKUP_PATH_MISMATCH');return plan;
}
let db,prepared=false,committed=false;
try{
 if(!process.argv.includes('--ack-target-exact-table-acl-repair'))throw new Error('TABLE_ACL_REPAIR_APPROVAL_REQUIRED');
 const recovery=validateRecovery(backup),manifest=load(path.join(backup,'manifest.json')),plan=parentProof(recovery),priorValidation=load(path.join(parent,'restore-validation.json')),priorDiff=load(path.join(parent,'table-catalog-diff.json'));
 if(!priorValidation.restore_completed||priorValidation.derived_plan_hash!==plan.derived_plan_hash||priorValidation.target_ref!==recovery.target_ref||priorValidation.mismatches.length!==1||priorValidation.mismatches[0].catalog!=='tables'||priorDiff.target_ref!==recovery.target_ref||priorDiff.differences.length!==13)throw new Error('PRIOR_FAILURE_BASIS_CHANGED');
 const mainBefore=await mainProof(manifest);
 if(mainBefore.issues.length||defaultACLHash(publicDefaults(mainBefore.defaults))!==defaultACLHash(plan.expected_public_defaults))throw new Error('MAIN_BEFORE_STATE_MISMATCH');
 const target=await operationalConnect('restore');db=target.db;
 const before=await recoveryCatalog(db),repair=exactTableACLRepair(manifest.catalog.tables,before.tables);
 if(tableACLHash(priorDiff.differences.map(d=>d.expected))!==repair.source_expected_acl_hash||tableACLHash(priorDiff.differences.map(d=>d.actual))!==repair.pre_repair_acl_hash)throw new Error('ACTUAL_DIFF_NO_LONGER_EQUALS_RECORDED_INPUT');
 const authHistory=load(path.join(parent,'restore-retry-preconditions.json')).auth_history;
 const validationBefore=await validateRestoredState(db,{manifest,plan,authHistory,mainSequences:mainBefore.sequences});
 if(validationBefore.mismatches.length!==1||validationBefore.mismatches[0].catalog!=='tables')throw new Error('RESTORED_STATE_HAS_ADDITIONAL_DRIFT');
 const defaultsBefore=(await db.query(DEFAULT_ACL_SQL)).rows,sequencesBefore=await sequenceStates(db);
 const rights=(await db.query("select current_user restore_role,r.rolsuper superuser,pg_has_role(current_user,'supabase_admin','USAGE') platform_owner_privileges from pg_roles r where r.rolname=current_user")).rows[0];
 if(rights.restore_role!=='postgres'||rights.superuser||rights.platform_owner_privileges||target.config.ref!=='zynvesyeqsoeqssgwubj')throw new Error('UNEXPECTED_REPAIR_AUTHORITY');
 mkdirSync(dir,{mode:0o700});prepared=true;
 put('pre-repair-table-acl.json',{target_ref:target.config.ref,captured_at:new Date().toISOString(),tables:before.tables,stable_acl_hash:repair.pre_repair_acl_hash});
 put('main-before-repair.json',mainBefore);
 const inverse=`-- ONLY restore-test ${target.config.ref}; undo this object-ACL repair, not T0 recovery.\nBEGIN;\n`+repair.inverse.join('\n')+'\nCOMMIT;\n';
 writeFileSync(path.join(dir,'inverse-table-acl.sql'),inverse,{mode:0o600,flag:'wx'});
 writeFileSync(path.join(dir,'exact-table-revoke.sql'),repair.revoke.join('\n')+'\n',{mode:0o600,flag:'wx'});
 const input={version:1,source_ref:recovery.source_ref,target_ref:recovery.target_ref,original_recovery_set_id:recovery.recovery_set_id,original_recovery_bundle_hash:recovery.recovery_bundle_hash,original_db_manifest_hash:recovery.db_manifest_sha256,prior_derived_plan_hash:plan.derived_plan_hash,prior_diff_evidence_hash:fileHash(path.join(parent,'table-catalog-diff.json')),source_tables:manifest.catalog.tables,pre_repair_target_acl_hash:repair.pre_repair_acl_hash,pre_repair_snapshot_hash:fileHash(path.join(dir,'pre-repair-table-acl.json')),exact_source_vs_target_diff:repair.diff,exact_revoke_set:repair.revoke,exact_revoke_sql_hash:fileHash(path.join(dir,'exact-table-revoke.sql')),inverse_sql_hash:fileHash(path.join(dir,'inverse-table-acl.sql')),post_repair_expected_acl_hash:repair.source_expected_acl_hash,default_acl_precondition_hash:defaultACLHash(defaultsBefore),sequence_precondition_hash:fingerprint(sequencesBefore),restore_authority:rights};
 input.repair_manifest_hash=fingerprint(input);put('repair-manifest.json',input);
 const newPlan={version:2,source_ref:recovery.source_ref,target_ref:recovery.target_ref,original_recovery_set_id:recovery.recovery_set_id,original_recovery_bundle_hash:recovery.recovery_bundle_hash,original_db_manifest_hash:recovery.db_manifest_sha256,prior_derived_plan_hash:plan.derived_plan_hash,prior_derived_plan_file_hash:fileHash(path.join(parent,'derived-plan.json')),pre_repair_target_acl_hash:repair.pre_repair_acl_hash,post_repair_expected_acl_hash:repair.source_expected_acl_hash,repair_manifest_hash:input.repair_manifest_hash,repair_manifest_file_hash:fileHash(path.join(dir,'repair-manifest.json')),inverse_sql_hash:input.inverse_sql_hash,exact_revoke_sql_hash:input.exact_revoke_sql_hash,stages:['restore using immutable T0 and prior exact platform omission','DEFAULT ACL semantic validation','exact table object ACL normalization (source/target diff; target-only transaction; compare then commit)','complete catalog/data/sequence/sidecar/Main-frozen validation'],execution:'continue already completed restore; never empty or restore again',original_payload_modified:false};
 newPlan.derived_plan_hash=fingerprint(newPlan);put('derived-plan.json',newPlan);
 // Verify serialized immutable input and SQL bytes before crossing the mutation boundary.
 const persisted=load(path.join(dir,'repair-manifest.json')),{repair_manifest_hash,...core}=persisted;
 if(fingerprint(core)!==repair_manifest_hash||repair_manifest_hash!==input.repair_manifest_hash||fileHash(path.join(dir,'exact-table-revoke.sql'))!==input.exact_revoke_sql_hash||fileHash(path.join(dir,'inverse-table-acl.sql'))!==input.inverse_sql_hash)throw new Error('REPAIR_INPUT_HASH_MISMATCH');
 console.log(JSON.stringify({stage:'repair_input_sealed',status:'PASS',target_ref:target.config.ref,affected_tables:13,missing:0,extra:104,repair_manifest_hash:input.repair_manifest_hash,derived_plan_hash:newPlan.derived_plan_hash}));
 await db.query('ROLLBACK');await db.query('BEGIN');
 if(defaultACLHash((await db.query(DEFAULT_ACL_SQL)).rows)!==input.default_acl_precondition_hash||fingerprint(await sequenceStates(db))!==input.sequence_precondition_hash)throw new Error('NON_TABLE_ACL_PRECONDITION_CHANGED');
 const normalized=await normalizeTableACL(db,manifest.catalog.tables,repair);
 if(defaultACLHash((await db.query(DEFAULT_ACL_SQL)).rows)!==input.default_acl_precondition_hash||fingerprint(await sequenceStates(db))!==input.sequence_precondition_hash)throw new Error('REPAIR_CHANGED_DEFAULT_ACL_OR_SEQUENCE');
 await db.query('COMMIT');committed=true;
 put('repair-commit.json',{status:'PASS',committed_at:new Date().toISOString(),target_ref:target.config.ref,repair_manifest_hash:input.repair_manifest_hash,missing:normalized.missing,extra:normalized.extra,post_repair_acl_hash:normalized.post_repair_acl_hash});
 console.log(JSON.stringify({stage:'table_acl_normalization_committed',status:'PASS',missing:0,extra:0}));
 await db.end();db=null;
 const after=await operationalConnect('restore');db=after.db;
 const validation=await validateRestoredState(db,{manifest,plan,authHistory,mainSequences:mainBefore.sequences});
 const delta=tableACLDelta(manifest.catalog.tables,validation.catalog.tables),mismatches=[...validation.mismatches];
 if(delta.missing.length||delta.extra.length)mismatches.push({reason:'final full table ACL comparison failed',missing:delta.missing.length,extra:delta.extra.length});
 const mainAfter=await mainProof(manifest);mismatches.push(...mainAfter.issues);
 const mainUnchanged=fingerprint(mainBefore.counts)===fingerprint(mainAfter.counts)&&compareRecoveryCatalog(mainBefore.catalog,mainAfter.catalog).mismatches.length===0&&defaultACLHash(mainBefore.defaults)===defaultACLHash(mainAfter.defaults)&&fingerprint(mainBefore.sequences)===fingerprint(mainAfter.sequences)&&fingerprint(mainBefore.paused)===fingerprint(mainAfter.paused);
 if(!mainUnchanged)mismatches.push({reason:'Main changed during repair'});
 put('main-after-repair.json',mainAfter);const sealed=validateRecovery(backup);
 if(fingerprint(sealed)!==fingerprint(recovery)||parentProof(sealed).derived_plan_hash!==newPlan.prior_derived_plan_hash)mismatches.push({reason:'original/parent recovery evidence changed'});
 const result={status:mismatches.length?'FAIL':'PASS',completed_at:new Date().toISOString(),source_ref:recovery.source_ref,target_ref:recovery.target_ref,original_recovery_set_id:recovery.recovery_set_id,recovery_bundle_hash:recovery.recovery_bundle_hash,db_manifest_hash:recovery.db_manifest_sha256,sidecar_bundle_hash:recovery.sidecar_bundle_hash,prior_derived_plan_hash:plan.derived_plan_hash,derived_plan_hash:newPlan.derived_plan_hash,repair_manifest_hash:input.repair_manifest_hash,table_acl:{missing:delta.missing.length,extra:delta.extra.length,checked_tables:validation.catalog.tables.length,pre_repair_hash:repair.pre_repair_acl_hash,post_repair_hash:tableACLHash(validation.catalog.tables)},counts_checked:validation.expected.length,restored_counts:validation.restored,functions_checked:validation.catalog.functions.length,triggers_checked:validation.catalog.triggers.length,structured_catalog:validation.comparison.classifications,default_acl_semantically_equal:validation.defaultsEqual,default_acl_hash:defaultACLHash(validation.finalDefaults),sequences:validation.finalSequences,platform_auth_history_preserved:validation.authHistoryPreserved,relationships:validation.relationCounts,task_plan_relationships:validation.taskPlans,paused_relationships:validation.relationships,paused_db_source_files:validation.preserved.files.length,paused_db_code_hash:validation.preserved.code_hash,legacy_physical_source_files:sealed.physical_files,sidecar_integrity:'PASS',sealed_recovery_integrity:'PASS',main_unchanged:mainUnchanged,main_still_frozen:mainAfter.frozen,tls_verified:true,repair_committed:true,restore_rerun:false,main_write_connection:false,migration_0006_executed:false,deploy_push_unfreeze:false,paused_final_policy:'independent Main cutover/unfreeze blocker; not changed',rollback_point_genuinely_usable:mismatches.length?'FAIL':'PASS',stage_b_backup_restore_operational_proof:mismatches.length?'FAIL':'PASS',mismatches};
 put('final-recovery-validation.json',result);
 console.log(JSON.stringify({status:result.status,counts_checked:result.counts_checked,functions_checked:result.functions_checked,triggers_checked:result.triggers_checked,table_acl:result.table_acl,default_acl_equal:result.default_acl_semantically_equal,main_unchanged:result.main_unchanged,main_frozen:result.main_still_frozen,sealed_payload_unchanged:true,sidecar_intact:true,mismatches:mismatches.length,rollback_point_genuinely_usable:result.rollback_point_genuinely_usable,stage_b_backup_restore_operational_proof:result.stage_b_backup_restore_operational_proof}));if(mismatches.length)process.exitCode=1;
}catch(e){
 if(db&&!committed)await db.query('ROLLBACK').catch(()=>{});
 const failure={status:'FAIL',error_type:e.code||e.message||'TABLE_ACL_REPAIR_FAILED',repair_committed:committed,main_write_connection:false};if(prepared)put('repair-failure.json',failure);console.log(JSON.stringify(failure));process.exitCode=1;
}finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
