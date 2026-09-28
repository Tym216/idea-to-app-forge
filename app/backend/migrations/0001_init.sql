-- Forge (idea-to-app) 初始数据库迁移(安全加固版)
-- 在 Supabase SQL Editor 中整体执行。所有表使用 ita_ 前缀。
-- 用户表由 Supabase auth.users 提供,这里不创建用户表。
--
-- 安全模型要点:
--   1. 所有项目关联表同时校验 user_id 与项目归属(复合外键 + RLS EXISTS),
--      堵死「自己的 user_id + 别人的 project_id」。
--   2. 客户端不能写入任何任务执行态字段,取消任务只能通过受控 RPC。
--   3. 所有权限显式 GRANT,不依赖 Supabase 默认自动授权。
--   4. SECURITY DEFINER 函数固定 search_path 并使用 schema 限定名。
--   5. 记忆的 scope 与 project_id 由 CHECK 约束强制对应。

begin;

-- ---------------------------------------------------------------- projects
create table if not exists public.ita_projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  name text not null,
  description text not null default '',
  framework text not null default 'vite-react',
  sandbox_id text,
  preview_url text,
  status text not null default 'idle',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists ita_projects_user_idx on public.ita_projects(user_id, updated_at desc);

-- 复合唯一约束:作为所有子表「项目归属」复合外键的引用目标。
alter table public.ita_projects drop constraint if exists ita_projects_id_user_key;
alter table public.ita_projects add constraint ita_projects_id_user_key unique (id, user_id);

-- 运行态字段(sandbox_id / preview_url / status)只能由 Worker(service_role)写入。
-- 客户端即使绕过列级授权(例如通过其它路径提交),触发器也会强制回写原值/默认值。
create or replace function public.ita_projects_guard_runtime_fields()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  -- service_role / 超级角色是 Worker 通道,放行
  -- 注意:current_user 是 SQL 保留关键字,不能加 schema 限定
  if pg_catalog.current_setting('role', true) = 'service_role'
     or pg_catalog.pg_has_role(current_user, 'service_role', 'MEMBER') then
    return new;
  end if;

  if TG_OP = 'INSERT' then
    new.sandbox_id  := null;
    new.preview_url := null;
    new.status      := 'idle';
    new.created_at  := now();
    new.updated_at  := now();
  else
    new.sandbox_id  := old.sandbox_id;
    new.preview_url := old.preview_url;
    new.status      := old.status;
    new.user_id     := old.user_id;
    new.created_at  := old.created_at;
    new.updated_at  := now();
  end if;
  return new;
end $$;

drop trigger if exists ita_projects_guard_runtime_fields_trg on public.ita_projects;
create trigger ita_projects_guard_runtime_fields_trg
  before insert or update on public.ita_projects
  for each row execute function public.ita_projects_guard_runtime_fields();

-- ---------------------------------------------------------------- messages
create table if not exists public.ita_messages (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in ('user', 'assistant', 'tool', 'system')),
  content text not null default '',
  meta jsonb not null default '{}'::jsonb,
  task_id uuid,
  created_at timestamptz not null default now(),
  -- 数据库层强制:project 必须属于同一个 user
  constraint ita_messages_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);
create index if not exists ita_messages_project_idx on public.ita_messages(project_id, created_at);

-- ------------------------------------------------------------------- tasks
-- 任务是服务端推进的唯一真相来源;前端只能创建与取消,不能写执行态字段。
create table if not exists public.ita_tasks (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  mode text not null default 'build' check (mode in ('plan', 'build')),
  prompt text not null,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  phase text not null default 'queued',
  plan jsonb not null default '[]'::jsonb,
  steps jsonb not null default '[]'::jsonb,
  error text,
  attempts int not null default 0,
  fix_rounds int not null default 0,
  tool_steps int not null default 0,
  worker_id text,
  lease_until timestamptz,
  heartbeat_at timestamptz,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ita_tasks_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);
