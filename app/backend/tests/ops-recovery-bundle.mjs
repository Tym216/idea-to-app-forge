/** T0 DB truth and legacy physical source remain separate, integrity-bound recovery components. */
import {readFileSync,writeFileSync,mkdirSync,copyFileSync,chmodSync} from 'node:fs';import {createHash} from 'node:crypto';import path from 'node:path';import {pathToFileURL} from 'node:url';
import {operationalRoot} from './ops-db-target.mjs';import {sourceManifest,sourceDiff,fingerprint} from '../../worker/src/managed-source.js';
export const recoveryIdentity={main_ref:'vfzyimhapttcdxeabvur',restore_ref:'zynvesyeqsoeqssgwubj',project_id:'93a2f63a-9ec6-4194-b962-4e68dbeea80d',task_id:'e0d9c783-7de6-4a02-a219-50a24b7e55c5',sandbox_id:'9394813e-2d8d-4ccf-8642-5c9e95e0f570'};
export const fileHash=p=>createHash('sha256').update(readFileSync(p)).digest('hex');
const load=p=>JSON.parse(readFileSync(p,'utf8'));
const put=(p,v)=>writeFileSync(p,JSON.stringify(v,null,2)+'\n',{flag:'wx',mode:0o600});
const core=m=>{const {bundle_hash,...rest}=m;return rest;};
export function prepareAttachment(directory,preservationDir=path.join(operationalRoot,'app/worker/.cutover/stage-b-2026-10-08')){
 const physicalFile=path.join(preservationDir,'paused-source/physical-manifest.json'),dbFile=path.join(preservationDir,'paused-source/db-manifest.json'),resultFile=path.join(preservationDir,'paused-preservation-result.json');
 const physical=load(physicalFile),db=load(dbFile),result=load(resultFile),canonical=sourceManifest(physical.manifest.files),dbCanonical=sourceManifest(db.files);
 const diff=sourceDiff(dbCanonical,canonical),lock=canonical.files.find(f=>f.path==='package-lock.json');
 if(!physical.complete||canonical.code_hash!==physical.manifest.code_hash||dbCanonical.code_hash!==db.code_hash||dbCanonical.files.length!==10||canonical.files.length!==11||physical.resources.length||diff.length!==1||diff[0].path!=='package-lock.json'||diff[0].before_hash!==null||!lock||result.final_state!=='archived'||result.lifecycle_cleanup!=='PASS'||result.project_id!==recoveryIdentity.project_id||result.task_id!==recoveryIdentity.task_id||result.sandbox_id!==recoveryIdentity.sandbox_id)throw new Error('SIDECAR_PRESERVATION_CONTRACT_MISMATCH');
 mkdirSync(directory,{mode:0o700});const dir=path.join(directory,'paused-legacy');mkdirSync(dir,{mode:0o700});
 for(const [src,dst] of [[physicalFile,'physical-manifest.json'],[dbFile,'db-manifest.json'],[resultFile,'preservation-result.json']]){copyFileSync(src,path.join(dir,dst));chmodSync(path.join(dir,dst),0o600);}
 writeFileSync(path.join(dir,'package-lock.json'),lock.content,{flag:'wx',mode:0o600});put(path.join(dir,'identity.json'),recoveryIdentity);
 const names=['db-manifest.json','identity.json','package-lock.json','physical-manifest.json','preservation-result.json'];
 const manifest={version:1,recovery_set_id:path.basename(directory),identity:recoveryIdentity,db_source:{files:10,code_hash:dbCanonical.code_hash,authority:'Main ita_files persistent fact'},legacy_physical_source:{files:11,code_hash:canonical.code_hash,extras:[{path:lock.path,bytes:lock.bytes,hash:lock.hash}],disposition:'preserved sidecar only; not DB source or automatic workspace reconciliation'},paused_disposition:{automatic_resume:false,automatic_absorption:false,manual_resume_policy:'separate Main cutover/unfreeze blocker; requires explicit decision'},database_backup_ref:{manifest_relative_path:'../manifest.json',recovery_set_id:path.basename(directory)},files:Object.fromEntries(names.map(n=>[n,fileHash(path.join(dir,n))]))};
 manifest.bundle_hash=fingerprint(manifest);put(path.join(dir,'attachment-manifest.json'),manifest);return validateAttachment(directory);
}
export function validateAttachment(directory){
 const dir=path.join(directory,'paused-legacy'),m=load(path.join(dir,'attachment-manifest.json'));
 if(m.version!==1||fingerprint(core(m))!==m.bundle_hash||fingerprint(m.identity)!==fingerprint(recoveryIdentity)||m.recovery_set_id!==path.basename(directory)||m.database_backup_ref?.recovery_set_id!==m.recovery_set_id||m.database_backup_ref?.manifest_relative_path!=='../manifest.json')throw new Error('SIDECAR_MANIFEST_MISMATCH');
 const required=['db-manifest.json','identity.json','package-lock.json','physical-manifest.json','preservation-result.json'];
 if(fingerprint(Object.keys(m.files).sort())!==fingerprint(required.sort()))throw new Error('SIDECAR_PAYLOAD_INCOMPLETE');
 for(const n of required)if(fileHash(path.join(dir,n))!==m.files[n])throw new Error('SIDECAR_CONTENT_HASH_MISMATCH');
 const p=load(path.join(dir,'physical-manifest.json')),db=load(path.join(dir,'db-manifest.json')),actual=sourceManifest(p.manifest.files),dbActual=sourceManifest(db.files),diff=sourceDiff(dbActual,actual);
 if(actual.code_hash!==m.legacy_physical_source.code_hash||dbActual.code_hash!==m.db_source.code_hash||actual.files.length!==11||dbActual.files.length!==10||diff.length!==1||diff[0].path!=='package-lock.json'||fileHash(path.join(dir,'package-lock.json'))!==diff[0].after_hash||dbActual.files.some(f=>f.path==='package-lock.json'))throw new Error('SIDECAR_SOURCE_BASIS_MISMATCH');
 return {relative_path:'paused-legacy/attachment-manifest.json',manifest_sha256:fileHash(path.join(dir,'attachment-manifest.json')),bundle_hash:m.bundle_hash,recovery_set_id:m.recovery_set_id,db_code_hash:dbActual.code_hash,physical_code_hash:actual.code_hash,db_files:10,physical_files:11};
}
export function sealRecovery(directory){
 const attachment=validateAttachment(directory),db=load(path.join(directory,'manifest.json'));
 if(db.version!==2||db.recovery_set_id!==attachment.recovery_set_id||db.paused_db_source?.files!==10||db.paused_db_source?.code_hash!==attachment.db_code_hash||db.paused_db_source?.legacy_lockfile_in_db!==false||db.source_ref!==recoveryIdentity.main_ref||db.target_ref!==recoveryIdentity.restore_ref||fingerprint(db.recovery_attachment)!==fingerprint(attachment))throw new Error('DB_SIDECAR_CROSS_REFERENCE_MISMATCH');
 for(const [n,h] of Object.entries(db.archives))if(!/^[a-z-]+\.(dump|list|sql)$/.test(n)||fileHash(path.join(directory,n))!==h)throw new Error('DB_ARCHIVE_HASH_MISMATCH');
 const m={version:1,recovery_set_id:attachment.recovery_set_id,identity:recoveryIdentity,database:{relative_path:'manifest.json',manifest_sha256:fileHash(path.join(directory,'manifest.json')),archives:db.archives},legacy_attachment:attachment,rollback_requires:['T0 database backup validated by real restore','legacy physical-source sidecar content/hash validated'],paused_task_final_disposition:'independent blocker; not resumed/cancelled/reconciled'};
 m.bundle_hash=fingerprint(m);put(path.join(directory,'recovery-manifest.json'),m);return validateRecovery(directory);
}
export function validateRecovery(directory){
 const m=load(path.join(directory,'recovery-manifest.json'));if(fingerprint(core(m))!==m.bundle_hash||fingerprint(m.identity)!==fingerprint(recoveryIdentity))throw new Error('RECOVERY_BUNDLE_HASH_MISMATCH');
 const attachment=validateAttachment(directory),db=load(path.join(directory,'manifest.json'));
 if(db.version!==2||db.recovery_set_id!==attachment.recovery_set_id||db.paused_db_source?.files!==10||db.paused_db_source?.code_hash!==attachment.db_code_hash||db.paused_db_source?.legacy_lockfile_in_db!==false||m.database.relative_path!=='manifest.json'||fileHash(path.join(directory,'manifest.json'))!==m.database.manifest_sha256||fingerprint(m.legacy_attachment)!==fingerprint(attachment)||fingerprint(db.recovery_attachment)!==fingerprint(attachment)||db.source_ref!==recoveryIdentity.main_ref||db.target_ref!==recoveryIdentity.restore_ref||fingerprint(db.archives)!==fingerprint(m.database.archives))throw new Error('RECOVERY_CROSS_REFERENCE_MISMATCH');
 for(const [n,h] of Object.entries(m.database.archives))if(!/^[a-z-]+\.(dump|list|sql)$/.test(n)||fileHash(path.join(directory,n))!==h)throw new Error('DB_ARCHIVE_HASH_MISMATCH');
 return {status:'PASS',recovery_set_id:m.recovery_set_id,recovery_bundle_hash:m.bundle_hash,db_manifest_sha256:m.database.manifest_sha256,sidecar_bundle_hash:attachment.bundle_hash,db_files:10,physical_files:11,source_ref:recoveryIdentity.main_ref,target_ref:recoveryIdentity.restore_ref};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){try{const a=process.argv.slice(2),dir=path.resolve(a[a.indexOf('--directory')+1]),base=path.join(operationalRoot,'app/worker/.cutover/backups')+path.sep;if(!dir.startsWith(base))throw new Error('PRIVATE_RECOVERY_DIRECTORY_REQUIRED');const mode=a[a.indexOf('--mode')+1];const r=mode==='prepare'?prepareAttachment(dir):mode==='seal'?sealRecovery(dir):mode==='verify'?validateRecovery(dir):null;if(!r)throw new Error('RECOVERY_MODE_REQUIRED');console.log(JSON.stringify({mode,status:'PASS',...r}));}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||e.message||'RECOVERY_BUNDLE_FAILED'}));process.exitCode=1;}}
