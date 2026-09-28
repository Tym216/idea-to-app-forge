/**
 * 在真实 PostgreSQL(PGlite)中执行 0001_init.sql 并验证安全加固效果。
 *
 * 由于本地无 Supabase 实例,这里按 Supabase 的实际机制构造等价环境:
 *   - 创建 auth schema、auth.users 表
 *   - 创建 anon / authenticated / service_role 角色(service_role BYPASSRLS)
 *   - auth.uid() 读取 request.jwt.claims,与 Supabase 行为一致
 * 然后用两个真实用户身份跑越权与正向路径测试。
 */
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const SQL_PATH = new URL('../migrations/0001_init.sql', import.meta.url);

const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

const db = new PGlite();
const results = [];

/** 以指定角色与用户身份执行 SQL。 */
async function as(role, userId, sql, params = []) {
  await db.exec('reset role;');
  await db.query('select set_config($1, $2, false)', [
    'request.jwt.claims',
    userId ? JSON.stringify({ sub: userId, role }) : '',
  ]);
  await db.exec(`set role ${role};`);
  try {
    return await db.query(sql, params);
  } finally {
    await db.exec('reset role;');
  }
}

function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `\n      ${detail}` : ''}`);
}

/** 断言操作被拒绝。 */
async function expectDenied(name, fn) {
  try {
    await fn();
    record(name, false, '操作意外成功,未被拒绝');
  } catch (error) {
    record(name, true, `已拒绝: ${String(error.message).split('\n')[0]}`);
  }
}

/** 断言操作成功。 */
async function expectOk(name, fn) {
  try {
    const value = await fn();
    record(name, true, typeof value === 'string' ? value : '');
    return value;
  } catch (error) {
    record(name, false, `意外失败: ${String(error.message).split('\n')[0]}`);
    return null;
  }
}

async function bootstrap() {
  // ---- 模拟 Supabase 平台基础设施
  await db.exec(`
    create schema if not exists auth;
    create table if not exists auth.users (
      id uuid primary key,
      email text unique
    );
    create or replace function auth.uid() returns uuid
      language sql stable
    as $$
      -- 与 Supabase 官方实现一致:先 nullif 空串再转 jsonb,无 JWT 时返回 NULL
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid;
    $$;
    create role anon nologin;
    create role authenticated nologin;
    create role service_role nologin bypassrls;
    grant usage on schema auth to anon, authenticated, service_role;
    grant select on auth.users to anon, authenticated, service_role;
    grant execute on function auth.uid() to anon, authenticated, service_role;
  `);
  await db.query('insert into auth.users(id, email) values ($1,$2), ($3,$4)', [
    USER_A, 'a@example.com', USER_B, 'b@example.com',
  ]);

  // ---- 执行待验证的迁移
  await db.exec(readFileSync(SQL_PATH, 'utf8'));
  console.log('迁移 0001_init.sql 执行成功\n');
}

async function main() {
  await bootstrap();

  // ================= 正向路径 =================
  console.log('--- 正向路径 ---');
  const projA = await expectOk('用户A 创建自己的项目', async () => {
    const r = await as('authenticated', USER_A,
      `insert into public.ita_projects(user_id, name, description)
       values ($1,'A 的项目','待办清单') returning id`, [USER_A]);
    return `project_id=${r.rows[0].id}`;
  });
  const projectAId = projA.split('=')[1];

  const projB = await as('authenticated', USER_B,
    `insert into public.ita_projects(user_id, name) values ($1,'B 的项目') returning id`, [USER_B]);
  const projectBId = projB.rows[0].id;
  record('用户B 创建自己的项目', true, `project_id=${projectBId}`);

  await expectOk('用户A 在自己项目下写消息', async () => {
    await as('authenticated', USER_A,
      `insert into public.ita_messages(project_id, user_id, role, content)
       values ($1,$2,'user','做一个待办清单')`, [projectAId, USER_A]);
  });

  const taskRow = await expectOk('用户A 提交任务(仅允许的 4 个字段)', async () => {
    const r = await as('authenticated', USER_A,
      `insert into public.ita_tasks(project_id, user_id, mode, prompt)
       values ($1,$2,'build','做一个待办清单') returning id, status, worker_id, attempts`,
      [projectAId, USER_A]);
    const t = r.rows[0];
    return `id=${t.id} status=${t.status} worker_id=${t.worker_id} attempts=${t.attempts}`;
  });
  const taskId = taskRow.match(/id=(\S+)/)[1];

  await expectOk('用户A 写 user 范围记忆(project_id 为空)', async () => {
    await as('authenticated', USER_A,
      `insert into public.ita_memories(user_id, scope, key, value)
       values ($1,'user','语言','偏好中文注释')`, [USER_A]);
  });

  await expectOk('用户A 写 project 范围记忆(自己的项目)', async () => {
    await as('authenticated', USER_A,
      `insert into public.ita_memories(user_id, project_id, scope, key, value)
       values ($1,$2,'project','存储','使用 localStorage')`, [USER_A, projectAId]);
  });

  await expectOk('Worker 通过 ita_claim_task 领取任务', async () => {
    const r = await as('service_role', null,
      `select id, status, worker_id, lease_until is not null as leased
       from public.ita_claim_task('worker-test', 120)`);
    const t = r.rows[0];
    return `id=${t.id} status=${t.status} worker_id=${t.worker_id} leased=${t.leased}`;
  });

  await expectOk('Worker 通过 ita_heartbeat_task 续租', async () => {
    await as('service_role', null, `select public.ita_heartbeat_task($1,'worker-test',120)`, [taskId]);
    const r = await as('service_role', null,
      `select heartbeat_at is not null as beat from public.ita_tasks where id=$1`, [taskId]);
    return `heartbeat_at_set=${r.rows[0].beat}`;
  });

  await expectOk('用户A 通过 ita_cancel_task 受控取消自己的任务', async () => {
    const r = await as('authenticated', USER_A, `select status from public.ita_cancel_task($1)`, [taskId]);
    return `status=${r.rows[0].status}`;
  });

  // ================= 跨项目越权 =================
  console.log('\n--- 跨项目越权(自己的 user_id + 别人的 project_id)---');
  await expectDenied('用户B 向用户A 的项目写消息', () =>
    as('authenticated', USER_B,
      `insert into public.ita_messages(project_id, user_id, role, content)
       values ($1,$2,'user','越权')`, [projectAId, USER_B]));

  await expectDenied('用户B 向用户A 的项目提交任务', () =>
    as('authenticated', USER_B,
      `insert into public.ita_tasks(project_id, user_id, mode, prompt)
       values ($1,$2,'build','越权')`, [projectAId, USER_B]));

  await expectDenied('用户B 读取用户A 的项目', async () => {
    const r = await as('authenticated', USER_B,
      `select id from public.ita_projects where id=$1`, [projectAId]);
    if (r.rows.length === 0) throw new Error('RLS 过滤,返回 0 行');
    return r;
  });

  await expectDenied('用户B 取消用户A 的任务', () =>
    as('authenticated', USER_B, `select public.ita_cancel_task($1)`, [taskId]));

  // ================= 伪造任务执行状态 =================
  console.log('\n--- 伪造任务执行状态 ---');
  await expectDenied('用户A 插入任务时伪造 status/worker_id/lease/计数(无列权限)', () =>
    as('authenticated', USER_A,
      `insert into public.ita_tasks(project_id, user_id, mode, prompt, status, worker_id, lease_until, tool_steps, fix_rounds)
       values ($1,$2,'build','伪造','running','evil-worker', now()+interval '1 day', 999, 999)`,
      [projectAId, USER_A]));

  await expectDenied('用户A 直接 UPDATE 任务 status(无 UPDATE 策略/权限)', () =>
    as('authenticated', USER_A,
      `update public.ita_tasks set status='running' where id=$1`, [taskId]));

  await expectDenied('用户A 直接 DELETE 任务', () =>
    as('authenticated', USER_A, `delete from public.ita_tasks where id=$1`, [taskId]));

  await expectOk('触发器强制清洗执行态字段(默认值路径)', async () => {
    const r = await as('authenticated', USER_A,
      `insert into public.ita_tasks(project_id, user_id, mode, prompt)
       values ($1,$2,'plan','第二个任务')
       returning status, phase, worker_id, lease_until, tool_steps, fix_rounds, attempts`,
      [projectAId, USER_A]);
    const t = r.rows[0];
    const clean = t.status === 'queued' && t.worker_id === null && t.lease_until === null
      && t.tool_steps === 0 && t.fix_rounds === 0 && t.attempts === 0;
    if (!clean) throw new Error(`执行态字段未被清洗: ${JSON.stringify(t)}`);
    return `status=${t.status} worker_id=null lease_until=null tool_steps=0 fix_rounds=0`;
  });

  await expectDenied('authenticated 调用 ita_claim_task(无 EXECUTE 权限)', () =>
    as('authenticated', USER_A, `select * from public.ita_claim_task('evil',120)`));

  await expectDenied('authenticated 调用 ita_heartbeat_task(无 EXECUTE 权限)', () =>
    as('authenticated', USER_A, `select public.ita_heartbeat_task($1,'evil',120)`, [taskId]));

  // ================= 记忆范围约束 =================
  console.log('\n--- 记忆范围约束 ---');
  await expectDenied('user 范围记忆携带 project_id', () =>
    as('authenticated', USER_A,
      `insert into public.ita_memories(user_id, project_id, scope, key, value)
       values ($1,$2,'user','非法','带了项目')`, [USER_A, projectAId]));

  await expectDenied('project 范围记忆缺少 project_id', () =>
    as('authenticated', USER_A,
      `insert into public.ita_memories(user_id, scope, key, value)
       values ($1,'project','非法','没有项目')`, [USER_A]));

  await expectDenied('用户B 写指向用户A 项目的 project 记忆', () =>
    as('authenticated', USER_B,
      `insert into public.ita_memories(user_id, project_id, scope, key, value)
       values ($1,$2,'project','越权','别人的项目')`, [USER_B, projectAId]));

  // ================= 未登录 anon =================
  console.log('\n--- 未登录(anon)---');
  await expectDenied('anon 读取项目表', () =>
    as('anon', null, `select * from public.ita_projects`));
  await expectDenied('anon 插入任务', () =>
    as('anon', null,
      `insert into public.ita_tasks(project_id, user_id, mode, prompt) values ($1,$2,'build','x')`,
      [projectAId, USER_A]));

  // ================= 项目运行态字段保护 =================
  console.log('\n--- 项目运行态字段保护(sandbox_id / preview_url / status)---');
  await expectDenied('用户A 创建项目时夹带 sandbox_id/preview_url/status(无列权限)', () =>
    as('authenticated', USER_A,
      `insert into public.ita_projects(user_id, name, sandbox_id, preview_url, status)
       values ($1,'夹带','evil-sandbox','http://evil.example','ready')`, [USER_A]));

  await expectDenied('用户A 更新项目的 preview_url(无列权限)', () =>
    as('authenticated', USER_A,
      `update public.ita_projects set preview_url='http://evil.example' where id=$1`, [projectAId]));

  await expectDenied('用户A 更新项目的 status(无列权限)', () =>
    as('authenticated', USER_A,
      `update public.ita_projects set status='ready' where id=$1`, [projectAId]));

  await expectDenied('用户A 更新项目的 sandbox_id(无列权限)', () =>
    as('authenticated', USER_A,
      `update public.ita_projects set sandbox_id='evil' where id=$1`, [projectAId]));

  await expectOk('用户A 可正常修改 name/description(允许的列)', async () => {
    await as('authenticated', USER_A,
      `update public.ita_projects set name='改名后' where id=$1`, [projectAId]);
    const r = await as('authenticated', USER_A,
      `select name from public.ita_projects where id=$1`, [projectAId]);
    return `name=${r.rows[0].name}`;
  });

  await expectOk('触发器在允许的 UPDATE 中保留运行态原值', async () => {
    // 先由 Worker 写入运行态
    await as('service_role', null,
      `update public.ita_projects set sandbox_id='sbx-1', preview_url='http://real', status='ready' where id=$1`,
      [projectAId]);
    // 客户端改 name,运行态必须保持不变
    await as('authenticated', USER_A,
      `update public.ita_projects set description='新描述' where id=$1`, [projectAId]);
    const r = await as('authenticated', USER_A,
      `select sandbox_id, preview_url, status from public.ita_projects where id=$1`, [projectAId]);
    const p = r.rows[0];
    if (p.sandbox_id !== 'sbx-1' || p.preview_url !== 'http://real' || p.status !== 'ready') {
      throw new Error(`运行态被篡改: ${JSON.stringify(p)}`);
    }
    return `sandbox_id=${p.sandbox_id} preview_url=${p.preview_url} status=${p.status}`;
  });

  await expectOk('触发器在 INSERT 时强制运行态为默认值', async () => {
    const r = await as('authenticated', USER_A,
      `insert into public.ita_projects(user_id, name) values ($1,'干净项目')
       returning sandbox_id, preview_url, status`, [USER_A]);
    const p = r.rows[0];
    if (p.sandbox_id !== null || p.preview_url !== null || p.status !== 'idle') {
      throw new Error(`运行态未清洗: ${JSON.stringify(p)}`);
    }
    return `sandbox_id=null preview_url=null status=${p.status}`;
  });

  await expectOk('Worker(service_role)仍可写入运行态字段', async () => {
    const r = await as('service_role', null,
      `update public.ita_projects set preview_url='http://sandbox.example', status='running'
       where id=$1 returning preview_url, status`, [projectAId]);
    return `preview_url=${r.rows[0].preview_url} status=${r.rows[0].status}`;
  });

  // ================= 记忆原子 upsert =================
  console.log('\n--- 记忆原子 upsert(ita_upsert_memory)---');
  await expectOk('用户A 通过 RPC 覆盖已有 user 记忆(原子,不先删)', async () => {
    const r = await as('authenticated', USER_A,
      `select value from public.ita_upsert_memory('user','语言','改为偏好英文注释')`);
    return `value=${r.rows[0].value}`;
  });

  await expectOk('RPC 覆盖后记忆仍只有一条,且值已更新', async () => {
    const r = await as('authenticated', USER_A,
      `select count(*)::int as n, min(value) as v from public.ita_memories
       where user_id=$1 and scope='user' and key='语言'`, [USER_A]);
    if (r.rows[0].n !== 1) throw new Error(`记录数异常: ${r.rows[0].n}`);
    return `count=${r.rows[0].n} value=${r.rows[0].v}`;
  });

  await expectOk('用户A 通过 RPC 写 project 记忆', async () => {
    const r = await as('authenticated', USER_A,
      `select scope, project_id from public.ita_upsert_memory('project','存储','改用 IndexedDB',$1)`,
      [projectAId]);
    return `scope=${r.rows[0].scope}`;
  });

  await expectDenied('RPC 写 project 记忆但指向别人的项目', () =>
    as('authenticated', USER_B,
      `select public.ita_upsert_memory('project','越权','x',$1)`, [projectAId]));

  await expectDenied('RPC 写 project 记忆但未提供 project_id', () =>
    as('authenticated', USER_A,
      `select public.ita_upsert_memory('project','缺项目','x')`));

  await expectOk('RPC 的 user 范围强制忽略传入的 project_id', async () => {
    const r = await as('authenticated', USER_A,
      `select project_id from public.ita_upsert_memory('user','忽略测试','v',$1)`, [projectAId]);
    if (r.rows[0].project_id !== null) throw new Error('project_id 未被强制置空');
    return 'project_id=null';
  });

  await expectDenied('anon 调用 ita_upsert_memory', () =>
    as('anon', null, `select public.ita_upsert_memory('user','x','y')`));

  // ================= Worker 身份(service_role,无 JWT)写记忆 =================
  console.log('\n--- Worker 身份记忆写入(service_role,无 request.jwt.claims)---');
  await expectDenied('Worker 调用前端 RPC ita_upsert_memory(auth.uid() 为 NULL)', () =>
    as('service_role', null, `select public.ita_upsert_memory('user','w','v')`));

  await expectDenied('旧 Worker 写法:直接 INSERT ... ON CONFLICT (user_id,key) 无 WHERE 谓词', () =>
    as('service_role', null,
      `insert into public.ita_memories(user_id, project_id, scope, key, value)
       values ($1,null,'user','语言','x')
       on conflict (user_id, key) do update set value=excluded.value`, [USER_A]));

  // 清理前面用例遗留的未结束任务,避免同项目互斥与 claim 顺序干扰
  await as('service_role', null,
    `update public.ita_tasks set status='cancelled', lease_until=null where status in ('queued','running')`);

  // 准备一个由 worker-mem 合法持有租约的 running 任务
  const memTask = await as('authenticated', USER_A,
    `insert into public.ita_tasks(project_id, user_id, mode, prompt)
     values ($1,$2,'build','记忆任务') returning id`, [projectAId, USER_A]);
  const memTaskId = memTask.rows[0].id;
  await as('service_role', null, `select * from public.ita_claim_task('worker-mem',120)`);

  await expectOk('Worker 新入口为合法 running 任务写 user 记忆', async () => {
    const r = await as('service_role', null,
      `select user_id, project_id, value from public.ita_worker_upsert_memory($1,'worker-mem','user','语言','Worker 覆盖')`,
      [memTaskId]);
    const m = r.rows[0];
    if (m.user_id !== USER_A || m.project_id !== null) throw new Error(JSON.stringify(m));
    return `user_id=A project_id=null value=${m.value}`;
  });

  await expectOk('Worker 新入口覆盖后 user 记忆仍只有一条', async () => {
    const r = await as('service_role', null,
      `select count(*)::int n from public.ita_memories where user_id=$1 and scope='user' and key='语言'`, [USER_A]);
    if (r.rows[0].n !== 1) throw new Error(`count=${r.rows[0].n}`);
    return 'count=1';
  });

  await expectOk('Worker 新入口为合法任务写 project 记忆(project_id 取自任务)', async () => {
    const r = await as('service_role', null,
      `select project_id from public.ita_worker_upsert_memory($1,'worker-mem','project','框架','React')`, [memTaskId]);
    if (r.rows[0].project_id !== projectAId) throw new Error('project_id 不等于任务项目');
    return 'project_id=任务所属项目A';
  });

  await expectDenied('Worker 新入口:不存在的任务', () =>
    as('service_role', null,
      `select public.ita_worker_upsert_memory('00000000-0000-0000-0000-000000000000','worker-mem','user','k','v')`));

  await expectDenied('Worker 新入口:租约属于其他 worker', () =>
    as('service_role', null,
      `select public.ita_worker_upsert_memory($1,'other-worker','user','k','v')`, [memTaskId]));

  await expectDenied('Worker 新入口:租约已过期', async () => {
    await as('service_role', null,
      `update public.ita_tasks set lease_until=now()-interval '1 minute' where id=$1`, [memTaskId]);
    return as('service_role', null,
      `select public.ita_worker_upsert_memory($1,'worker-mem','user','k','v')`, [memTaskId]);
  });

  await expectDenied('Worker 新入口:任务已结束(succeeded)', async () => {
    await as('service_role', null,
      `update public.ita_tasks set status='succeeded', lease_until=now()+interval '1 minute' where id=$1`, [memTaskId]);
    return as('service_role', null,
      `select public.ita_worker_upsert_memory($1,'worker-mem','user','k','v')`, [memTaskId]);
  });

  await expectDenied('Worker 新入口:用户B 的任务无法写入用户A 的项目', async () => {
    // B 的 running 任务只能推导出 B 的项目,不存在传入 A 项目的参数;这里验证记忆归属不落到 A
    const t = await as('authenticated', USER_B,
      `insert into public.ita_tasks(project_id, user_id, mode, prompt) values ($1,$2,'build','b') returning id`,
      [projectBId, USER_B]);
    await as('service_role', null, `select * from public.ita_claim_task('worker-b',120)`);
    const r = await as('service_role', null,
      `select user_id, project_id from public.ita_worker_upsert_memory($1,'worker-b','project','k','v')`, [t.rows[0].id]);
    const m = r.rows[0];
    if (m.user_id === USER_A || m.project_id === projectAId) return r; // 若落到 A 则判定越权成功
    throw new Error(`归属被限定为任务本身: user=B project=B`);
  });

  await expectDenied('authenticated 调用 Worker 入口', () =>
    as('authenticated', USER_A,
      `select public.ita_worker_upsert_memory($1,'worker-mem','user','k','v')`, [memTaskId]));

  await expectDenied('anon 调用 Worker 入口', () =>
    as('anon', null,
      `select public.ita_worker_upsert_memory($1,'worker-mem','user','k','v')`, [memTaskId]));

  // ================= 汇总 =================
  const failed = results.filter((r) => !r.ok);
  console.log(`\n========== 汇总: ${results.length - failed.length}/${results.length} 通过 ==========`);
  if (failed.length) {
    failed.forEach((f) => console.log(`FAILED: ${f.name} — ${f.detail}`));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('测试脚本异常:', error);
  process.exit(1);
});
