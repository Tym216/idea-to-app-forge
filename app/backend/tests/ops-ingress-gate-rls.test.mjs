/** Permanent regression: frozen reads run through real RLS, not service-role/catalog-only checks. */
import {test} from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import {randomUUID} from 'node:crypto';import {PGlite} from '@electric-sql/pglite';
import {captureIngress,freezeIngress,verifyFrozen,unfreezeIngress,gateSQL} from './ops-ingress-gate.mjs';
const migrations=['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0005_preview_recovery.sql','0006_workspace_contract.sql'];
for(const version of [5,6])test(`frozen 0001–000${version}: authenticated reads retain RLS isolation; mutation and worker RPCs remain denied`,async()=>{
 const db=new PGlite();try{
  await db.exec(`create schema auth;create table auth.users(id uuid primary key,email text);
   create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
   create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
   grant usage on schema auth to anon,authenticated,service_role;grant execute on function auth.uid() to anon,authenticated,service_role;`);
  const a=randomUUID(),b=randomUUID();await db.query('insert into auth.users values($1,$2),($3,$4)',[a,'a@fixture',b,'b@fixture']);
  for(const f of migrations.slice(0,5))await db.exec(readFileSync(new URL('../migrations/'+f,import.meta.url),'utf8'));
  const as=async(uid,sql,p=[])=>{await db.query('select set_config($1,$2,false)',['request.jwt.claims',JSON.stringify({sub:uid,role:'authenticated'})]);await db.exec('set role authenticated');try{return await db.query(sql,p);}finally{await db.exec('reset role');}};
  const fixtures=[];
  for(const uid of [a,b]){
   const project=(await as(uid,"insert into public.ita_projects(user_id,name) values($1,'gate fixture') returning id",[uid])).rows[0].id;
   const task=(await as(uid,"insert into public.ita_tasks(project_id,user_id,mode,prompt) values($1,$2,'plan','fixture') returning id",[project,uid])).rows[0].id;
   const plan=(await db.query("insert into public.ita_plans(project_id,user_id,version,kind,status,content,source_task_id) values($1,$2,1,'plan','draft','{}',$3) returning id",[project,uid,task])).rows[0].id;
   await as(uid,"insert into public.ita_messages(project_id,user_id,role,content) values($1,$2,'user','fixture')",[project,uid]);
   await db.query("insert into public.ita_files(project_id,user_id,path,content) values($1,$2,'src/App.tsx','fixture source')",[project,uid]);
   fixtures.push({uid,project,task,plan});
  }
  if(version===6)await db.exec(readFileSync(new URL('../migrations/'+migrations[5],import.meta.url),'utf8'));
  await db.exec(`create function public.ita_stable_rpc() returns int language sql stable security definer as $$select 1$$;
   create function public.ita_owns_project(text) returns boolean language sql stable security definer as $$select true$$;
   revoke all on function public.ita_stable_rpc(),public.ita_owns_project(text) from public;grant execute on function public.ita_stable_rpc(),public.ita_owns_project(text) to authenticated;`);
  const before=await captureIngress(db,'vfzyimhapttcdxeabvur');
  assert.ok(!gateSQL(before).includes('REVOKE EXECUTE ON FUNCTION "public"."ita_owns_project"(p_project_id uuid)'));
  await freezeIngress(db,before);assert.equal((await verifyFrozen(db)).client_mutation_rpc_execute,0);
  for(const own of fixtures){const other=fixtures.find(f=>f.uid!==own.uid);
   for(const [table,column] of [['ita_projects','id'],['ita_tasks','project_id'],['ita_plans','project_id'],['ita_files','project_id'],['ita_messages','project_id']]){
    assert.equal((await as(own.uid,`select 1 from public.${table} where ${column}=$1`,[own.project])).rows.length,1,table+' owner read through RLS');
    assert.equal((await as(own.uid,`select 1 from public.${table} where ${column}=$1`,[other.project])).rows.length,0,table+' foreign rows hidden by RLS');
   }
   const denied=async(sql,params=[])=>assert.rejects(as(own.uid,sql,params),e=>e.code==='42501');
   await denied("insert into public.ita_projects(user_id,name) values($1,'blocked')",[own.uid]);
   await denied("insert into public.ita_tasks(project_id,user_id,mode,prompt) values($1,$2,'build','blocked')",[own.project,own.uid]);
   await denied("update public.ita_projects set name='blocked' where id=$1",[own.project]);
   await denied("insert into public.ita_messages(project_id,user_id,role,content) values($1,$2,'user','blocked')",[own.project,own.uid]);
   await denied("update public.ita_files set content='blocked' where project_id=$1",[own.project]);
   for(const sql of ['select public.ita_resume_task($1::uuid)',"select public.ita_retry_task($1::uuid,'new')",'select public.ita_cancel_task($1::uuid)','select public.ita_pause_task($1::uuid)',"select public.ita_worker_update_task($1::uuid,'worker',$2::uuid,'{}'::jsonb)"])
    await denied(sql,sql.includes('$2')?[own.task,randomUUID()]:[own.task]);
   await denied('select public.ita_approve_plan($1::uuid,1)',[own.plan]);
   await denied('select public.ita_request_project_delete($1::uuid)',[own.project]);
   await denied('select public.ita_request_preview_recovery($1::uuid)',[own.project]);
   await denied("select * from public.ita_claim_task('blocked',120)");
   await denied('select public.ita_stable_rpc()');await denied("select public.ita_owns_project('text overload'::text)");
  }
  await db.exec('revoke execute on function public.ita_owns_project(uuid) from authenticated');
  await assert.rejects(verifyFrozen(db),e=>e.code==='POLICY_HELPER_EXECUTE_MISMATCH');
  await db.exec('grant execute on function public.ita_owns_project(uuid) to authenticated');
  await db.exec('create policy unknown_dependency on public.ita_projects for select using(public.ita_owns_project(name))');
  await assert.rejects(verifyFrozen(db),e=>e.code==='UNREVIEWED_POLICY_HELPER');await db.exec('drop policy unknown_dependency on public.ita_projects');
  await unfreezeIngress(db,before);assert.deepEqual((await captureIngress(db,before.ref)).grants,before.grants);
 }finally{await db.close();}
});
