/**
 * 删除回归:PGlite 中依序加载 0001–0006；在 0003 阶段创建 legacy fixture 后升级。
 * 覆盖两阶段删除、删除期间阻断、失败可重试、幂等、旧执行失效、记忆启停与建议、质量反馈隔离、审计保留。
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { randomUUID } from 'node:crypto';
import { sourceManifest, sourceDiff } from '../../worker/src/managed-source.js';
import {assertForgeTablePrivileges} from './forge-table-privileges.mjs';

const A = '11111111-1111-1111-1111-111111111111';
const B = '22222222-2222-2222-2222-222222222222';
const W = 'worker-1';
const db = new PGlite();
process.on('uncaughtException', (e) => { console.error(e.message, e.where || '', e.stack?.split('\n').slice(-2).join('\n')); process.exit(1); });
const results = [];

async function as(role, uid, sql, params = []) {
  await db.exec('reset role;');
  await db.query('select set_config($1,$2,false)', ['request.jwt.claims', uid ? JSON.stringify({ sub: uid, role }) : '']);
  await db.exec(`set role ${role};`);
  try { return await db.query(sql, params); } finally { await db.exec('reset role;'); }
}
const svc = (sql, p) => as('service_role', null, sql, p);
const asA = (sql, p) => as('authenticated', A, sql, p);
const asB = (sql, p) => as('authenticated', B, sql, p);
function rec(name, ok, detail = '') { results.push(ok); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`); }
async function denied(name, fn, pattern) {
  try { await fn(); rec(name, false, '意外成功'); }
  catch (e) { const m = String(e.message).split('\n')[0]; rec(name, !pattern || pattern.test(m), `已拒绝: ${m}`); }
}
const one = async (q) => (await q).rows[0];
const count = async (sql, p) => (await svc(sql, p)).rows[0].n;
const claim = () => one(svc(`select * from public.ita_claim_task('${W}',120)`));
const update = async (t, patch) => (await svc('select public.ita_worker_update_task($1,$2,$3,$4::jsonb) ok', [t.id, W, t.execution_id, JSON.stringify(patch)])).rows[0].ok;

await db.exec(`
  create schema auth; create table auth.users(id uuid primary key, email text);
  create function auth.uid() returns uuid language sql stable as $$
    select (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
  create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
  grant usage on schema auth to anon, authenticated, service_role;
  grant select on auth.users to anon, authenticated, service_role;
  grant execute on function auth.uid() to anon, authenticated, service_role;`);
await db.query('insert into auth.users values ($1,$2),($3,$4)', [A, 'a@x', B, 'b@x']);
for (const f of ['0001_init.sql', '0002_plan_review.sql', '0003_deletion_retention.sql']) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  console.log(`已执行 ${f}`);
}
await db.exec(readFileSync(new URL('../migrations/0003_deletion_retention.sql', import.meta.url), 'utf8'));
rec('0003 重复执行不报错', true);

const newProject = async (name, sandbox) => {
  const id = (await one(asA(`insert into public.ita_projects(user_id,name) values ($1,$2) returning id`, [A, name]))).id;
  await svc('update public.ita_projects set sandbox_id=$2, preview_url=$3 where id=$1', [id, sandbox, `https://p.example/${sandbox}?token=x`]);
  return id;
};
const P = await newProject('要删除', 'sbx-P');
const Q = await newProject('保留', 'sbx-Q');

// ---- 准备数据:P 有聊天/计划/任务/文件/快照/项目约定/建议/反馈;A 有全局偏好
await asA(`insert into public.ita_messages(project_id,user_id,role,content) values ($1,$2,'user','需求内容')`, [P, A]);
await asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'plan','做待办')`, [P, A]);
const tp = await claim();
const plan = await one(svc(`select * from public.ita_worker_save_plan($1,$2,$3,'plan','{"summary":"v1"}'::jsonb)`, [tp.id, W, tp.execution_id]));
await svc(`select * from public.ita_worker_upsert_memory($1,$2,$3,'project','design_system','简洁',1)`, [tp.id, W, tp.execution_id]);
await denied('Worker 不能直接写全局偏好(需用户确认)', () =>
  svc(`select * from public.ita_worker_upsert_memory($1,$2,$3,'user','lang','中文',1)`, [tp.id, W, tp.execution_id]), /WORKER_USER_SCOPE_FORBIDDEN/);
const sug = await one(svc(`select public.ita_worker_suggest_memory($1,$2,$3,'reply_language','界面文字使用中文') ok`, [tp.id, W, tp.execution_id]));
rec('Worker 只生成「保存为默认偏好?」建议', sug.ok === true && (await count(`select count(*)::int n from public.ita_memories where scope='user'`)) === 0);
await update(tp, { status: 'succeeded', phase: 'done' });
await svc(`insert into public.ita_files(project_id,user_id,path,content) values ($1,$2,'src/App.tsx','code')`, [P, A]);
await svc(`insert into public.ita_snapshots(project_id,user_id,label,files) values ($1,$2,'s','{}'::jsonb)`, [P, A]).catch(async () =>
  svc(`insert into public.ita_snapshots(project_id,user_id,files) values ($1,$2,'{}'::jsonb)`, [P, A]));


// Upgrade real migrations after legacy fixture creation, so revoked source DML is respected.
for (const f of ['0004_task_pause.sql', '0005_preview_recovery.sql', '0006_workspace_contract.sql']) {
  await db.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));
  console.log(`已执行 ${f}`);
}

await assertForgeTablePrivileges(db);

function workspaceCall(task) {
  return async (name, extra = [], types = []) => {
    const casts = ['uuid', 'uuid', 'text', 'uuid', ...types];
    return (await one(svc(`select to_jsonb(public.${name}(${casts.map((type, i) => `$${i + 1}::${type}`).join(',')})) value`,
      [task.project_id, task.id, W, task.execution_id, ...extra]))).value;
  };
}

// Trusted service evidence below is a database fixture, not a claim of real browser verification.
async function workspaceFixture(projectId, content) {
  await asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'build','workspace deletion fixture')`, [projectId,A]);
  const task = await claim();
  if (task.project_id !== projectId) throw new Error('fixture claimed wrong project');
  const rpc = workspaceCall(task);
  const basis = await one(svc(`select * from public.ita_worker_save_plan($1,$2,$3,'action',$4::jsonb)`,
    [task.id,W,task.execution_id,JSON.stringify({understanding:'fixture',scope:['fixture'],flows:['打开页面'],rules:['显示内容'],storage:'仅内存',steps:['展示内容'],design:'简洁',questions:[],
      acceptance:[{id:'A1',action:'打开页面',expect:'显示内容',external:false,severity:'core',steps:[{op:'expectText',selector:'main',contains:content}]}]})]));
  await update(task,{plan_id:basis.id,plan_version:basis.version});
  const before = sourceManifest((await rpc('ita_workspace_read')).files);
  let writer = await rpc('ita_workspace_acquire',[randomUUID(),'materialize','fixture-sandbox',null],['uuid','text','text','uuid']);
  await rpc('ita_workspace_finish_operation',[writer.token,before.code_hash],['uuid','text']);
  const target = sourceManifest([{path:'src/App.tsx',content}]);
  const cs = await rpc('ita_workspace_prepare',['deletion-fixture','agent',0,JSON.stringify(sourceDiff(before,target)),target.code_hash],['text','text','bigint','jsonb','text']);
  writer = await rpc('ita_workspace_acquire',[randomUUID(),'mutation','fixture-sandbox',cs.id],['uuid','text','text','uuid']);
  const committed = await rpc('ita_workspace_commit',[writer.token,cs.id,JSON.stringify(target.files),target.code_hash],['uuid','uuid','jsonb','text']);
  const buildBasis = 'a'.repeat(64), verifyBasis = 'b'.repeat(64);
  for (const [kind,fingerprint] of [['build',buildBasis],['verify',verifyBasis]]) {
    const accepted=await rpc('ita_workspace_evidence',[kind,JSON.stringify({workspace_revision:committed.revision,code_hash:target.code_hash,basis_fingerprint:fingerprint,status:'passed',fixture:true})],['text','jsonb']);
    if (!accepted) throw new Error('fixture evidence rejected');
  }
  const checkpoint = await rpc('ita_complete_build_checkpoint',[`${task.id}:checkpoint`,committed.revision,target.code_hash,buildBasis,verifyBasis,basis.id,'数据库级联 fixture','https://fixture.example/'],['text','bigint','text','text','text','uuid','text','text']);
  return {task,cs,checkpoint,manifest:target,revision:committed.revision};
}

const keepWorkspace = await workspaceFixture(Q,'keep');
const extended = await newProject('workspace 扩展删除','sbx-extended');
const extendedWorkspace = await workspaceFixture(extended,'extended');
rec('0006 fixture: confirmed workspace、changeset 与扩展 checkpoint 已实际创建',
  (await one(svc('select workspace_state,checkpoint_id from public.ita_projects where id=$1',[extended]))).workspace_state==='confirmed' &&
  (await count('select count(*)::int n from public.ita_changesets where project_id=$1',[extended]))===1 &&
  (await one(svc('select kind,workspace_revision,code_hash,basis_id from public.ita_snapshots where id=$1',[extendedWorkspace.checkpoint.snapshot_id]))).kind==='checkpoint');
await denied('service_role 旧 direct files INSERT 仍被 ACL 拒绝',()=>svc(`insert into public.ita_files(project_id,user_id,path,content) values ($1,$2,'bypass.ts','x')`,[extended,A]),/permission/);
await denied('service_role 旧 direct files UPDATE 仍被 ACL 拒绝',()=>svc(`update public.ita_files set content='bypass' where project_id=$1`,[extended]),/permission/);
await denied('checkpoint immutable trigger 在 owner fixture UPDATE 时也拒绝修改',()=>db.query(`update public.ita_snapshots set code_hash='changed' where id=$1`,[extendedWorkspace.checkpoint.snapshot_id]),/CHECKPOINT_IMMUTABLE/);

// Delete a project with a retained writer and an unresolved source changeset.
await asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'build','pending fixture')`,[extended,A]);
const pendingTask = await claim();
const pendingRpc = workspaceCall(pendingTask);
const pendingTarget = sourceManifest([{path:'src/App.tsx',content:'pending'}]);
const pendingCs = await pendingRpc('ita_workspace_prepare',['pending-fixture','agent',extendedWorkspace.revision,JSON.stringify(sourceDiff(extendedWorkspace.manifest,pendingTarget)),pendingTarget.code_hash],['text','text','bigint','jsonb','text']);
const pendingWriter = await pendingRpc('ita_workspace_acquire',[randomUUID(),'mutation','fixture-sandbox',pendingCs.id],['uuid','text','text','uuid']);
await asA(`select public.ita_request_project_delete($1,'req-extended')`,[extended]);
await denied('删除中的旧 writer 不能通过 workspace RPC commit',()=>pendingRpc('ita_workspace_commit',[pendingWriter.token,pendingCs.id,JSON.stringify(pendingTarget.files),pendingTarget.code_hash],['uuid','uuid','jsonb','text']),/LEASE_LOST/);
const extendedJob = await one(svc(`select * from public.ita_claim_project_deletion('${W}',300)`));
if(extendedJob.project_id!==extended) throw new Error('wrong deletion fixture project');
await svc('select public.ita_complete_project_deletion($1,$2,$3,true,null,$4)',[extended,W,extendedJob.attempts,'req-extended']);
const extendedCounts={};
for(const table of ['ita_changesets','ita_snapshots','ita_files','ita_tasks','ita_plans','ita_preview_recoveries']) {
  extendedCounts[table]=await count(`select count(*)::int n from public.${table} where project_id=$1`,[extended]);
}
rec('0006: retained writer 项目删除及新表/FK/快照级联完成',Object.values(extendedCounts).every(n=>n===0)&&
  (await count('select count(*)::int n from public.ita_projects where id=$1',[extended]))===0,JSON.stringify(extendedCounts));
rec('另一个项目的 changeset/checkpoint/源码不受影响',
  (await count('select count(*)::int n from public.ita_changesets where project_id=$1',[Q]))===1&&
  (await count('select count(*)::int n from public.ita_snapshots where id=$1',[keepWorkspace.checkpoint.snapshot_id]))===1&&
  (await one(svc('select content from public.ita_files where project_id=$1 and not deleted',[Q]))).content==='keep');

const s = await one(asA(`select id from public.ita_memory_suggestions where project_id=$1 and status='pending'`, [P]));
await denied('用户B 不能确认A的建议', () => asB('select public.ita_resolve_memory_suggestion($1,true)', [s.id]), /not owned/);
await asA('select public.ita_resolve_memory_suggestion($1,true)', [s.id]);
const pref = await one(asA(`select id, enabled from public.ita_memories where scope='user' and key='reply_language'`));
rec('用户确认后才写入全局偏好', pref?.enabled === true);
await asA(`select * from public.ita_upsert_memory('user','code_style','函数式组件',null,1)`);

// ---- 停用/启用
await asA('select public.ita_set_memory_enabled($1,false)', [pref.id]);
rec('全局偏好可单条停用', (await one(svc('select enabled from public.ita_memories where id=$1', [pref.id]))).enabled === false);
await denied('用户B 不能停用A的偏好', () => asB('select public.ita_set_memory_enabled($1,true)', [pref.id]), /not owned/);
await denied('客户端不能直接改 enabled 列', () => asA('update public.ita_memories set enabled=true where id=$1', [pref.id]), /permission/);
await asA('select public.ita_set_memory_enabled($1,true)', [pref.id]);
await asA('select public.ita_set_memory_enabled($1,false)', [pref.id]);
rec('可重新启用后再停用', (await one(svc('select enabled from public.ita_memories where id=$1', [pref.id]))).enabled === false);

// ---- 质量反馈
const fb = await one(asA(`select * from public.ita_submit_task_feedback($1,'preview_broken','预览白屏')`, [tp.id]));
rec('所有者可对已完成任务提交反馈(关联 task 与 execution)', fb.task_id === tp.id && fb.execution_id === tp.execution_id);
await denied('用户B 不能对A的任务提交反馈', () => asB(`select * from public.ita_submit_task_feedback($1,'other','x')`, [tp.id]), /not owned/);
rec('用户B 读不到A的反馈', (await one(asB('select count(*)::int n from public.ita_task_feedback'))).n === 0);
await denied('非法问题类型被拒绝', () => asA(`select * from public.ita_submit_task_feedback($1,'hack','x')`, [tp.id]), /check/);
await denied('客户端不能直接写反馈表', () =>
  asA(`insert into public.ita_task_feedback(task_id,project_id,user_id,category) values ($1,$2,$3,'other')`, [tp.id, P, A]), /permission/);

// ---- 运行中的执行 + 请求删除
await asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'build','继续')`, [P, A]);
const running = await claim();
await denied('客户端不能直接删除项目(必须走两阶段)', () => asA('delete from public.ita_projects where id=$1', [P]), /permission/);
await denied('用户B 不能请求删除A的项目', () => asB('select public.ita_request_project_delete($1)', [P]), /not owned/);
const r1 = await one(asA(`select public.ita_request_project_delete($1,'req-1') s`, [P]));
const r2 = await one(asA(`select public.ita_request_project_delete($1,'req-2') s`, [P]));
rec('请求删除幂等:重复调用仍为 deleting,队列只有一条', r1.s === 'deleting' && r2.s === 'deleting' &&
  (await count('select count(*)::int n from public.ita_project_deletions where project_id=$1', [P])) === 1);
rec('删除请求后旧执行写入被拒绝', (await update(running, { phase: 'zombie' })) === false);
rec('删除请求后旧执行心跳被拒绝', (await one(svc('select public.ita_heartbeat_task($1,$2,$3,120) ok', [running.id, W, running.execution_id]))).ok === false);
await denied('删除中:旧执行文件写入被拒绝', () =>
  svc(`insert into public.ita_files(project_id,user_id,path,content) values ($1,$2,'late.ts','x')`, [P, A]), /PROJECT_DELETING|permission denied/);
await denied('删除中:提交任务被拒绝', () =>
  asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'build','x')`, [P, A]), /PROJECT_DELETING/);
await denied('删除中:批准计划被拒绝', () => asA('select * from public.ita_approve_plan($1,1)', [plan.id]), /PROJECT_DELETING/);
rec('删除中:领取任务不会拿到该项目', (await claim()) === undefined);
await denied('删除中:Worker 不能改换 sandbox_id', async () => {
  await svc(`update public.ita_projects set sandbox_id='sbx-other' where id=$1`, [P]);
  if ((await one(svc('select sandbox_id from public.ita_projects where id=$1', [P]))).sandbox_id !== 'sbx-P') throw new Error('frozen');
  throw new Error('frozen');
}, /frozen/);

// ---- Worker 领取删除任务:失败 → 项目可见 + delete_failed → 重试 → 成功
const job = await one(svc(`select * from public.ita_claim_project_deletion('${W}',300)`));
rec('删除任务只携带该项目自己的 sandbox_id', job.project_id === P && job.sandbox_id === 'sbx-P');
rec('删除任务在租约期内不会被重复领取', (await svc(`select * from public.ita_claim_project_deletion('worker-2',300)`)).rows.length === 0);
await svc(`select public.ita_complete_project_deletion($1,$2,$3,false,'Daytona 503')`, [P, W, job.attempts]);
const failed = await one(asA('select deletion_state, delete_error from public.ita_projects where id=$1', [P]));
rec('Daytona 删除失败:项目仍可见,状态 delete_failed', failed?.deletion_state === 'delete_failed' && failed.delete_error.includes('503'));
rec('失败后项目数据仍在', (await count('select count(*)::int n from public.ita_files where project_id=$1', [P])) === 1);
await asA(`select public.ita_request_project_delete($1,'req-retry')`, [P]);
const job2 = await one(svc(`select * from public.ita_claim_project_deletion('${W}',300)`));
rec('重试走同一流程', job2.project_id === P && job2.attempts === 2);
await denied('其他 Worker 不能完成不属于它的删除', () =>
  svc(`select public.ita_complete_project_deletion($1,'worker-2',$2,true)`, [P, job2.attempts]), /DELETION_LEASE_LOST/);
const done = await one(svc(`select public.ita_complete_project_deletion($1,$2,$3,true,null,'req-done') s`, [P, W, job2.attempts]));
rec('沙箱清理成功后删除完成', done.s === 'deleted');

const left = {};
for (const t of ['ita_projects:id', 'ita_messages', 'ita_tasks', 'ita_plans', 'ita_plan_feedback', 'ita_files', 'ita_snapshots',
  'ita_memories', 'ita_memory_suggestions', 'ita_task_feedback', 'ita_project_deletions', 'ita_changesets', 'ita_preview_recoveries']) {
  const [table, col = 'project_id'] = t.split(':');
  left[table] = await count(`select count(*)::int n from public.${table} where ${col}=$1`, [P]);
}
rec('P 的全部数据已消失(聊天/计划/反馈/任务/文件/快照/项目约定/建议/质量反馈/队列)', Object.values(left).every((n) => n === 0), JSON.stringify(left));
rec('其他项目 Q 不受影响', (await count('select count(*)::int n from public.ita_projects where id=$1 and sandbox_id=$2', [Q, 'sbx-Q'])) === 1);
rec('全局偏好保留(含停用状态)', (await count(`select count(*)::int n from public.ita_memories where user_id=$1 and scope='user'`, [A])) === 2);
await denied('已删除项目再次请求删除报不存在', () => asA('select public.ita_request_project_delete($1)', [P]), /not owned/);

// ---- 审计
const audit = (await svc('select actor_id, action, result, request_id, metadata from public.ita_audit_log order by id')).rows;
const actions = audit.map((a) => `${a.action}:${a.result}`);
rec('审计记录在项目删除后仍保留', ['project.delete_request:requested', 'project.delete:failure', 'project.delete:success',
  'memory.disable:success', 'memory.enable:success', 'memory.suggestion_accept:success'].every((x) => actions.includes(x)), actions.join(','));
rec('审计记录请求 ID', audit.find((a) => a.action === 'project.delete' && a.result === 'success' && a.request_id==='req-done').request_id === 'req-done');
const auditText = JSON.stringify(audit);
rec('审计不含需求/代码/预览 URL/令牌', !/需求内容|code|token|p\.example|做待办|中文/.test(auditText));
await denied('客户端不能写审计', () => asA(`insert into public.ita_audit_log(action,result,request_id) values ('x','success','r')`), /permission/);
rec('用户只能读自己的审计', (await one(asB('select count(*)::int n from public.ita_audit_log'))).n === 0 &&
  (await one(asA('select count(*)::int n from public.ita_audit_log'))).n === audit.length);

// 批准计划审计:另起项目
const R = await newProject('批准', 'sbx-R');
await asA(`insert into public.ita_tasks(project_id,user_id,mode,prompt) values ($1,$2,'plan','x')`, [R, A]);
const tr = await claim();
const pr = await one(svc(`select * from public.ita_worker_save_plan($1,$2,$3,'plan','{}'::jsonb)`, [tr.id, W, tr.execution_id]));
await update(tr, { status: 'succeeded' });
await asA('select * from public.ita_approve_plan($1,1)', [pr.id]);
rec('批准计划写入审计', (await count(`select count(*)::int n from public.ita_audit_log where action='plan.approve'`)) === 1);

// ---- 保留期清理
await db.exec('reset role;');  // 审计表对任何角色都不开放 UPDATE;测试以 owner 身份模拟时间流逝
await db.query(`update public.ita_audit_log set occurred_at = now() - interval '100 days' where action='memory.enable'`);
const purged = await one(svc('select public.ita_purge_audit_log(90) n'));
rec('保留期清理删除超过 90 天的记录', purged.n === 1 && (await count(`select count(*)::int n from public.ita_audit_log where action='memory.enable'`)) === 0);
await denied('authenticated 不能调用清理函数', () => asA('select public.ita_purge_audit_log(1)'), /permission/);
await denied('authenticated 不能领取删除任务', () => asA(`select * from public.ita_claim_project_deletion('x',1)`), /permission/);

const pass = results.filter(Boolean).length;
console.log(`\n========== 汇总: ${pass}/${results.length} 通过 ==========`);
await db.close();
if (pass !== results.length) process.exit(1);