create index if not exists ita_tasks_claim_idx on public.ita_tasks(status, created_at);
create index if not exists ita_tasks_project_idx on public.ita_tasks(project_id, created_at desc);
-- 同一项目同时只允许一个未结束任务(互斥)
create unique index if not exists ita_tasks_active_unique
  on public.ita_tasks(project_id) where status in ('queued', 'running');

-- 强制覆盖所有执行态字段:无论客户端提交什么,新任务一律是干净的 queued。
create or replace function public.ita_tasks_force_initial_state()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.status       := 'queued';
  new.phase        := 'queued';
  new.plan         := '[]'::jsonb;
  new.steps        := '[]'::jsonb;
  new.error        := null;
  new.attempts     := 0;
  new.fix_rounds   := 0;
  new.tool_steps   := 0;
  new.worker_id    := null;
  new.lease_until  := null;
  new.heartbeat_at := null;
  new.started_at   := null;
  new.finished_at  := null;
  new.created_at   := now();
  new.updated_at   := now();
  return new;
end $$;

drop trigger if exists ita_tasks_force_initial_state_trg on public.ita_tasks;
create trigger ita_tasks_force_initial_state_trg
  before insert on public.ita_tasks
  for each row execute function public.ita_tasks_force_initial_state();

-- ------------------------------------------------------------------- files
create table if not exists public.ita_files (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  path text not null,
  content text not null default '',
  version int not null default 1,
  deleted boolean not null default false,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  unique (project_id, path),
  constraint ita_files_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);
create index if not exists ita_files_project_idx on public.ita_files(project_id, path);

-- 完整代码快照:Sandbox 丢失后可用于恢复
create table if not exists public.ita_snapshots (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  task_id uuid,
  label text not null default '',
  files jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint ita_snapshots_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);
create index if not exists ita_snapshots_project_idx on public.ita_snapshots(project_id, created_at desc);

-- ----------------------------------------------------------------- memories
-- scope = 'user'   : 跨项目的用户偏好,project_id 必须为 NULL
-- scope = 'project': 单项目的已确认约定,project_id 必须非空且属于本人
create table if not exists public.ita_memories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  project_id uuid,
  scope text not null check (scope in ('user', 'project')),
  key text not null,
  value text not null,
  weight int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ita_memories_scope_project_ck check (
    (scope = 'user' and project_id is null) or
    (scope = 'project' and project_id is not null)
  ),
  -- project_id 为 NULL 时 MATCH SIMPLE 外键不校验,正好适配 user 范围
  constraint ita_memories_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);
-- scope 与 project_id 已互斥,拆成两个部分唯一索引,避免 coalesce 伪 UUID
create unique index if not exists ita_memories_user_scope_unique
  on public.ita_memories(user_id, key) where scope = 'user';
create unique index if not exists ita_memories_project_scope_unique
  on public.ita_memories(user_id, project_id, key) where scope = 'project';

-- ==========================================================================
-- Row Level Security
-- ==========================================================================
alter table public.ita_projects  enable row level security;
alter table public.ita_messages  enable row level security;
alter table public.ita_tasks     enable row level security;
alter table public.ita_files     enable row level security;
alter table public.ita_snapshots enable row level security;
alter table public.ita_memories  enable row level security;

-- 表属主默认绕过 RLS,这里显式 FORCE 让策略同样作用于表属主。
-- 注意边界:FORCE ROW LEVEL SECURITY 对拥有 BYPASSRLS 属性的角色(Supabase 的
-- service_role、postgres 超级角色)仍然无效——这些角色按设计可绕过 RLS。
-- 因此 Worker 侧的隔离不依赖 RLS,而依赖代码中对 user_id / project_id 的显式校验。
alter table public.ita_projects  force row level security;
alter table public.ita_messages  force row level security;
alter table public.ita_tasks     force row level security;
alter table public.ita_files     force row level security;
alter table public.ita_snapshots force row level security;
alter table public.ita_memories  force row level security;

