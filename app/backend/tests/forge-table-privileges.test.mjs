/** Offline SQL regression with Supabase-style default ALL table ACLs, not an approximate production migration. */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync,readdirSync} from 'node:fs';
import {assertForgeTablePrivileges} from './forge-table-privileges.mjs';

test('formal 0001→0006 removes platform table-management grants, preserves Worker row DML/RPC, excludes non-Forge tables',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create schema auth;create table auth.users(id uuid primary key,email text);
   create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
   create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   grant usage on schema auth to anon,authenticated,service_role;grant select on auth.users to anon,authenticated,service_role;
   grant execute on function auth.uid() to anon,authenticated,service_role;
   alter default privileges in schema public grant all on tables to service_role;
   create table public.itax_non_forge(id integer);`);
  for(const f of ['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0005_preview_recovery.sql'])await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const before=(await db.query("select has_table_privilege('service_role','public.ita_files','TRUNCATE') allowed")).rows[0];assert.equal(before.allowed,true,'platform default ACL fixture must expose the old gap');
  for(const f of readdirSync(new URL('../migrations/',import.meta.url)).filter(f=>/^\d{4}_.+\.sql$/.test(f)&&f>='0006_').sort())await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const scan=await assertForgeTablePrivileges(db);assert.ok(scan.tables>=14);
  for(const privilege of ['TRUNCATE','TRIGGER','REFERENCES'])assert.equal((await db.query("select has_table_privilege('service_role','public.itax_non_forge',$1) allowed",[privilege])).rows[0].allowed,true,'non-Forge grants must remain unchanged');
  const currentDefaults=(await db.query("select has_table_privilege('service_role','public.itax_non_forge','TRUNCATE') allowed")).rows[0];assert.equal(currentDefaults.allowed,true);
  const u='11111111-1111-1111-1111-111111111111',p='22222222-2222-2222-2222-222222222222',s='33333333-3333-3333-3333-333333333333';
  await db.query('insert into auth.users values($1,$2)',[u,'fixture@example.invalid']);
  await db.query('insert into public.ita_projects(id,user_id,name) values($1,$2,$3)',[p,u,'fixture']);
  // Owner synthetic checkpoint validates DELETE row guard vs TRUNCATE guard; no claim of real app verification.
  await db.query("insert into public.ita_snapshots(id,project_id,user_id,files,kind) values($1,$2,$3,'{}','checkpoint')",[s,p,u]);
  await assert.rejects(db.query('delete from public.ita_snapshots where id=$1',[s]),/CHECKPOINT_IMMUTABLE/);
  await db.exec('set role service_role');
  try{
   for(const table of ['ita_files','ita_snapshots','ita_projects','ita_changesets','ita_tasks','ita_plans'])await assert.rejects(db.exec('truncate public.'+table),/permission denied/);
   await db.query('update public.ita_projects set name=$1 where id=$2',['allowed metadata',p]);
   await db.query("insert into public.ita_messages(project_id,user_id,role,content) values($1,$2,'assistant','fixture')",[p,u]);
   assert.equal((await db.query('select count(*)::int n from public.ita_files')).rows[0].n,0);
   await db.query('select public.ita_purge_audit_log(90)');
  }finally{await db.exec('reset role');}
  for(const name of ['ita_claim_task','ita_worker_update_task','ita_worker_save_plan','ita_workspace_commit','ita_complete_build_checkpoint','ita_complete_project_deletion'])assert.equal((await db.query("select bool_and(has_function_privilege('service_role',oid,'EXECUTE')) allowed from pg_proc where proname=$1",[name])).rows[0].allowed,true);
  // Ordinary row mutation and FK cascade remain legal: table-management grants are not needed by RPC callers.
  await db.query('delete from public.ita_projects where id=$1',[p]);
  assert.equal((await db.query('select count(*)::int n from public.ita_snapshots')).rows[0].n,0);
  // A future table brought in by platform defaults must fail until its own migration hardens it.
  await db.exec('create table public.ita_future_privilege_probe(id integer)');
  await assert.rejects(assertForgeTablePrivileges(db),/management privilege bypass/);
 }finally{await db.close();}
});
