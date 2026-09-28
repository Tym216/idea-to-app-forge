-- ==========================================================================
-- 0002_plan_review.sql  增量迁移(已执行 0001_init.sql 的项目直接执行本文件,无需重跑 0001)
-- 计划版本 + 用户反馈 + 绑定版本的幂等批准 + 新建/恢复两种重试 + 租约校验的 Worker 写入
-- ==========================================================================

-- ---------------------------------------------------------------- plans
begin;
create table if not exists public.ita_plans (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  version int not null,
  kind text not null default 'plan' check (kind in ('plan', 'action')),
  status text not null default 'draft' check (status in ('draft', 'approved', 'superseded')),
  content jsonb not null,
  source_task_id uuid,
  approved_at timestamptz,
  created_at timestamptz not null default now(),
  unique (project_id, version),
  constraint ita_plans_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);

create table if not exists public.ita_plan_feedback (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.ita_plans(id) on delete cascade,
  plan_version int not null,
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  content text not null default '',
  answers jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ita_plan_feedback_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);
create index if not exists ita_plan_feedback_plan_idx on public.ita_plan_feedback(plan_id, created_at);

-- ---------------------------------------------------------------- tasks 扩展
alter table public.ita_tasks
  add column if not exists plan_id uuid references public.ita_plans(id) on delete set null,
  add column if not exists plan_version int,
  add column if not exists round int,
  add column if not exists kind text not null default 'new',
  add column if not exists retry_of uuid references public.ita_tasks(id) on delete set null,
  add column if not exists resumes int not null default 0,
  add column if not exists last_tool text,
  add column if not exists last_tool_ms int,
  add column if not exists execution_id uuid,               -- 每次领取/接管新生成,Worker 写入必须精确匹配
  add column if not exists total_tool_steps int not null default 0,  -- 历次执行累计(resume 时并入)
  add column if not exists total_fix_rounds int not null default 0;

do $$ begin
  alter table public.ita_tasks add constraint ita_tasks_kind_chk check (kind in ('new', 'resume'));
exception when duplicate_object then null; end $$;

-- 数据库层幂等:同一计划版本只能产生一个「批准构建」任务(重试新建的任务带 retry_of,不受限)
create unique index if not exists ita_tasks_plan_approval_unique
  on public.ita_tasks(plan_id) where mode = 'build' and plan_id is not null and retry_of is null;

-- 已有任务补齐轮次
update public.ita_tasks t set round = s.rn
from (select id, row_number() over (partition by project_id order by created_at) rn from public.ita_tasks) s
where t.id = s.id and t.round is null;

-- 轮次由服务端计算(触发器按名称排序,在 force_initial_state 之后执行)
create or replace function public.ita_tasks_assign_round()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.round := coalesce((select max(t.round) from public.ita_tasks t where t.project_id = new.project_id), 0) + 1;
  return new;
end $$;
drop trigger if exists ita_tasks_round_trg on public.ita_tasks;
create trigger ita_tasks_round_trg before insert on public.ita_tasks
  for each row execute function public.ita_tasks_assign_round();

-- ---------------------------------------------------------------- RLS
alter table public.ita_plans enable row level security;
alter table public.ita_plans force row level security;
alter table public.ita_plan_feedback enable row level security;
alter table public.ita_plan_feedback force row level security;

drop policy if exists ita_plans_owner_select on public.ita_plans;
create policy ita_plans_owner_select on public.ita_plans for select to authenticated
  using (user_id = (select auth.uid()) and public.ita_owns_project(project_id));
drop policy if exists ita_plan_feedback_owner_select on public.ita_plan_feedback;
create policy ita_plan_feedback_owner_select on public.ita_plan_feedback for select to authenticated
  using (user_id = (select auth.uid()) and public.ita_owns_project(project_id));
-- 不创建客户端 INSERT/UPDATE/DELETE 策略:反馈与批准只能走下方 RPC

revoke all on public.ita_plans, public.ita_plan_feedback from public, anon, authenticated;
grant select on public.ita_plans, public.ita_plan_feedback to authenticated;
grant select, insert, update, delete on public.ita_plans, public.ita_plan_feedback to service_role;

