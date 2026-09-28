-- ==========================================================================
-- 0003_deletion_retention.sql  增量迁移(依赖 0001 → 0002,不需要重跑 0001/0002)
-- 两阶段项目删除(服务端清理 Daytona 沙箱)+ 删除期间阻断写入
-- 记忆:全局偏好可停用;对话中只生成「保存为默认偏好?」建议,由用户确认
-- 质量反馈 ita_task_feedback;最小审计 ita_audit_log(默认保留 90 天,可配置)
-- ==========================================================================
begin;
-- ---------------------------------------------------------------- 列扩展
-- 删除状态用独立列:0001 的运行态守卫只允许 Worker 写 status,独立列不受其影响,且客户端无列级 UPDATE 权限
alter table public.ita_projects
  add column if not exists deletion_state text,
  add column if not exists delete_requested_at timestamptz,
  add column if not exists delete_error text;
do $$ begin
  alter table public.ita_projects add constraint ita_projects_deletion_state_chk
    check (deletion_state is null or deletion_state in ('deleting', 'delete_failed'));
exception when duplicate_object then null; end $$;

alter table public.ita_memories add column if not exists enabled boolean not null default true;

-- ---------------------------------------------------------------- 新表
-- 删除队列:仅 service_role 可访问;不设项目外键(项目删除后由函数显式移除)
create table if not exists public.ita_project_deletions (
  project_id uuid primary key,
  user_id uuid not null references auth.users(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'running', 'failed')),
  attempts int not null default 0,
  worker_id text,
  lease_until timestamptz,
  last_error text,
  requested_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 「保存为默认偏好?」建议:用户确认前不跨项目使用
create table if not exists public.ita_memory_suggestions (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  source_task_id uuid references public.ita_tasks(id) on delete set null,
  key text not null check (char_length(key) between 1 and 80),
  value text not null check (char_length(value) between 1 and 500),
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  constraint ita_memory_suggestions_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);
create unique index if not exists ita_memory_suggestions_pending_unique
  on public.ita_memory_suggestions(project_id, key) where status = 'pending';

-- 质量反馈:关联任务与执行版本;���项目级联删除
create table if not exists public.ita_task_feedback (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.ita_tasks(id) on delete cascade,
  execution_id uuid,
  project_id uuid not null,
  user_id uuid not null references auth.users(id) on delete cascade,
  category text not null
    check (category in ('missing_feature', 'preview_broken', 'stuck', 'design_mismatch', 'other')),
  note text not null default '' check (char_length(note) <= 1000),
  created_at timestamptz not null default now(),
  constraint ita_task_feedback_project_owner_fk
    foreign key (project_id, user_id) references public.ita_projects(id, user_id) on delete cascade
);
create index if not exists ita_task_feedback_task_idx on public.ita_task_feedback(task_id, created_at desc);

-- 审计:独立于项目,不级联;只存必要元数据(不存需求/代码/密钥/提示词/带令牌 URL)
create table if not exists public.ita_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid,
  action text not null,
  result text not null check (result in ('success', 'failure', 'requested')),
  request_id text not null,
  occurred_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (octet_length(metadata::text) <= 2000)
);
create index if not exists ita_audit_log_time_idx on public.ita_audit_log(occurred_at);
create index if not exists ita_audit_log_actor_idx on public.ita_audit_log(actor_id, occurred_at desc);

-- ---------------------------------------------------------------- 审计辅助(不对任何客户端角色开放)
create or replace function public.ita_request_id(p_request_id text)
returns text language plpgsql stable set search_path = '' as $$
declare v_header text;
begin
  begin
    v_header := (nullif(pg_catalog.current_setting('request.headers', true), '')::jsonb) ->> 'x-request-id';
  exception when others then v_header := null;
  end;
  return coalesce(nullif(left(p_request_id, 64), ''), nullif(left(v_header, 64), ''), gen_random_uuid()::text);
end $$;

