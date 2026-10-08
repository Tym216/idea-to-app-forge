import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {cfg,connect,api,report,errorInfo} from './cutover-real-common.mjs';
import {assertForgeTablePrivileges,FORGE_TABLE_PRIVILEGE_SQL} from './forge-table-privileges.mjs';
import {identity,fixture,rpc,okApi,userOptions,deleteFixture,denied} from './cutover-fixture.mjs';
let db,stage='auth_fixture';const users=[];let f,other;
try {
  db=await connect();users.push(await identity(),await identity());
  f=await fixture(users[0]);other=await fixture(users[1],'other-owner protocol fixture');
  stage='table_management_privileges';
  const invariant=await assertForgeTablePrivileges(db);
  const forgeTables=[...new Set((await db.query(FORGE_TABLE_PRIVILEGE_SQL)).rows.map(r=>r.table_name))];
  await db.query('BEGIN');
  try {
    await db.query('SET LOCAL ROLE service_role');
    for(const table of forgeTables) {
      await db.query('SAVEPOINT truncate_probe');
      try {
        await db.query('TRUNCATE TABLE public."'+table.replaceAll('"','""')+'"');
        await db.query('ROLLBACK TO SAVEPOINT truncate_probe');
        assert.fail('service_role TRUNCATE was allowed: '+table);
      } catch(e) {
        await db.query('ROLLBACK TO SAVEPOINT truncate_probe');
        assert.equal(e.code,'42501','TRUNCATE must fail by privilege, not FK/trigger side effects: '+table);
      }
    }
  } finally { await db.query('ROLLBACK'); }
  report('Forge table management invariant','PASS',{...invariant,actual_truncate_denied_tables:forgeTables.length,sqlstate:'42501',denial:'privilege; all probes rolled back'});
  stage='source_privileges';
  for(const [role,options] of [['service_role',{}],['authenticated',userOptions(users[0])],['anon',{key:cfg.anonKey,token:cfg.anonKey}]]) {
    const base='/rest/v1/ita_files';
    for(const [method,path,body] of [['POST',base,{project_id:f.projectId,user_id:users[0].id,path:'bypass.ts',content:'bad'}],['PATCH',base+'?project_id=eq.'+f.projectId,{content:'bad'}],['DELETE',base+'?project_id=eq.'+f.projectId,undefined]])
      await denied(path,{method,body,...options},role+' direct source '+method);
  }
  stage='authority_privileges';
  const fields={workspace_revision:99,workspace_state:'confirmed',workspace_hash:'f'.repeat(64),workspace_writer:{},workspace_epoch:99,workspace_build:{},workspace_verify:{},checkpoint_id:randomUUID()};
  for(const [name,value] of Object.entries(fields))await denied('/rest/v1/ita_projects?id=eq.'+f.projectId,{method:'PATCH',body:{[name]:value}},'service authority '+name);
  stage='cross_project';
  await denied('/rest/v1/rpc/ita_workspace_read',{method:'POST',body:{...f.scope,p_project_id:other.projectId}},'service cross-project execution','P0001');
  await denied('/rest/v1/rpc/ita_workspace_read',{method:'POST',body:f.scope,...userOptions(users[0])},'authenticated private workspace RPC');
  await denied('/rest/v1/rpc/ita_request_project_delete',{method:'POST',body:{p_project_id:f.projectId},...userOptions(users[1])},'cross-owner deletion RPC');
  const rls=await okApi('/rest/v1/ita_projects?id=eq.'+f.projectId,userOptions(users[1]));assert.deepEqual(rls,[]);report('other-owner project read','PASS',{denial:'RLS projection: empty rows'});
  stage='checkpoint_guards';
  await f.evidence('build','passed');await f.evidence('verify','blocker');
  await denied('/rest/v1/rpc/ita_complete_build_checkpoint',{method:'POST',body:{...f.scope,...f.completion}},'blocker prohibits checkpoint','P0001');
  await f.evidence('verify','tool_error');await denied('/rest/v1/rpc/ita_complete_build_checkpoint',{method:'POST',body:{...f.scope,...f.completion}},'tool_error prohibits checkpoint','P0001');
  await f.evidence('verify','success_with_warnings');
  const done=await f.call('ita_complete_build_checkpoint',f.completion);
  assert.equal((await f.call('ita_complete_build_checkpoint',f.completion)).snapshot_id,done.snapshot_id);
  for(const change of [{p_build_basis:'a'.repeat(64)},{p_verify_basis:'a'.repeat(64)},{p_basis_id:randomUUID()},{p_summary:'different stable summary'}]){
    const result=await denied('/rest/v1/rpc/ita_complete_build_checkpoint',{method:'POST',body:{...f.scope,...f.completion,...change}},'different completion identity','P0001');
    assert.match(result.data.message,/CHECKPOINT_IDEMPOTENCY_CONFLICT/);
  }
  const fieldsSnapshot={files:[],workspace_revision:99,code_hash:'f'.repeat(64),basis_id:randomUUID(),build_evidence:{},verify_evidence:{},completion_fingerprint:'f'.repeat(64)};
  for(const [name,value] of Object.entries(fieldsSnapshot))await denied('/rest/v1/ita_snapshots?id=eq.'+done.snapshot_id,{method:'PATCH',body:{[name]:value}},'service immutable '+name);
  await denied('/rest/v1/ita_snapshots?id=eq.'+done.snapshot_id,{method:'DELETE'},'service checkpoint DELETE');
  for(const sql of ["update public.ita_snapshots set files='[]'::jsonb where id=$1",'delete from public.ita_snapshots where id=$1']) {
    let rejected=false;try {await db.query(sql,[done.snapshot_id]);}catch(e){assert.equal(e.code,'P0001');assert.match(e.message,/CHECKPOINT_IMMUTABLE/);rejected=true;}
    assert.equal(rejected,true);report('owner SQL immutable trigger','PASS',{denial:'trigger',sqlstate:'P0001'});
  }
  const count=await db.query("select (select count(*) from public.ita_snapshots where project_id=$1)::int snapshots,(select count(*) from public.ita_messages where project_id=$1 and meta ? 'checkpointId')::int completion_facts",[f.projectId]);assert.deepEqual(count.rows[0],{snapshots:1,completion_facts:1});
  const current=await db.query('select phase from public.ita_tasks where id=$1',[f.task.id]);assert.equal(current.rows[0].phase,'done_with_warnings');
  stage='normal_delete_cascade';await deleteFixture(f);await deleteFixture(other);
  const after=await db.query('select (select count(*) from public.ita_snapshots where project_id=$1)::int snapshots,(select count(*) from public.ita_changesets where project_id=$1)::int changesets',[f.projectId]);assert.deepEqual(after.rows[0],{snapshots:0,changesets:0});
  for(const user of users){const r=await api('/auth/v1/admin/users/'+user.id,{method:'DELETE'});assert.ok(r.status<400);}
  report('Step 2','PASS',{direct_dml:'ACL denied despite service_role BYPASSRLS',checkpoint_guard:'ACL + owner-trigger verified',legal_workspace_rpc:true,cross_project_rejected:true,completion_snapshots:1,completion_facts:1,deletion_cascade:true,evidence_scope:'synthetic protocol fixture; not browser execution'});
} catch(e){report('Step 2','FAIL',{stage,...errorInfo(e)});process.exitCode=1;}
finally{if(db)await db.end();}