-- ---------------------------------------------------------------- 客户端 RPC
-- 批准并构建:绑定正在查看的版本;已有更新版本则拒绝;重复调用返回同一任务
create or replace function public.ita_approve_plan(p_plan_id uuid, p_version int)
returns public.ita_tasks language plpgsql security definer set search_path = '' as $$
declare v_plan public.ita_plans; v_task public.ita_tasks;
begin
  if p_version is null then
    raise exception 'PLAN_VERSION_REQUIRED: 必须提供正在查看的计划版本' using errcode = '22023';
  end if;
  select * into v_plan from public.ita_plans p
  where p.id = p_plan_id and p.user_id = (select auth.uid()) and p.kind = 'plan'
  for update;
  if v_plan.id is null or not exists (
    select 1 from public.ita_projects pr where pr.id = v_plan.project_id and pr.user_id = (select auth.uid())
  ) then
    raise exception 'plan not found or not owned by caller' using errcode = '42501';
  end if;

  -- 1) 精确版本比较(已加锁):错误版本或已有更新版本一律拒绝,即使旧版本曾有批准任务
  if v_plan.version <> p_version or exists (
    select 1 from public.ita_plans n where n.project_id = v_plan.project_id and n.version > v_plan.version
  ) then
    raise exception 'PLAN_VERSION_STALE: 计划已更新,请审阅最新版本后重新批准' using errcode = 'P0001';
  end if;

  -- 2) 同版本重复批准:返回同一任务
  select * into v_task from public.ita_tasks t
  where t.plan_id = v_plan.id and t.mode = 'build' and t.retry_of is null;
  if v_task.id is not null then return v_task; end if;

  -- 3) 首次批准必须是草稿
  if v_plan.status <> 'draft' then
    raise exception 'PLAN_VERSION_STALE: 计划不是待审阅草稿' using errcode = 'P0001';
  end if;

  update public.ita_plans set status = 'approved', approved_at = now() where id = v_plan.id;
  begin
    insert into public.ita_tasks(project_id, user_id, mode, prompt, plan_id, plan_version)
    values (v_plan.project_id, v_plan.user_id, 'build', format('按已批准的计划 v%s 构建', v_plan.version),
            v_plan.id, v_plan.version)
    returning * into v_task;
  exception when unique_violation then
    select * into v_task from public.ita_tasks t
    where t.plan_id = v_plan.id and t.mode = 'build' and t.retry_of is null;
    if v_task.id is null then
      raise exception 'PROJECT_BUSY: 该项目已有正在执行的任务' using errcode = 'P0001';
    end if;
  end;
  return v_task;
end $$;

-- 对计划提意见/回答问题:持久化反馈并排队一个 Plan 任务生成新版本
create or replace function public.ita_revise_plan(p_plan_id uuid, p_version int, p_feedback text, p_answers jsonb default '{}'::jsonb)
returns public.ita_tasks language plpgsql security definer set search_path = '' as $$
declare v_plan public.ita_plans; v_task public.ita_tasks;
begin
  if p_version is null then
    raise exception 'PLAN_VERSION_REQUIRED: 必须提供正在查看的计划版本' using errcode = '22023';
  end if;
  select * into v_plan from public.ita_plans p
  where p.id = p_plan_id and p.user_id = (select auth.uid()) and p.kind = 'plan'
  for update;
  if v_plan.id is null or not exists (
    select 1 from public.ita_projects pr where pr.id = v_plan.project_id and pr.user_id = (select auth.uid())
  ) then
    raise exception 'plan not found or not owned by caller' using errcode = '42501';
  end if;
  if v_plan.version <> p_version or v_plan.status <> 'draft' or exists (
    select 1 from public.ita_plans n where n.project_id = v_plan.project_id and n.version > v_plan.version
  ) then
    raise exception 'PLAN_VERSION_STALE: 计划已更新,请在最新版本上反馈' using errcode = 'P0001';
  end if;
  if coalesce(btrim(p_feedback), '') = '' and coalesce(p_answers, '{}'::jsonb) = '{}'::jsonb then
    raise exception 'feedback is empty' using errcode = '22023';
  end if;

  insert into public.ita_plan_feedback(plan_id, plan_version, project_id, user_id, content, answers)
  values (v_plan.id, v_plan.version, v_plan.project_id, v_plan.user_id, coalesce(p_feedback, ''), coalesce(p_answers, '{}'::jsonb));

  begin
    insert into public.ita_tasks(project_id, user_id, mode, prompt, plan_id, plan_version)
    values (v_plan.project_id, v_plan.user_id, 'plan',
            coalesce(nullif(btrim(p_feedback), ''), '回答了计划中的问题'), v_plan.id, v_plan.version)
    returning * into v_task;
  exception when unique_violation then
    raise exception 'PROJECT_BUSY: 该项目已有正在执行的任务' using errcode = 'P0001';
  end;
  return v_task;