-- ---- projects:仅本人
drop policy if exists ita_projects_owner_all on public.ita_projects;
create policy ita_projects_owner_all on public.ita_projects
  for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ---- 项目关联表:同时校验 user_id 与项目归属
-- 复合外键已在数据库层强制,这里的 EXISTS 再做一次 RLS 层拦截(纵深防御)。
create or replace function public.ita_owns_project(p_project_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = ''
as $$
  select exists (
    select 1 from public.ita_projects p
    where p.id = p_project_id and p.user_id = (select auth.uid())
  );
$$;

drop policy if exists ita_messages_owner_all on public.ita_messages;
create policy ita_messages_owner_all on public.ita_messages
  for all to authenticated
  using (user_id = (select auth.uid()) and public.ita_owns_project(project_id))
  with check (user_id = (select auth.uid()) and public.ita_owns_project(project_id));

drop policy if exists ita_files_owner_all on public.ita_files;
create policy ita_files_owner_all on public.ita_files
  for all to authenticated
  using (user_id = (select auth.uid()) and public.ita_owns_project(project_id))
  with check (user_id = (select auth.uid()) and public.ita_owns_project(project_id));

drop policy if exists ita_snapshots_owner_all on public.ita_snapshots;
create policy ita_snapshots_owner_all on public.ita_snapshots
  for all to authenticated
  using (user_id = (select auth.uid()) and public.ita_owns_project(project_id))
  with check (user_id = (select auth.uid()) and public.ita_owns_project(project_id));

drop policy if exists ita_memories_owner_all on public.ita_memories;
create policy ita_memories_owner_all on public.ita_memories
  for all to authenticated
  using (
    user_id = (select auth.uid())
    and (project_id is null or public.ita_owns_project(project_id))
  )
  with check (
    user_id = (select auth.uid())
    and (project_id is null or public.ita_owns_project(project_id))
  );

-- ---- tasks:客户端只能 SELECT 自己的任务 + INSERT 新任务,没有 UPDATE/DELETE 策略
drop policy if exists ita_tasks_owner_all on public.ita_tasks;
drop policy if exists ita_tasks_owner_select on public.ita_tasks;
create policy ita_tasks_owner_select on public.ita_tasks
  for select to authenticated
  using (user_id = (select auth.uid()) and public.ita_owns_project(project_id));

drop policy if exists ita_tasks_owner_insert on public.ita_tasks;
create policy ita_tasks_owner_insert on public.ita_tasks
  for insert to authenticated
  with check (user_id = (select auth.uid()) and public.ita_owns_project(project_id));
-- 注意:故意不创建 UPDATE / DELETE 策略。取消任务必须走 public.ita_cancel_task()。

-- ==========================================================================
-- 显式最小权限授权(兼容关闭了自动授权的新 Supabase 项目)
-- ==========================================================================
grant usage on schema public to anon, authenticated, service_role;

-- anon(未登录):不授予任何业务表权限
revoke all on public.ita_projects, public.ita_messages, public.ita_tasks,
             public.ita_files, public.ita_snapshots, public.ita_memories
  from public, anon, authenticated;

-- authenticated:按表按列的最小集合
-- 项目:sandbox_id / preview_url / status 是 Worker 运行态字段,客户端无写权限
grant select, delete on public.ita_projects to authenticated;
grant insert (id, user_id, name, description, framework) on public.ita_projects to authenticated;
grant update (name, description, framework)              on public.ita_projects to authenticated;
grant select, insert, delete         on public.ita_messages  to authenticated;
grant select, insert, update, delete on public.ita_memories  to authenticated;
grant select                          on public.ita_files     to authenticated;
grant select                          on public.ita_snapshots to authenticated;
-- 任务:只能读 + 只能写这 4 个业务列,执行态字段无写权限
grant select on public.ita_tasks to authenticated;
grant insert (project_id, user_id, mode, prompt) on public.ita_tasks to authenticated;

-- service_role(仅 Worker 使用,绕过 RLS,但仍需显式表权限)
grant select, insert, update, delete on public.ita_projects, public.ita_messages,
      public.ita_tasks, public.ita_files, public.ita_snapshots, public.ita_memories
  to service_role;

-- ==========================================================================
-- 函数:Worker 任务领取 / 心跳,以及客户端受控取消
-- ==========================================================================

-- Worker 原子领取任务:租约 + 同项目互斥 + 重复执行保护
create or replace function public.ita_claim_task(p_worker_id text, p_lease_seconds int default 120)
returns setof public.ita_tasks
language plpgsql
security definer
set search_path = ''
as $$
begin
  return query
  with candidate as (
    select t.id
    from public.ita_tasks t
    where (
        t.status = 'queued'
        or (t.status = 'running' and t.lease_until is not null and t.lease_until < now())
      )
      and not exists (
        select 1 from public.ita_tasks r
        where r.project_id = t.project_id
          and r.status = 'running'
          and r.lease_until is not null
          and r.lease_until >= now()
      )
    order by t.created_at
    for update skip locked
    limit 1
  )
  update public.ita_tasks u
  set status      = 'running',
      phase       = 'claimed',
      worker_id   = p_worker_id,
      attempts    = u.attempts + 1,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(),
      started_at  = coalesce(u.started_at, now()),
      updated_at  = now()
  from candidate c
  where u.id = c.id
  returning u.*;
end $$;

create or replace function public.ita_heartbeat_task(
  p_task_id uuid, p_worker_id text, p_lease_seconds int default 120)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.ita_tasks
  set heartbeat_at = now(),
      lease_until  = now() + make_interval(secs => p_lease_seconds),
      updated_at   = now()
  where id = p_task_id and worker_id = p_worker_id and status = 'running';
$$;

-- 客户端受控取消:只能取消本人且属于本人项目的任务,且只允许 queued/running -> cancelled
create or replace function public.ita_cancel_task(p_task_id uuid)
returns public.ita_tasks
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.ita_tasks;
begin
  update public.ita_tasks t
  set status      = 'cancelled',
      phase       = 'cancelled',
      finished_at = now(),
      lease_until = null,
      updated_at  = now()
  where t.id = p_task_id
    and t.user_id = (select auth.uid())
    and exists (
      select 1 from public.ita_projects p
      where p.id = t.project_id and p.user_id = (select auth.uid())
    )
    and t.status in ('queued', 'running')
  returning t.* into v_task;

  if v_task.id is null then
    raise exception 'task not found, not owned by caller, or not cancellable'
      using errcode = '42501';
  end if;
  return v_task;
end $$;

-- 记忆原子写入:在单个语句/事务内完成 upsert,避免「先删后插」中途失败丢失原记忆。
-- 唯一约束是两个部分索引,这里用条件化的 ON CONFLICT 目标显式命中。
create or replace function public.ita_upsert_memory(
  p_scope text,
  p_key text,
  p_value text,
  p_project_id uuid default null,
  p_weight int default 1
)
returns public.ita_memories
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_project uuid;
  v_row public.ita_memories;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '42501';
  end if;
  if p_scope not in ('user', 'project') then
    raise exception 'invalid scope: %', p_scope using errcode = '22023';
  end if;

  -- scope 决定 project_id:user 范围强制为 NULL,project 范围必须属于调用者
  v_project := case when p_scope = 'project' then p_project_id else null end;
  if p_scope = 'project' then
    if v_project is null then
      raise exception 'project scope requires project_id' using errcode = '22023';
    end if;
    if not exists (
      select 1 from public.ita_projects p where p.id = v_project and p.user_id = v_uid
    ) then
      raise exception 'project not found or not owned by caller' using errcode = '42501';
    end if;
  end if;

  if p_scope = 'user' then
    insert into public.ita_memories(user_id, project_id, scope, key, value, weight)
    values (v_uid, null, 'user', p_key, p_value, p_weight)
    on conflict (user_id, key) where scope = 'user'
    do update set value = excluded.value, weight = excluded.weight, updated_at = now()
    returning * into v_row;
  else
    insert into public.ita_memories(user_id, project_id, scope, key, value, weight)
    values (v_uid, v_project, 'project', p_key, p_value, p_weight)
    on conflict (user_id, project_id, key) where scope = 'project'
    do update set value = excluded.value, weight = excluded.weight, updated_at = now()
    returning * into v_row;
  end if;

  return v_row;
end $$;

-- Worker 专用记忆原子写入:Worker 使用 service_role,没有用户 JWT,auth.uid() 为 NULL,
-- 因此不能复用 ita_upsert_memory。这里不接受调用方传入 user_id,
-- 用户与项目归属一律从「当前租约持有的 running 任务」推导。
create or replace function public.ita_worker_upsert_memory(
  p_task_id uuid,
  p_worker_id text,
  p_scope text,
  p_key text,
  p_value text,
  p_weight int default 1
)
returns public.ita_memories
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_task public.ita_tasks;
  v_row public.ita_memories;
begin
  if p_scope not in ('user', 'project') then
    raise exception 'invalid scope: %', p_scope using errcode = '22023';
  end if;

  select t.* into v_task
  from public.ita_tasks t
  join public.ita_projects p on p.id = t.project_id and p.user_id = t.user_id
  where t.id = p_task_id
    and t.status = 'running'
    and t.worker_id = p_worker_id
    and t.lease_until is not null
    and t.lease_until >= now();

  if v_task.id is null then
    raise exception 'task not found, not running, not leased by this worker, or lease expired'
      using errcode = '42501';
  end if;

  if p_scope = 'user' then
    insert into public.ita_memories(user_id, project_id, scope, key, value, weight)
    values (v_task.user_id, null, 'user', p_key, p_value, p_weight)
    on conflict (user_id, key) where scope = 'user'
    do update set value = excluded.value, weight = excluded.weight, updated_at = now()
    returning * into v_row;
  else
    insert into public.ita_memories(user_id, project_id, scope, key, value, weight)
    values (v_task.user_id, v_task.project_id, 'project', p_key, p_value, p_weight)
    on conflict (user_id, project_id, key) where scope = 'project'
    do update set value = excluded.value, weight = excluded.weight, updated_at = now()
    returning * into v_row;
  end if;

  return v_row;
end $$;

revoke all on function public.ita_worker_upsert_memory(uuid, text, text, text, text, int)
  from public, anon, authenticated;
grant execute on function public.ita_worker_upsert_memory(uuid, text, text, text, text, int)
  to service_role;

-- 函数 EXECUTE:撤销默认授权,按角色精确下发
revoke all on function public.ita_claim_task(text, int)             from public, anon, authenticated;
revoke all on function public.ita_heartbeat_task(uuid, text, int)   from public, anon, authenticated;
revoke all on function public.ita_cancel_task(uuid)                 from public, anon;
revoke all on function public.ita_owns_project(uuid)                from public, anon;
revoke all on function public.ita_tasks_force_initial_state()       from public, anon, authenticated;
revoke all on function public.ita_projects_guard_runtime_fields()   from public, anon, authenticated;
revoke all on function public.ita_upsert_memory(text, text, text, uuid, int) from public, anon;

grant execute on function public.ita_upsert_memory(text, text, text, uuid, int)
  to authenticated, service_role;

grant execute on function public.ita_claim_task(text, int)           to service_role;
grant execute on function public.ita_heartbeat_task(uuid, text, int) to service_role;
grant execute on function public.ita_cancel_task(uuid)               to authenticated, service_role;
grant execute on function public.ita_owns_project(uuid)              to authenticated, service_role;

commit;
