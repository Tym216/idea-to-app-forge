import {test} from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,rmSync} from 'node:fs';import path from 'node:path';import os from 'node:os';import {PGlite} from '@electric-sql/pglite';
import {sourceManifest} from '../../worker/src/managed-source.js';import {prepareAttachment,validateAttachment,sealRecovery,validateRecovery,recoveryIdentity,fileHash} from './ops-recovery-bundle.mjs';import {recoveryCatalog,compareRecoveryCatalog} from './ops-recovery-catalog.mjs';
test('recovery binds the 10-file DB truth and 11-file legacy sidecar without materializing the lockfile',()=>{
 const tmp=mkdtempSync(path.join(os.tmpdir(),'forge-recovery-'));try{
  const source=path.join(tmp,'original'),directory=path.join(tmp,'T0');mkdirSync(path.join(source,'paused-source'),{recursive:true});
  const db=sourceManifest(Array.from({length:10},(_,i)=>({path:`src/file${i}.ts`,content:`export const n=${i};`}))),physical=sourceManifest([...db.files,{path:'package-lock.json',content:'{"lockfileVersion":3}\n'}]);
  writeFileSync(path.join(source,'paused-source/db-manifest.json'),JSON.stringify(db));writeFileSync(path.join(source,'paused-source/physical-manifest.json'),JSON.stringify({complete:true,manifest:physical,resources:[]}));writeFileSync(path.join(source,'paused-preservation-result.json'),JSON.stringify({project_id:recoveryIdentity.project_id,task_id:recoveryIdentity.task_id,sandbox_id:recoveryIdentity.sandbox_id,final_state:'archived',lifecycle_cleanup:'PASS'}));
  const attachment=prepareAttachment(directory,source);assert.equal(attachment.db_files,10);assert.equal(attachment.physical_files,11);assert.ok(!JSON.parse(readFileSync(path.join(directory,'paused-legacy/db-manifest.json'))).files.some(f=>f.path==='package-lock.json'));
  const mf=path.join(directory,'paused-legacy/attachment-manifest.json'),m=JSON.parse(readFileSync(mf));writeFileSync(mf,JSON.stringify(Object.fromEntries(Object.entries(m).reverse())));assert.equal(validateAttachment(directory).bundle_hash,attachment.bundle_hash,'stable core hash ignores property insertion order');
  const locked=path.join(directory,'paused-legacy/package-lock.json'),old=readFileSync(locked);writeFileSync(locked,'tampered');assert.throws(()=>validateAttachment(directory),/SIDECAR_CONTENT_HASH_MISMATCH/);writeFileSync(locked,old);
  const a=validateAttachment(directory),names=['public.dump','auth-data.dump','auth-order.list','public-pre.sql','public-data.sql','public-post.sql','auth-data.sql'];for(const n of names)writeFileSync(path.join(directory,n),'fixture '+n);
  const manifest={version:2,source_ref:recoveryIdentity.main_ref,target_ref:recoveryIdentity.restore_ref,recovery_set_id:a.recovery_set_id,recovery_attachment:a,paused_db_source:{files:10,code_hash:a.db_code_hash,legacy_lockfile_in_db:false},archives:Object.fromEntries(names.map(n=>[n,fileHash(path.join(directory,n))]))};
  writeFileSync(path.join(directory,'manifest.json'),JSON.stringify(manifest));const sealed=sealRecovery(directory);assert.equal(validateRecovery(directory).recovery_bundle_hash,sealed.recovery_bundle_hash);
  writeFileSync(path.join(directory,'public.dump'),'corrupt');assert.throws(()=>validateRecovery(directory),/DB_ARCHIVE_HASH_MISMATCH/);writeFileSync(path.join(directory,'public.dump'),'fixture public.dump');
  const before=readFileSync(path.join(directory,'manifest.json'));writeFileSync(path.join(directory,'manifest.json'),JSON.stringify({...manifest,target_ref:manifest.source_ref}));assert.throws(()=>validateRecovery(directory),/RECOVERY_CROSS_REFERENCE_MISMATCH/);writeFileSync(path.join(directory,'manifest.json'),before);
  assert.equal(validateRecovery(directory).db_files,10);assert.equal(validateRecovery(directory).physical_files,11);
 }finally{rmSync(tmp,{recursive:true,force:true});}
});
test('restore structured catalog detects function semantics, effective EXECUTE and real RLS/constraint differences',async()=>{
 const db=new PGlite();try{
  await db.exec(`create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   create table public.ita_sample(id uuid primary key,value text);alter table public.ita_sample enable row level security;alter table public.ita_sample force row level security;
   create policy own on public.ita_sample for select to authenticated using(true);
   create function public.ita_sample_read() returns int language sql stable as $$select 1$$;`);
  const baseline=await recoveryCatalog(db);assert.deepEqual(compareRecoveryCatalog(baseline,await recoveryCatalog(db)).mismatches,[]);
  await db.exec('create or replace function public.ita_sample_read() returns int language sql stable as $$select 2$$');assert.equal(compareRecoveryCatalog(baseline,await recoveryCatalog(db)).classifications.semantic,1);
  await db.exec('create or replace function public.ita_sample_read() returns int language sql stable as $$select 1$$;revoke execute on function public.ita_sample_read() from public');assert.equal(compareRecoveryCatalog(baseline,await recoveryCatalog(db)).classifications.metadata,1);
  await db.exec('alter policy own on public.ita_sample using(false);alter table public.ita_sample alter column value set not null');const c=compareRecoveryCatalog(baseline,await recoveryCatalog(db));assert.ok(c.mismatches.some(m=>m.catalog==='policies'));assert.ok(c.mismatches.some(m=>m.catalog==='columns'));assert.ok(c.mismatches.some(m=>m.catalog==='constraints'));
 }finally{await db.close();}
});