end $$;

-- 重试:new = 新建一轮任务(保留原失败记录);resume = 恢复原任务(沿用轮次、步骤与已写代码)
create or replace function public.ita_retry_task(p_task_id uuid, p_kind text)
returns public.ita_tasks language plpgsql security definer set search_path = '' as $$
declare v_old public.ita_tasks; v_task public.ita_tasks;
begin
  if p_kind not in ('new', 'resume') then raise exception 'invalid retry kind' using errcode = '22023'; end if;
  select * into v_old from public.ita_tasks t
  where t.id = p_task_id and t.user_id = (select auth.uid())
    and exists (select 1 from public.ita_projects pr where pr.id = t.project_id and pr.user_id = (select auth.uid()))
  for update;
  if v_old.id is null then raise exception 'task not found or not owned by caller' using errcode = '42501'; end if;
  if v_old.status not in ('failed', 'cancelled') then
    raise exception 'only failed or cancelled tasks can be retried' using errcode = 'P0001';
  end if;

  begin
    if p_kind = 'resume' then
      if v_old.resumes >= 3 then
        raise exception 'RESUME_LIMIT: 该任务已恢复 3 次,请改用「新建任务」重试' using errcode = 'P0001';
      end if;
      -- 恢复 = 新的执行预算:本次步数/修复轮数清零,历史累计并入 total_*;失败原因保留在 steps
      update public.ita_tasks set
        status = 'queued', phase = 'resumed', kind = 'resume', resumes = resumes + 1,
        total_tool_steps = total_tool_steps + tool_steps, total_fix_rounds = total_fix_rounds + fix_rounds,
        tool_steps = 0, fix_rounds = 0, execution_id = null,
        steps = steps || jsonb_build_array(jsonb_build_object(
          'tool', 'resume', 'phase', 'resumed', 'at', now(),
          'observation', '恢复任务;上次失败原因: ' || left(coalesce(error, '(无)'), 300))),
        error = null, worker_id = null, lease_until = null, finished_at = null, updated_at = now()
      where id = v_old.id returning * into v_task;
    else
      insert into public.ita_tasks(project_id, user_id, mode, prompt, plan_id, plan_version, kind, retry_of)
      values (v_old.project_id, v_old.user_id, v_old.mode, v_old.prompt, v_old.plan_id, v_old.plan_version, 'new', v_old.id)
      returning * into v_task;
    end if;
  exception when unique_violation then
    raise exception 'PROJECT_BUSY: 该项目已有正在执行的任务' using errcode = 'P0001';
  end;
  return v_task;
end $$;

-- ---------------------------------------------------------------- Worker RPC(仅 service_role)
-- 旧签名(不含 execution_id)全部移除,重复执行本文件时 IF EXISTS 保证幂等
drop function if exists public.ita_heartbeat_task(uuid, text, int);
drop function if exists public.ita_worker_upsert_memory(uuid, text, text, text, text, int);
drop function if exists public.ita_worker_check_lease(uuid, text);
drop function if exists public.ita_worker_update_task(uuid, text, jsonb);
drop function if exists public.ita_worker_save_plan(uuid, text, text, jsonb);
drop function if exists public.ita_heartbeat_task(uuid, text, uuid, int);
drop function if exists public.ita_worker_upsert_memory(uuid, text, uuid, text, text, text, int);
drop function if exists public.ita_worker_check_lease(uuid, text, uuid);
drop function if exists public.ita_worker_update_task(uuid, text, uuid, jsonb);
drop function if exists public.ita_worker_save_plan(uuid, text, uuid, text, jsonb);

