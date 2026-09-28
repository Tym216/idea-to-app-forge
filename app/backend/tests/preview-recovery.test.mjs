import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`create schema auth; create table auth.users(id uuid primary key,email text);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema auth to anon,authenticated,service_role;
  grant select on auth.users to anon,authenticated,service_role;
  grant execute on function auth.uid() to anon,authenticated,service_role;`);
await db.query('insert into auth.users values($1,$2),($3,$4)', [A,'a@x',B,'b@x']);
for (const name of ['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0005_preview_recovery.sql','0005_preview_recovery.sql'])
  await db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
async function as(role, uid, sql, params=[]) {
  await db.query('select set_config($1,$2,false)', ['request.jwt.claims',uid ? JSON.stringify({sub:uid}) : '']);
  await db.exec(`set role ${role}`);
  try { return (await db.query(sql,params)).rows; } finally { await db.exec('reset role'); }
}
const user = (sql,args) => as('authenticated',A,sql,args);
const svc = (sql,args) => as('service_role',null,sql,args);
const [p] = await user('insert into public.ita_projects(user_id,name) values($1,$2) returning *',[A,'wake']);
const request = () => user('select * from public.ita_request_preview_recovery($1)',[p.id]);
await assert.rejects(request(), /PREVIEW_SANDBOX_MISSING/);
await svc("update public.ita_projects set sandbox_id='saved' where id=$1",[p.id]);
await assert.rejects(as('authenticated',B,'select public.ita_request_preview_recovery($1)',[p.id]), /not owned/);
await assert.rejects(as('anon',null,'select public.ita_request_preview_recovery($1)',[p.id]), /permission/);
await request(); await request();
assert.equal((await user('select * from public.ita_preview_recoveries')).length,1);
assert.equal((await as('authenticated',B,'select * from public.ita_preview_recoveries')).length,0);
await assert.rejects(user("update public.ita_preview_recoveries set status='ready'"),/permission/);
await assert.rejects(user("select public.ita_claim_preview_recovery('w')"),/permission/);
const [task] = await user("insert into public.ita_tasks(user_id,project_id,mode,prompt) values($1,$2,'build','x') returning *",[A,p.id]);
const claim = async () => (await svc("select * from public.ita_claim_preview_recovery('w')"))[0];
assert.equal(await claim(),undefined);
await user('select public.ita_pause_task($1)',[task.id]);
const j1 = await claim();
assert.ok(j1.execution_id);
assert.equal(await claim(),undefined);
const complete = async (e,url='https://preview.test/') => (await svc("select public.ita_update_preview_recovery($1,'w',$2,'ready',$3,null) ok",[p.id,e,url]))[0].ok;
assert.equal(await complete(null),false);
assert.equal(await complete('33333333-3333-3333-3333-333333333333'),false);
await svc("update public.ita_preview_recoveries set lease_until=now()-interval '1 second'");
assert.equal(await complete(j1.execution_id),false);
const j2=await claim();
assert.notEqual(j1.execution_id,j2.execution_id);
assert.equal(await complete(j1.execution_id),false);
assert.equal(await complete(j2.execution_id),true);
assert.equal((await user('select preview_url from public.ita_projects where id=$1',[p.id]))[0].preview_url,'https://preview.test/');
assert.equal((await request())[0].status,'ready'); // recent ready requests coalesce
await svc("update public.ita_preview_recoveries set updated_at=now()-interval '1 minute'");
await request(); const j3=await claim();
await svc("update public.ita_projects set sandbox_id='replacement' where id=$1",[p.id]);
assert.equal(await complete(j3.execution_id,'https://stale.test/'),false);
await request(); const j4=await claim();
await svc("select public.ita_update_preview_recovery($1,'w',$2,'failed',null,'unavailable')",[p.id,j4.execution_id]);
assert.equal((await request())[0].status,'queued');
const j5=await claim();
await user('select public.ita_request_project_delete($1,null)',[p.id]);
assert.equal(await complete(j5.execution_id),false);
await assert.rejects(request(),/PROJECT_DELETING/);
await svc('delete from public.ita_projects where id=$1',[p.id]);
assert.equal((await svc('select * from public.ita_preview_recoveries')).length,0);
await db.close();
console.log('PASS preview migration: ownership/RLS, idempotence, active-build exclusion, paused preview, lease fencing, changed binding, failure retry, deletion cascade');
