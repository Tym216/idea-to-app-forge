import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { PGlite } from '@electric-sql/pglite';
const db = new PGlite();
const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
await db.exec(`
  create schema auth; create table auth.users(id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  grant select on auth.users to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;`);
await db.query('insert into auth.users values ($1,$2),($3,$4)', [A, 'a@x', B, 'b@x']);
for (const name of ['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0004_task_pause.sql']) {
  await db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), 'utf8'));
}
async function as(role, uid, sql, params = []) {
  await db.query('select set_config($1,$2,false)', ['request.jwt.claims', uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role}`);
  try { return (await db.query(sql, params)).rows; } finally { await db.exec('reset role'); }
}
const user = (sql, params) => as('authenticated', A, sql, params);
const svc = (sql, params) => as('service_role', null, sql, params);
const [project] = await user('insert into public.ita_projects(user_id,name) values ($1,$2) returning *', [A, 'pause test']);
const insert = () => user("insert into public.ita_tasks(user_id,project_id,mode,prompt) values ($1,$2,'build','test') returning *", [A,project.id]);
const [task] = await insert();
const control = async (action) => (await user(`select * from public.ita_${action}_task($1)`, [task.id]))[0];
const claim = async () => (await svc("select * from public.ita_claim_task('worker-1',120)"))[0];
const valid = async (e) => (await svc("select public.ita_worker_check_lease($1,'worker-1',$2) ok", [task.id,e])).at(0).ok;

await assert.rejects(as('authenticated', B, 'select public.ita_pause_task($1)', [task.id]), /not owned/);
await assert.rejects(as('anon', null, 'select public.ita_pause_task($1)', [task.id]), /permission/);
assert.equal((await control('pause')).status, 'paused');
assert.equal(await claim(), undefined);
assert.equal((await control('pause')).status, 'paused');
await assert.rejects(insert(), /ita_tasks_active_unique/);
await control('resume');
const e1 = await claim();
await svc("select public.ita_worker_update_task($1,'worker-1',$2,$3::jsonb)", [task.id,e1.execution_id,JSON.stringify({tool_steps:7,fix_rounds:2})]);
const paused = await control('pause');
assert.equal(paused.execution_id, null);
assert.equal(await valid(e1.execution_id), false);
assert.equal((await svc("select public.ita_worker_update_task($1,'worker-1',$2,'{\"status\":\"succeeded\"}') ok", [task.id,e1.execution_id]))[0].ok, false);
for (let i=0;i<5;i++) { await control('resume'); await control('pause'); }
const resumed = await control('resume');
assert.equal(resumed.tool_steps, 7);
assert.equal(resumed.fix_rounds, 2);
assert.equal(resumed.resumes, 0);
assert.equal((await control('resume')).id, task.id);
const e2 = await claim();
assert.notEqual(e1.execution_id, e2.execution_id);
assert.equal(await valid(e1.execution_id), false);
assert.equal(await valid(e2.execution_id), true);
await control('pause');
assert.equal((await control('cancel')).status, 'cancelled');
const [next] = await insert();
assert.notEqual(next.id,task.id);
await user('select public.ita_pause_task($1)', [next.id]);
await user('select public.ita_request_project_delete($1,null)', [project.id]);
await assert.rejects(user('select public.ita_resume_task($1)', [next.id]), /PROJECT_DELETING/);
assert.equal(await claim(), undefined);
const audit = await svc("select count(*)::int n from public.ita_audit_log where action='task.pause'");
assert.ok(audit[0].n > 0);
await db.close();
console.log('PASS pause migration: repeat migration, ownership, idempotence, budget retention, execution fencing, project exclusion, cancel and deletion');