-- 领取/接管:每次生成新的 execution_id(同一 worker_id 超时后再领也不同)
create or replace function public.ita_claim_task(p_worker_id text, p_lease_seconds int default 120)
returns setof public.ita_tasks language plpgsql security definer set search_path = '' as $$
begin
  return query
  with candidate as (
    select t.id from public.ita_tasks t
    where (t.status = 'queued' or (t.status = 'running' and t.lease_until is not null and t.lease_until < now()))
      and not exists (
        select 1 from public.ita_tasks r
        where r.project_id = t.project_id and r.status = 'running'
          and r.lease_until is not null and r.lease_until >= now())
    order by t.created_at
    for update skip locked
    limit 1
  )
  update public.ita_tasks u
  set status = 'running', phase = 'claimed', worker_id = p_worker_id,
      execution_id = gen_random_uuid(),
      attempts = u.attempts + 1,
      lease_until = now() + make_interval(secs => p_lease_seconds),
      heartbeat_at = now(), started_at = coalesce(u.started_at, now()), updated_at = now()
  from candidate c
  where u.id = c.id
  returning u.*;
end $$;

-- 心跳:必须同一执行(execution_id)且租约未过期;返回是否续约成功
create or replace function public.ita_heartbeat_task(
  p_task_id uuid, p_worker_id text, p_execution_id uuid, p_lease_seconds int default 120)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  update public.ita_tasks
  set heartbeat_at = now(), lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where id = p_task_id and worker_id = p_worker_id and execution_id = p_execution_id
    and status = 'running' and lease_until is not null and lease_until >= now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end $$;

-- Worker 记忆写入:归属取自当前执行持有的 running 任务
create or replace function public.ita_worker_upsert_memory(
  p_task_id uuid, p_worker_id text, p_execution_id uuid,
  p_scope text, p_key text, p_value text, p_weight int default 1)
returns public.ita_memories language plpgsql security definer set search_path = '' as $$
declare v_task public.ita_tasks; v_row public.ita_memories;
begin
  if p_scope not in ('user', 'project') then
    raise exception 'invalid scope: %', p_scope using errcode = '22023';
  end if;
  select t.* into v_task from public.ita_tasks t
  join public.ita_projects p on p.id = t.project_id and p.user_id = t.user_id
  where t.id = p_task_id and t.status = 'running' and t.worker_id = p_worker_id
    and t.execution_id = p_execution_id
    and t.lease_until is not null and t.lease_until >= now()
  for update of t;
  if v_task.id is null then
    raise exception 'LEASE_LOST: task not running under this execution or lease expired' using errcode = '42501';
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

-- 租约是否仍由该执行持有(以数据库时钟为准)
create or replace function public.ita_worker_check_lease(p_task_id uuid, p_worker_id text, p_execution_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.ita_tasks t
    where t.id = p_task_id and t.worker_id = p_worker_id and t.execution_id = p_execution_id
      and t.status = 'running' and t.lease_until is not null and t.lease_until >= now()
  );
$$;