create or replace function public.ita_audit(p_actor uuid, p_action text, p_result text, p_request_id text, p_metadata jsonb default '{}'::jsonb)
returns void language plpgsql security definer set search_path = '' as $$
begin
  insert into public.ita_audit_log(actor_id, action, result, request_id, metadata)
  values (p_actor, p_action, p_result, public.ita_request_id(p_request_id), coalesce(p_metadata, '{}'::jsonb));
end $$;

-- 批准计划审计:在计划变为 approved 时记录(失败的批准会回滚,不产生记录)
create or replace function public.ita_plans_audit_approval()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.kind = 'plan' and new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.ita_audit(coalesce((select auth.uid()), new.user_id), 'plan.approve', 'success', null,
      jsonb_build_object('project_id', new.project_id, 'plan_id', new.id, 'version', new.version));
  end if;
  return new;
end $$;
drop trigger if exists ita_plans_audit_approval_trg on public.ita_plans;
create trigger ita_plans_audit_approval_trg after update on public.ita_plans
  for each row execute function public.ita_plans_audit_approval();

-- ---------------------------------------------------------------- 删除期间阻断写入
create or replace function public.ita_block_deleting_project()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.project_id is not null and exists (
    select 1 from public.ita_projects p where p.id = new.project_id and p.deletion_state is not null
  ) then
    raise exception 'PROJECT_DELETING: 项目正在删除,不再接收新任务或写入' using errcode = 'P0001';
  end if;
  return new;
end $$;

drop trigger if exists ita_tasks_block_deleting_trg on public.ita_tasks;
create trigger ita_tasks_block_deleting_trg before insert on public.ita_tasks
  for each row execute function public.ita_block_deleting_project();
drop trigger if exists ita_messages_block_deleting_trg on public.ita_messages;
create trigger ita_messages_block_deleting_trg before insert on public.ita_messages
  for each row execute function public.ita_block_deleting_project();
drop trigger if exists ita_files_block_deleting_trg on public.ita_files;
create trigger ita_files_block_deleting_trg before insert or update on public.ita_files
  for each row execute function public.ita_block_deleting_project();
drop trigger if exists ita_snapshots_block_deleting_trg on public.ita_snapshots;
create trigger ita_snapshots_block_deleting_trg before insert on public.ita_snapshots
  for each row execute function public.ita_block_deleting_project();
drop trigger if exists ita_memories_block_deleting_trg on public.ita_memories;
create trigger ita_memories_block_deleting_trg before insert or update on public.ita_memories
  for each row execute function public.ita_block_deleting_project();
drop trigger if exists ita_plans_block_deleting_trg on public.ita_plans;
create trigger ita_plans_block_deleting_trg before insert on public.ita_plans
  for each row execute function public.ita_block_deleting_project();
drop trigger if exists ita_memory_suggestions_block_deleting_trg on public.ita_memory_suggestions;
create trigger ita_memory_suggestions_block_deleting_trg before insert on public.ita_memory_suggestions
  for each row execute function public.ita_block_deleting_project();
drop trigger if exists ita_task_feedback_block_deleting_trg on public.ita_task_feedback;
create trigger ita_task_feedback_block_deleting_trg before insert on public.ita_task_feedback
  for each row execute function public.ita_block_deleting_project();

-- 删除中的项目:sandbox_id / preview_url 冻结,保证清理的就是请求删除时的那个沙箱
create or replace function public.ita_projects_guard_deleting()
returns trigger language plpgsql set search_path = '' as $$
begin
  if old.deletion_state is not null then
    new.sandbox_id := old.sandbox_id;
    new.preview_url := old.preview_url;
  end if;
  return new;
end $$;
drop trigger if exists ita_projects_zz_guard_deleting_trg on public.ita_projects;
create trigger ita_projects_zz_guard_deleting_trg before update on public.ita_projects
  for each row execute function public.ita_projects_guard_deleting();

