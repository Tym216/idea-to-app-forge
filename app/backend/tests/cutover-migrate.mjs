/** Exact formal migration rehearsal. Never replay previously applied files or approximate auth schema. */
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {cfg,connect,api,report,errorInfo} from './cutover-real-common.mjs';
import {assertForgeTablePrivileges} from './forge-table-privileges.mjs';
import {createHash} from 'node:crypto';
import {writeFileSync,mkdirSync} from 'node:fs';
const names=['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0005_preview_recovery.sql','0006_workspace_contract.sql'];
let db,stage='empty_schema_guard';
try {
  db=await connect();
  const before=await db.query("select count(*)::int n from information_schema.tables where table_schema='public' and table_type='BASE TABLE'");
  assert.equal(before.rows[0].n,0,'Rehearsal requires an empty disposable public schema; no replay');
  const stale=await db.query("select (select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname ~ '^ita_')::int functions,(select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname ~ '^ita_')::int relations");
  assert.deepEqual(stale.rows[0],{functions:0,relations:0},'Fresh/reset-confirmed target must not retain old Forge functions/views/sequences');
  for(const name of names){stage=name;await db.query(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));report('migration:'+name,'PASS');}
  const privilegeInvariant=await assertForgeTablePrivileges(db);report('migration Forge privilege invariant','PASS',privilegeInvariant);
  stage='schema_protocol_inventory';
  const tables=await db.query("select relname,relrowsecurity,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and relname like 'ita_%'");
  assert.ok(tables.rows.length>10);assert.ok(tables.rows.every(t=>t.relrowsecurity&&t.relforcerowsecurity));
  for(const name of ['ita_projects','ita_tasks','ita_changesets','ita_files','ita_snapshots'])assert.ok(tables.rows.some(t=>t.relname===name));
  const rpcs=await db.query("select p.proname,p.prosecdef,p.proconfig,pg_get_function_identity_arguments(p.oid) signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'ita_workspace_%' or p.proname='ita_complete_build_checkpoint')");
  const publicRpcs=['ita_workspace_read','ita_workspace_acquire','ita_workspace_prepare','ita_workspace_result','ita_workspace_commit','ita_workspace_finish_operation','ita_workspace_reconcile','ita_workspace_reconcile_legacy','ita_workspace_evidence','ita_complete_build_checkpoint'];
  for(const name of publicRpcs){const found=rpcs.rows.filter(r=>r.proname===name);assert.equal(found.length,1);assert.equal(found[0].prosecdef,true);assert.ok(found[0].proconfig.some(c=>/^search_path=(""|)$/.test(c)));}
  const acl=await db.query("select p.proname,has_function_privilege('service_role',p.oid,'EXECUTE') service,has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated,has_function_privilege('anon',p.oid,'EXECUTE') anon from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and (p.proname like 'ita_workspace_%' or p.proname='ita_complete_build_checkpoint')");
  for(const row of acl.rows){assert.equal(row.service,publicRpcs.includes(row.proname));assert.equal(row.authenticated,false);assert.equal(row.anon,false);}
  const triggers=await db.query("select tgname,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and not t.tgisinternal");
  const immutable=triggers.rows.find(t=>t.tgname==='ita_checkpoint_immutable_trg');assert.ok(immutable&&/DELETE/.test(immutable.definition)&&/UPDATE/.test(immutable.definition));
  const counts=await db.query("select (select count(*) from public.ita_projects)::int projects,(select count(*) from public.ita_changesets)::int changesets,(select count(*) from public.ita_changesets where origin='legacy')::int legacy");
  assert.deepEqual(counts.rows[0],{projects:0,changesets:0,legacy:0});
  stage='postgrest_schema_cache';
  const probe=await api('/rest/v1/rpc/ita_workspace_read',{method:'POST',body:{p_project_id:'00000000-0000-0000-0000-000000000000',p_task_id:null,p_worker_id:'cutover-schema-check',p_execution_id:'00000000-0000-0000-0000-000000000001'}});
  assert.equal(probe.data?.code,'P0001');assert.ok(/LEASE_LOST/.test(probe.data?.message||''));
  mkdirSync(new URL('../../worker/.cutover/',import.meta.url),{recursive:true,mode:0o700});
  writeFileSync(new URL('../../worker/.cutover/fresh-migration-rehearsal.json',import.meta.url),JSON.stringify({project_ref:cfg.projectRef,fresh_public_schema:true,fresh_forge_objects:true,migrations:names.map(name=>({name,sha256:createHash('sha256').update(readFileSync(new URL('../migrations/'+name,import.meta.url))).digest('hex')})),privilegeInvariant,created_at:new Date().toISOString()},null,2),{mode:0o600});
  report('Step 1','PASS',{migrations:6,rls_force_tables:tables.rows.length,workspace_rpcs:publicRpcs.length,legacy_changesets:0,postgrest_rpc_resolution:'LEASE_LOST (expected impossible identity)',replayed_migrations:0});
}catch(e){if(db)await db.query('ROLLBACK').catch(()=>{});report('Step 1','FAIL',{stage,...errorInfo(e)});process.exitCode=1;}
finally{if(db)await db.end();}