-- 租约校验的任务写入:只更新白名单字段;租约失效返回 false(调用方必须中止执行)
create or replace function public.ita_worker_update_task(p_task_id uuid, p_worker_id text, p_execution_id uuid, p_patch jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  update public.ita_tasks t set
    phase        = case when p_patch ? 'phase' then p_patch->>'phase' else t.phase end,
    status       = case when p_patch ? 'status' and p_patch->>'status' in ('succeeded', 'failed')
                        then p_patch->>'status' else t.status end,
    steps        = case when p_patch ? 'steps' then p_patch->'steps' else t.steps end,
    plan         = case when p_patch ? 'plan' then p_patch->'plan' else t.plan end,
    error        = case when p_patch ? 'error' then p_patch->>'error' else t.error end,
    tool_steps   = case when p_patch ? 'tool_steps' then (p_patch->>'tool_steps')::int else t.tool_steps end,
    fix_rounds   = case when p_patch ? 'fix_rounds' then (p_patch->>'fix_rounds')::int else t.fix_rounds end,
    last_tool    = case when p_patch ? 'last_tool' then p_patch->>'last_tool' else t.last_tool end,
    last_tool_ms = case when p_patch ? 'last_tool_ms' then (p_patch->>'last_tool_ms')::int else t.last_tool_ms end,
    plan_id      = case when p_patch ? 'plan_id' then (p_patch->>'plan_id')::uuid else t.plan_id end,
    plan_version = case when p_patch ? 'plan_version' then (p_patch->>'plan_version')::int else t.plan_version end,
    finished_at  = case when p_patch->>'status' in ('succeeded', 'failed') then now() else t.finished_at end,
    lease_until  = case when p_patch->>'status' in ('succeeded', 'failed') then null else t.lease_until end,
    updated_at   = now()
  where t.id = p_task_id and t.worker_id = p_worker_id and t.execution_id = p_execution_id
    and t.status = 'running' and t.lease_until is not null and t.lease_until >= now();
  get diagnostics v_count = row_count;
  return v_count = 1;
end $$;

-- 保存计划版本(租约校验);kind=plan 为待审阅草稿,kind=action 为直接 Build 的简短行动计划(视为已授权)
create or replace function public.ita_worker_save_plan(p_task_id uuid, p_worker_id text, p_execution_id uuid, p_kind text, p_content jsonb)
returns public.ita_plans language plpgsql security definer set search_path = '' as $$
declare v_task public.ita_tasks; v_plan public.ita_plans; v_version int;
begin
  select * into v_task from public.ita_tasks t
  where t.id = p_task_id and t.worker_id = p_worker_id and t.execution_id = p_execution_id
    and t.status = 'running'
    and t.lease_until is not null and t.lease_until >= now()
  for update;
  if v_task.id is null then raise exception 'LEASE_LOST' using errcode = 'P0001'; end if;
  if p_kind not in ('plan', 'action') then raise exception 'invalid plan kind' using errcode = '22023'; end if;

  perform 1 from public.ita_projects pr where pr.id = v_task.project_id for update;  -- 版本号串行
  select coalesce(max(p.version), 0) + 1 into v_version from public.ita_plans p where p.project_id = v_task.project_id;
  if p_kind = 'plan' then
    update public.ita_plans set status = 'superseded'
    where project_id = v_task.project_id and kind = 'plan' and status = 'draft';
  end if;
  insert into public.ita_plans(project_id, user_id, version, kind, status, content, source_task_id, approved_at)
  values (v_task.project_id, v_task.user_id, v_version, p_kind,
          case when p_kind = 'action' then 'approved' else 'draft' end, p_content, v_task.id,
          case when p_kind = 'action' then now() end)
  returning * into v_plan;
  return v_plan;
end $$;

-- ---------------------------------------------------------------- 函数授权
revoke all on function public.ita_tasks_assign_round() from public, anon, authenticated;
revoke all on function public.ita_approve_plan(uuid, int) from public, anon;
revoke all on function public.ita_revise_plan(uuid, int, text, jsonb) from public, anon;
revoke all on function public.ita_retry_task(uuid, text) from public, anon;
revoke all on function public.ita_claim_task(text, int) from public, anon, authenticated;
revoke all on function public.ita_heartbeat_task(uuid, text, uuid, int) from public, anon, authenticated;
revoke all on function public.ita_worker_upsert_memory(uuid, text, uuid, text, text, text, int) from public, anon, authenticated;
revoke all on function public.ita_worker_check_lease(uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.ita_worker_update_task(uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke all on function public.ita_worker_save_plan(uuid, text, uuid, text, jsonb) from public, anon, authenticated;

grant execute on function public.ita_approve_plan(uuid, int) to authenticated;
grant execute on function public.ita_revise_plan(uuid, int, text, jsonb) to authenticated;
grant execute on function public.ita_retry_task(uuid, text) to authenticated;
grant execute on function public.ita_claim_task(text, int) to service_role;
grant execute on function public.ita_heartbeat_task(uuid, text, uuid, int) to service_role;
grant execute on function public.ita_worker_upsert_memory(uuid, text, uuid, text, text, text, int) to service_role;
grant execute on function public.ita_worker_check_lease(uuid, text, uuid) to service_role;
grant execute on function public.ita_worker_update_task(uuid, text, uuid, jsonb) to service_role;
grant execute on function public.ita_worker_save_plan(uuid, text, uuid, text, jsonb) to service_role;
commit;
