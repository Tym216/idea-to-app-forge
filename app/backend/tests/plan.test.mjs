/**
 * 增量迁移验证:在 PGlite(真实 PostgreSQL)中按「0001_init.sql → 0002_plan_review.sql」顺序执行,
 * 验证计划版本(NULL/错误/旧版本/幂等)、每次领取独立 execution_id、旧执行写入被拒绝、
 * 重试(新建/恢复)、恢复重置本次预算与恢复上限、越权防护。
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const W = 'worker-1';
const db = new PGlite();
const results = [];

async function as(role, uid, sql, params = []) {
  await db.exec('reset role;');
  await db.query('select set_config($1,$2,false)', ['request.jwt.claims', uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role};`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
}
const svc = (sql, p) => as('service_role', null, sql, p);
const asA = (sql, p) => as('authenticated', A, sql, p);
function rec(name, ok, detail = '') { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); }
async function denied(name, fn, pattern) {
  try { await fn(); rec(name, false, '意外成功'); }
  catch (e) { const m = String(e.message).split('\n')[0]; rec(name, !pattern || pattern.test(m), `已拒绝: ${m}`); }
}
async function claim(worker = W) { return (await svc(`select * from public.ita_claim_task('${worker}',120)`)).rows[0]; }
async function update(t, patch, exec = t.execution_id) {
  return (await svc('select public.ita_worker_update_task($1,$2,$3,$4::jsonb) ok',
    [t.id, t.worker_id, exec, JSON.stringify(patch)])).rows[0].ok;
}
const finish = (t) => update(t, { status: 'succeeded', phase: 'done' });
const fail = (t, error = '失败') => update(t, { status: 'failed', error });
async function savePlan(t, kind, content, exec = t.execution_id) {
  return (await svc('select * from public.ita_worker_save_plan($1,$2,$3,$4,$5::jsonb)',
    [t.id, t.worker_id, exec, kind, JSON.stringify(content)])).rows[0];
}
const heartbeat = async (t, exec) => (await svc('select public.ita_heartbeat_task($1,$2,$3,120) ok', [t.id, t.worker_id, exec])).rows[0].ok;
const checkLease = async (t, exec) => (await svc('select public.ita_worker_check_lease($1,$2,$3) ok', [t.id, t.worker_id, exec])).rows[0].ok;
const memory = (t, exec, key) => svc(`select * from public.ita_worker_upsert_memory($1,$2,$3,'project',$4,'v',1)`, [t.id, t.worker_id, exec, key]);
const expire = (id) => svc(`update public.ita_tasks set lease_until = now() - interval '1 second' where id=$1`, [id]);
const row = async (id) => (await svc('select * from public.ita_tasks where id=$1', [id])).rows[0];

await db.exec(`
  create schema auth; create table auth.users(id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  grant select on auth.users to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;`);
await db.query('insert into auth.users values ($1,$2),($3,$4)', [A, 'a@x', B, 'b@x']);
for (const f of ['0001_init.sql', '0002_plan_review.sql']) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  console.log(`已执行 ${f}`);
}
await db.exec(readFileSync(new URL('../migrations/0002_plan_review.sql', import.meta.url), 'utf8'));
rec('0002 重复执行不报错', true);
const oldSig = (await svc(`select count(*)::int n from pg_proc where proname in ('ita_heartbeat_task','ita_worker_upsert_memory','ita_worker_check_lease','ita_worker_update_task','ita_worker_save_plan')`)).rows[0].n;
rec('旧签名已移除,每个 Worker 函数仅保留带 execution_id 的一个版本', oldSig === 5, `函数数=${oldSig}`);

const project = (await asA(`insert into public.ita_projects(user_id,name) values ($1,'P') returning id`, [A])).rows[0].id;

// ---- Plan 任务 → 计划 v1
const t1 = (await asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'plan','做待办') returning id, round`, [project, A])).rows[0];
rec('任务轮次由服务端分配', t1.round === 1, `round=${t1.round}`);
const c1 = await claim();
rec('领取返回 execution_id', typeof c1.execution_id === 'string' && c1.execution_id.length === 36);
const v1 = await savePlan(c1, 'plan', { summary: 'v1' });
rec('Worker 保存计划 v1(draft)', v1.version === 1 && v1.status === 'draft');
await finish(c1);

await denied('客户端不能直接写 ita_plans', () =>
  asA(`insert into public.ita_plans(project_id,user_id,version,content) values ($1,$2,9,'{}')`, [project, A]));
await denied('用户B 不能批准A的计划', () => as('authenticated', B, 'select * from public.ita_approve_plan($1,1)', [v1.id]), /not owned/);
const bRead = await as('authenticated', B, 'select count(*)::int n from public.ita_plans');
rec('用户B 读不到A的计划', bRead.rows[0].n === 0);
await denied('approve 传 NULL 版本被拒绝', () => asA('select * from public.ita_approve_plan($1,null)', [v1.id]), /PLAN_VERSION_REQUIRED/);
await denied('revise 传 NULL 版本被拒绝', () => asA(`select * from public.ita_revise_plan($1,null,'改','{}')`, [v1.id]), /PLAN_VERSION_REQUIRED/);

// ---- 反馈 → 新版本 v2
const rv = (await asA(`select * from public.ita_revise_plan($1,1,'加上截止日期','{"q1":"本地存储"}'::jsonb)`, [v1.id])).rows[0];
rec('反馈持久化并排队 Plan 任务', rv.mode === 'plan' && rv.plan_version === 1);
const fb = await asA('select content, answers from public.ita_plan_feedback where plan_id=$1', [v1.id]);
rec('反馈可读回(刷新后仍可查看)', fb.rows.length === 1 && fb.rows[0].answers.q1 === '本地存储');
const c2 = await claim();
const v2 = await savePlan(c2, 'plan', { summary: 'v2' });
await finish(c2);
const v1Now = (await svc('select status from public.ita_plans where id=$1', [v1.id])).rows[0].status;
rec('生成 v2 后 v1 变为 superseded', v2.version === 2 && v1Now === 'superseded');

await denied('旧版本 v1 的批准被拒绝', () => asA('select * from public.ita_approve_plan($1,1)', [v1.id]), /PLAN_VERSION_STALE/);
await denied('对 v2 传版本 1 被拒绝', () => asA('select * from public.ita_approve_plan($1,1)', [v2.id]), /PLAN_VERSION_STALE/);
await denied('对 v2 传版本 99 被拒绝', () => asA('select * from public.ita_approve_plan($1,99)', [v2.id]), /PLAN_VERSION_STALE/);

const ap1 = (await asA('select * from public.ita_approve_plan($1,2)', [v2.id])).rows[0];
const ap2 = (await asA('select * from public.ita_approve_plan($1,2)', [v2.id])).rows[0];
const cnt = (await svc(`select count(*)::int n from public.ita_tasks where plan_id=$1 and mode='build'`, [v2.id])).rows[0].n;
rec('批准绑定 v2 且同版本重复批准返回同一任务', ap1.id === ap2.id && ap1.plan_version === 2 && cnt === 1, `build 任务数=${cnt}`);
await denied('已批准后用错误版本 99 调用仍报错(不返回已有任务)', () => asA('select * from public.ita_approve_plan($1,99)', [v2.id]), /PLAN_VERSION_STALE/);
let dup = false;
try { await svc(`insert into public.ita_tasks(project_id,user_id,mode,prompt,plan_id,plan_version) values ($1,$2,'build','x',$3,2)`, [project, A, v2.id]); } catch { dup = true; }
rec('数据库唯一索引拦截同一版本第二个构建任务', dup);
await denied('批准后不能再对 v2 提反馈', () => asA(`select * from public.ita_revise_plan($1,2,'改','{}')`, [v2.id]), /PLAN_VERSION_STALE/);

// ---- 执行标识:同一 worker_id 超时后重新领取得到新 execution_id,旧执行全部写入被拒绝
const e1task = await claim();
const E1 = e1task.execution_id;
rec('Worker 领取的是批准版本的构建任务', e1task.id === ap1.id && e1task.plan_id === v2.id);
rec('E1 有效时写入成功', (await update(e1task, { phase: 'react', last_tool: 'build', last_tool_ms: 1200 })) === true);
await expire(e1task.id);
rec('租约过期后 E1 写入被拒绝', (await update(e1task, { phase: 'late' })) === false && (await row(e1task.id)).phase === 'react');
rec('租约过期后 E1 check_lease 为 false', (await checkLease(e1task, E1)) === false);
await denied('租约过期后 E1 保存计划被拒绝', () => savePlan(e1task, 'action', {}), /LEASE_LOST/);
const e2task = await claim();
const E2 = e2task.execution_id;
rec('同一 worker_id 接管得到新执行 E2 ≠ E1', e2task.id === e1task.id && e2task.worker_id === W && E2 !== E1, `E1=${E1.slice(0, 8)} E2=${E2.slice(0, 8)}`);
rec('E1 心跳被拒绝', (await heartbeat(e1task, E1)) === false);
rec('E1 update_task 被拒绝', (await update(e1task, { phase: 'zombie' }, E1)) === false);
rec('E1 步骤写入被拒绝', (await update(e1task, { steps: [{ tool: 'zombie' }] }, E1)) === false);
rec('E1 文件写入前租约校验为 false', (await checkLease(e1task, E1)) === false);
await denied('E1 记忆写入被拒绝', () => memory(e1task, E1, 'k_e1'), /LEASE_LOST/);
await denied('E1 保存计划被拒绝', () => savePlan(e1task, 'action', {}, E1), /LEASE_LOST/);
rec('E2 心跳成功', (await heartbeat(e2task, E2)) === true);
rec('E2 update_task 成功', (await update(e2task, { phase: 'e2' }, E2)) === true);
rec('E2 步骤写入成功', (await update(e2task, { steps: [{ tool: 'build' }], tool_steps: 40, fix_rounds: 6 }, E2)) === true);
rec('E2 租约校验为 true', (await checkLease(e2task, E2)) === true);
rec('E2 记忆写入成功', (await memory(e2task, E2, 'k_e2')).rows[0].key === 'k_e2');
const afterZombie = await row(e2task.id);
rec('僵尸写入未污染数据', afterZombie.phase === 'e2' && afterZombie.steps.length === 1 && afterZombie.steps[0].tool === 'build');
const other = await (async () => { await expire(e2task.id); return claim('worker-2'); })();
rec('其他 Worker 接管后 E2 无法写入', other.id === e2task.id && (await update(e2task, { phase: 'x' }, E2)) === false);
await fail(other, 'TOOL_STEP_LIMIT');

// ---- 恢复:清空 execution_id、重置本次预算、累计历史、最多 3 次
await denied('客户端不能伪造 plan_id / kind', () =>
  asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt,kind) values ($1,$2,'build','x','resume')`, [project, A]));
const rs = (await asA(`select * from public.ita_retry_task($1,'resume')`, [other.id])).rows[0];
rec('恢复任务:同一任务 id、resumes+1、queued', rs.id === other.id && rs.kind === 'resume' && rs.resumes === 1 && rs.status === 'queued');
rec('恢复后 execution_id 为 NULL', rs.execution_id === null);
rec('恢复后 tool_steps=0、fix_rounds=0,累计 40/6', rs.tool_steps === 0 && rs.fix_rounds === 0 && rs.total_tool_steps === 40 && rs.total_fix_rounds === 6,
  `total=${rs.total_tool_steps}/${rs.total_fix_rounds}`);
rec('恢复步骤保留上次失败原因', rs.steps.at(-1).observation.includes('TOOL_STEP_LIMIT'));
const e3task = await claim();
rec('恢复后再次领取得到新 E3 ≠ E2', e3task.execution_id !== E2 && e3task.execution_id !== E1);
rec('恢复后 E2 写入被拒绝', (await update(e2task, { phase: 'old' }, E2)) === false);
await update(e3task, { tool_steps: 5, fix_rounds: 2 });
await fail(e3task, '再次失败');
for (let i = 2; i <= 3; i++) {
  await asA(`select * from public.ita_retry_task($1,'resume')`, [other.id]);
  await fail(await claim(), `第 ${i} 次失败`);
}
const r3 = await row(other.id);
rec('三次恢复后累计值正确', r3.resumes === 3 && r3.total_tool_steps === 45 && r3.total_fix_rounds === 8, `total=${r3.total_tool_steps}/${r3.total_fix_rounds}`);
await denied('第 4 次恢复被拒绝', () => asA(`select * from public.ita_retry_task($1,'resume')`, [other.id]), /RESUME_LIMIT/);

const nw = (await asA(`select * from public.ita_retry_task($1,'new')`, [other.id])).rows[0];
const oldRow = await row(other.id);
rec('新建任务:新 id、新轮次、保留原失败记录', nw.id !== other.id && nw.retry_of === other.id && nw.round > oldRow.round && oldRow.status === 'failed', `round ${oldRow.round}→${nw.round}`);
await denied('执行中任务不能重试', () => asA(`select * from public.ita_retry_task($1,'new')`, [nw.id]), /only failed/);
await denied('同项目不能并行第二个任务', () =>
  asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'build','并行')`, [project, A]), /duplicate|unique/);
await denied('authenticated 不能调用 Worker 写入 RPC', () =>
  asA(`select public.ita_worker_update_task($1,'x',null,'{}')`, [nw.id]), /permission/);
await denied('authenticated 不能调用心跳', () => asA(`select public.ita_heartbeat_task($1,'x',null,120)`, [nw.id]), /permission/);

await finish(await claim());  // 结束项目 P 中排队的新建任务,避免干扰下方领取

// ---- 旧版本已有批准任务:v1 批准并有任务 → 生成 v2 → approve(v1,1) 必须报错而不是返回原任务
const p2 = (await asA(`insert into public.ita_projects(user_id,name) values ($1,'P2') returning id`, [A])).rows[0].id;
await asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'plan','x')`, [p2, A]);
const pc = await claim();
const p2v1 = await savePlan(pc, 'plan', { summary: 'p2 v1' });
await finish(pc);
const p2build = (await asA('select * from public.ita_approve_plan($1,1)', [p2v1.id])).rows[0];
const bc = await claim();
const p2v2 = await savePlan(bc, 'plan', { summary: 'p2 v2' });
await finish(bc);
rec('P2 v1 已批准且有任务,之后生成 v2', p2build.plan_id === p2v1.id && p2v2.version === 2);
await denied('v1 已有批准任务但已存在 v2:approve(v1,1) 报错', () => asA('select * from public.ita_approve_plan($1,1)', [p2v1.id]), /PLAN_VERSION_STALE/);

const pass = results.filter(Boolean).length;
console.log(`\n========== 汇总: ${pass}/${results.length} 通过 ==========`);
if (pass !== results.length) process.exit(1);
