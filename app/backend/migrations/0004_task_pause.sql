-- 依赖 0001 → 0002 → 0003。先停止旧 Worker，再执行本迁移并更新 Worker/前端。
begin;
alter table public.ita_tasks drop constraint if exists ita_tasks_status_check;
alter table public.ita_tasks add constraint ita_tasks_status_check
  check (status in ('queued','running','paused','succeeded','failed','cancelled'));
drop index if exists public.ita_tasks_active_unique;
create unique index ita_tasks_active_unique on public.ita_tasks(project_id)
  where status in ('queued','running','paused');

-- 统一锁顺序：项目 → 任务，与删除/批准流程共享项目锁。
create or replace function public.ita_control_task(p_task_id uuid, p_action text)
returns public.ita_tasks language plpgsql security definer set search_path = '' as $$
declare
  v_task public.ita_tasks;
  v_project public.ita_projects;
  v_uid uuid := (select auth.uid());
  v_status text;
begin
  if v_uid is null then raise exception 'not authenticated' using errcode='42501'; end if;
  select p.* into v_project from public.ita_projects p
    join public.ita_tasks t on t.project_id=p.id and t.user_id=p.user_id
    where t.id=p_task_id and p.user_id=v_uid for update of p;
  if v_project.id is null then raise exception 'task not owned' using errcode='42501'; end if;
  if v_project.deletion_state is not null then raise exception 'PROJECT_DELETING'; end if;
  select * into v_task from public.ita_tasks where id=p_task_id and user_id=v_uid for update;
  if p_action='pause' then
    if v_task.status='paused' then return v_task; end if;
    if v_task.status not in ('queued','running') then raise exception 'TASK_NOT_PAUSABLE'; end if;
    v_status := 'paused';
  elsif p_action='resume' then
    if v_task.status in ('queued','running') then return v_task; end if;
    if v_task.status<>'paused' then raise exception 'TASK_NOT_PAUSED'; end if;
    v_status := 'queued';
  elsif p_action='cancel' then
    if v_task.status='cancelled' then return v_task; end if;
    if v_task.status not in ('queued','running','paused') then raise exception 'TASK_NOT_CANCELLABLE'; end if;
    v_status := 'cancelled';
  else raise exception 'INVALID_TASK_ACTION'; end if;
  update public.ita_tasks set status=v_status,
    phase=case when p_action='resume' then 'resumed' else v_status end,
    execution_id=null, worker_id=null, lease_until=null, heartbeat_at=null,
    finished_at=case when p_action='cancel' then now() else null end,
    updated_at=now(),
    steps=coalesce(steps,'[]'::jsonb) || jsonb_build_array(jsonb_build_object(
      'tool',p_action,'phase',v_status,'at',now(),'observation',
      case p_action when 'pause' then '已请求暂停；保留代码和预算，Worker 正在停止当前执行'
        when 'resume' then '继续任务；沿用已保存代码与剩余预算' else '用户已结束任务' end))
    where id=p_task_id returning * into v_task;
  perform public.ita_audit(v_uid,'task.'||p_action,'success',null,jsonb_build_object('task_id',p_task_id));
  return v_task;
end $$;

create or replace function public.ita_pause_task(p_task_id uuid)
returns public.ita_tasks language sql security definer set search_path='' as $$
  select public.ita_control_task(p_task_id,'pause');
$$;
create or replace function public.ita_resume_task(p_task_id uuid)
returns public.ita_tasks language sql security definer set search_path='' as $$
  select public.ita_control_task(p_task_id,'resume');
$$;
create or replace function public.ita_cancel_task(p_task_id uuid)
returns public.ita_tasks language sql security definer set search_path='' as $$
  select public.ita_control_task(p_task_id,'cancel');
$$;
revoke all on function public.ita_control_task(uuid,text) from public, anon, authenticated, service_role;
revoke all on function public.ita_pause_task(uuid), public.ita_resume_task(uuid), public.ita_cancel_task(uuid) from public, anon, service_role;
grant execute on function public.ita_pause_task(uuid), public.ita_resume_task(uuid), public.ita_cancel_task(uuid) to authenticated;
notify pgrst, 'reload schema';
commit;