-- 领取任务:跳过删除中的项目(其余逻辑与 0002 相同,每次生成新 execution_id)
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
      and not exists (
        select 1 from public.ita_projects pp where pp.id = t.project_id and pp.deletion_state is not null)
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

-- ---------------------------------------------------------------- 删除:客户端请求(幂等,可重试)
create or replace function public.ita_request_project_delete(p_project_id uuid, p_request_id text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_p public.ita_projects; v_retry boolean;
begin
  select * into v_p from public.ita_projects p where p.id = p_project_id and p.user_id = v_uid for update;
  if v_uid is null or v_p.id is null then
    raise exception 'project not found or not owned by caller' using errcode = '42501';
  end if;

  -- 使排队与运行中的执行失效:清空 execution_id,旧执行的心跳/写入都会得到 LEASE_LOST
  update public.ita_tasks t
  set status = 'cancelled', phase = 'cancelled', execution_id = null, lease_until = null,
      finished_at = now(), updated_at = now()
  where t.project_id = v_p.id and t.user_id = v_uid and t.status in ('queued', 'running');

  if v_p.deletion_state = 'deleting' then return 'deleting'; end if;   -- 重复点击
  v_retry := v_p.deletion_state = 'delete_failed';

  update public.ita_projects p
  set deletion_state = 'deleting', delete_requested_at = now(), delete_error = null
  where p.id = v_p.id;
  insert into public.ita_project_deletions as d (project_id, user_id, status)
  values (v_p.id, v_uid, 'pending')
  on conflict (project_id) do update
    set status = 'pending', worker_id = null, lease_until = null, updated_at = now();

  perform public.ita_audit(v_uid, 'project.delete_request', 'requested', p_request_id,
    jsonb_build_object('project_id', v_p.id, 'retry', v_retry));
  return 'deleting';
end $$;

-- ---------------------------------------------------------------- 删除:Worker 领取与完成(仅 service_role)
create or replace function public.ita_claim_project_deletion(p_worker_id text, p_lease_seconds int default 300)
returns table(project_id uuid, user_id uuid, sandbox_id text, attempts int)
language plpgsql security definer set search_path = '' as $$
#variable_conflict use_column
declare v_job public.ita_project_deletions; v_sandbox text; v_found boolean;
begin
  select * into v_job from public.ita_project_deletions d
  where d.status = 'pending' or (d.status = 'running' and d.lease_until < now())
  order by d.requested_at
  for update skip locked
  limit 1;
  if v_job.project_id is null then return; end if;

  select p.sandbox_id, true into v_sandbox, v_found
  from public.ita_projects p where p.id = v_job.project_id and p.user_id = v_job.user_id;
  if v_found is null then
    delete from public.ita_project_deletions d where d.project_id = v_job.project_id;  -- 项目已不存在
    return;
  end if;

  update public.ita_project_deletions d
  set status = 'running', worker_id = p_worker_id, attempts = d.attempts + 1,
      lease_until = now() + make_interval(secs => p_lease_seconds), updated_at = now()
  where d.project_id = v_job.project_id;
  return query select v_job.project_id, v_job.user_id, v_sandbox, v_job.attempts + 1;
end $$;

-- 沙箱清理成功(p_ok=true)后在同一事务内删除项目全部数据;失败则项目保持可见并标记 delete_failed
create or replace function public.ita_complete_project_deletion(
  p_project_id uuid, p_worker_id text, p_attempts int, p_ok boolean,
  p_error text default null, p_request_id text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_job public.ita_project_deletions;
begin
  select * into v_job from public.ita_project_deletions d
  where d.project_id = p_project_id
  and d.status = 'running'
  and d.worker_id = p_worker_id
  and d.attempts = p_attempts
  and d.lease_until > now()
  for update;
  if v_job.project_id is null then
    raise exception 'DELETION_LEASE_LOST: 删除任务不由该 Worker 持有' using errcode = 'P0001';
  end if;

  if p_ok then
    delete from public.ita_task_feedback f where f.project_id = v_job.project_id and f.user_id = v_job.user_id;
    delete from public.ita_memory_suggestions s where s.project_id = v_job.project_id and s.user_id = v_job.user_id;
    delete from public.ita_memories m
      where m.scope = 'project' and m.project_id = v_job.project_id and m.user_id = v_job.user_id;
    -- 复合外键级联:聊天、计划与反馈、任务与步骤、文件、快照;preview_url/sandbox_id 随项目行删除
    delete from public.ita_projects p where p.id = v_job.project_id and p.user_id = v_job.user_id;
    delete from public.ita_project_deletions d where d.project_id = v_job.project_id;
    perform public.ita_audit(v_job.user_id, 'project.delete', 'success', p_request_id,
      jsonb_build_object('project_id', v_job.project_id, 'attempts', v_job.attempts));
    return 'deleted';
  end if;

  update public.ita_project_deletions d
  set status = 'failed', last_error = left(coalesce(p_error, ''), 300), lease_until = null, updated_at = now()
  where d.project_id = v_job.project_id;
  update public.ita_projects p
  set deletion_state = 'delete_failed', delete_error = left(coalesce(nullif(p_error, ''), '沙箱清理失败'), 300)
  where p.id = v_job.project_id and p.user_id = v_job.user_id;
  perform public.ita_audit(v_job.user_id, 'project.delete', 'failure', p_request_id,
    jsonb_build_object('project_id', v_job.project_id, 'attempts', v_job.attempts));
  return 'failed';
end $$;

-- ---------------------------------------------------------------- 记忆
-- Worker 只写项目约定;全局偏好只能经用户确认建议写入
create or replace function public.ita_worker_upsert_memory(
  p_task_id uuid, p_worker_id text, p_execution_id uuid,
  p_scope text, p_key text, p_value text, p_weight int default 1)
returns public.ita_memories language plpgsql security definer set search_path = '' as $$
declare v_task public.ita_tasks; v_row public.ita_memories;
begin
  if p_scope is distinct from 'project' then
    raise exception 'WORKER_USER_SCOPE_FORBIDDEN: 全局偏好需用户确认,请改用 ita_worker_suggest_memory' using errcode = '42501';
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
  insert into public.ita_memories(user_id, project_id, scope, key, value, weight)
  values (v_task.user_id, v_task.project_id, 'project', p_key, p_value, p_weight)
  on conflict (user_id, project_id, key) where scope = 'project'
  do update set value = excluded.value, weight = excluded.weight, updated_at = now()
  returning * into v_row;
  return v_row;
end $$;

create or replace function public.ita_worker_suggest_memory(
  p_task_id uuid, p_worker_id text, p_execution_id uuid, p_key text, p_value text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_task public.ita_tasks;
begin
  select t.* into v_task from public.ita_tasks t
  where t.id = p_task_id and t.status = 'running' and t.worker_id = p_worker_id
    and t.execution_id = p_execution_id and t.lease_until is not null and t.lease_until >= now()
  for update of t;
  if v_task.id is null then
    raise exception 'LEASE_LOST: task not running under this execution or lease expired' using errcode = '42501';
  end if;
  -- 已是相同的默认偏好就不再建议
  if exists (select 1 from public.ita_memories m
             where m.user_id = v_task.user_id and m.scope = 'user' and m.key = p_key and m.value = p_value) then
    return false;
  end if;
  insert into public.ita_memory_suggestions(project_id, user_id, source_task_id, key, value)
  values (v_task.project_id, v_task.user_id, v_task.id, left(p_key, 80), left(p_value, 500))
  on conflict (project_id, key) where status = 'pending'
  do update set value = excluded.value, source_task_id = excluded.source_task_id, created_at = now();
  return true;
end $$;

create or replace function public.ita_resolve_memory_suggestion(p_id uuid, p_accept boolean, p_request_id text default null)
returns text language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_s public.ita_memory_suggestions;
begin
  select * into v_s from public.ita_memory_suggestions s
  where s.id = p_id and s.user_id = v_uid and s.status = 'pending'
    and exists (select 1 from public.ita_projects p where p.id = s.project_id and p.user_id = v_uid)
  for update;
  if v_uid is null or v_s.id is null then
    raise exception 'suggestion not found or not owned by caller' using errcode = '42501';
  end if;
  if p_accept then
    insert into public.ita_memories(user_id, project_id, scope, key, value, weight, enabled)
    values (v_uid, null, 'user', v_s.key, v_s.value, 1, true)
    on conflict (user_id, key) where scope = 'user'
    do update set value = excluded.value, enabled = true, updated_at = now();
  end if;
  update public.ita_memory_suggestions s
  set status = case when p_accept then 'accepted' else 'dismissed' end, resolved_at = now()
  where s.id = v_s.id;
  perform public.ita_audit(v_uid, case when p_accept then 'memory.suggestion_accept' else 'memory.suggestion_dismiss' end,
    'success', p_request_id, jsonb_build_object('suggestion_id', v_s.id));
  return case when p_accept then 'accepted' else 'dismissed' end;
end $$;

create or replace function public.ita_set_memory_enabled(p_memory_id uuid, p_enabled boolean, p_request_id text default null)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_count int;
begin
  if p_enabled is null then raise exception 'enabled is required' using errcode = '22023'; end if;
  update public.ita_memories m set enabled = p_enabled, updated_at = now()
  where m.id = p_memory_id and m.user_id = v_uid and m.scope = 'user';
  get diagnostics v_count = row_count;
  if v_uid is null or v_count = 0 then
    raise exception 'memory not found, not owned by caller, or not a default preference' using errcode = '42501';
  end if;
  perform public.ita_audit(v_uid, case when p_enabled then 'memory.enable' else 'memory.disable' end,
    'success', p_request_id, jsonb_build_object('memory_id', p_memory_id));
  return p_enabled;
end $$;

-- ---------------------------------------------------------------- 质量反馈
create or replace function public.ita_submit_task_feedback(p_task_id uuid, p_category text, p_note text default '')
returns public.ita_task_feedback language plpgsql security definer set search_path = '' as $$
declare v_uid uuid := (select auth.uid()); v_task public.ita_tasks; v_row public.ita_task_feedback;
begin
  select * into v_task from public.ita_tasks t
  where t.id = p_task_id and t.user_id = v_uid and t.status in ('succeeded', 'failed')
    and exists (select 1 from public.ita_projects p where p.id = t.project_id and p.user_id = v_uid);
  if v_uid is null or v_task.id is null then
    raise exception 'task not found, not owned by caller, or not finished' using errcode = '42501';
  end if;
  insert into public.ita_task_feedback(task_id, execution_id, project_id, user_id, category, note)
  values (v_task.id, v_task.execution_id, v_task.project_id, v_uid, p_category, left(coalesce(btrim(p_note), ''), 1000))
  returning * into v_row;
  return v_row;
end $$;

-- ---------------------------------------------------------------- 审计保留期清理(仅 service_role;Worker 定期调用)
create or replace function public.ita_purge_audit_log(p_retention_days int default 90)
returns int language plpgsql security definer set search_path = '' as $$
declare v_count int;
begin
  if p_retention_days is null or p_retention_days < 1 then
    raise exception 'retention days must be >= 1' using errcode = '22023';
  end if;
  delete from public.ita_audit_log a where a.occurred_at < now() - make_interval(days => p_retention_days);
  get diagnostics v_count = row_count;
  return v_count;
end $$;

-- ---------------------------------------------------------------- RLS
alter table public.ita_project_deletions enable row level security;
alter table public.ita_project_deletions force row level security;
alter table public.ita_memory_suggestions enable row level security;
alter table public.ita_memory_suggestions force row level security;
alter table public.ita_task_feedback enable row level security;
alter table public.ita_task_feedback force row level security;
alter table public.ita_audit_log enable row level security;
alter table public.ita_audit_log force row level security;

drop policy if exists ita_memory_suggestions_owner_select on public.ita_memory_suggestions;
create policy ita_memory_suggestions_owner_select on public.ita_memory_suggestions for select to authenticated
  using (user_id = (select auth.uid()) and public.ita_owns_project(project_id));
drop policy if exists ita_task_feedback_owner_select on public.ita_task_feedback;
create policy ita_task_feedback_owner_select on public.ita_task_feedback for select to authenticated
  using (user_id = (select auth.uid()) and public.ita_owns_project(project_id));
-- 用户可读取自己作为操作者的审计记录(不含敏感内容)
drop policy if exists ita_audit_log_actor_select on public.ita_audit_log;
create policy ita_audit_log_actor_select on public.ita_audit_log for select to authenticated
  using (actor_id = (select auth.uid()));

revoke all on public.ita_project_deletions, public.ita_memory_suggestions, public.ita_task_feedback, public.ita_audit_log
  from public, anon, authenticated;
grant select on public.ita_memory_suggestions, public.ita_task_feedback, public.ita_audit_log to authenticated;
grant select, insert, update, delete on public.ita_project_deletions, public.ita_memory_suggestions, public.ita_task_feedback
  to service_role;
grant select, insert, delete on public.ita_audit_log to service_role;

-- 删除项目只能走两阶段 RPC;启停只能走审计 RPC(内容编辑仍走 ita_upsert_memory,删除仍可直接进行)
revoke delete on public.ita_projects from authenticated;
revoke update on public.ita_memories from authenticated;
grant update (key, value, weight) on public.ita_memories to authenticated;

-- ---------------------------------------------------------------- 函数授权
revoke all on function public.ita_request_id(text) from public, anon, authenticated;
revoke all on function public.ita_audit(uuid, text, text, text, jsonb) from public, anon, authenticated;
revoke all on function public.ita_plans_audit_approval() from public, anon, authenticated;
revoke all on function public.ita_block_deleting_project() from public, anon, authenticated;
revoke all on function public.ita_projects_guard_deleting() from public, anon, authenticated;
revoke all on function public.ita_claim_task(text, int) from public, anon, authenticated;
revoke all on function public.ita_request_project_delete(uuid, text) from public, anon;
revoke all on function public.ita_claim_project_deletion(text, int) from public, anon, authenticated;
revoke all on function public.ita_complete_project_deletion(uuid, text, int, boolean, text, text) from public, anon, authenticated;
revoke all on function public.ita_worker_upsert_memory(uuid, text, uuid, text, text, text, int) from public, anon, authenticated;
revoke all on function public.ita_worker_suggest_memory(uuid, text, uuid, text, text) from public, anon, authenticated;
revoke all on function public.ita_resolve_memory_suggestion(uuid, boolean, text) from public, anon;
revoke all on function public.ita_set_memory_enabled(uuid, boolean, text) from public, anon;
revoke all on function public.ita_submit_task_feedback(uuid, text, text) from public, anon;
revoke all on function public.ita_purge_audit_log(int) from public, anon, authenticated;

grant execute on function public.ita_claim_task(text, int) to service_role;
grant execute on function public.ita_request_project_delete(uuid, text) to authenticated;
grant execute on function public.ita_claim_project_deletion(text, int) to service_role;
grant execute on function public.ita_complete_project_deletion(uuid, text, int, boolean, text, text) to service_role;
grant execute on function public.ita_worker_upsert_memory(uuid, text, uuid, text, text, text, int) to service_role;
grant execute on function public.ita_worker_suggest_memory(uuid, text, uuid, text, text) to service_role;
grant execute on function public.ita_resolve_memory_suggestion(uuid, boolean, text) to authenticated;
grant execute on function public.ita_set_memory_enabled(uuid, boolean, text) to authenticated;
grant execute on function public.ita_submit_task_feedback(uuid, text, text) to authenticated;
grant execute on function public.ita_purge_audit_log(int) to service_role;
commit;