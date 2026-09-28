-- 依赖 0001 → 0002 → 0003 → 0004；现有单 Worker 领取预览恢复队列。
begin;
create table if not exists public.ita_preview_recoveries (
  project_id uuid primary key,
  user_id uuid not null,
  sandbox_id text not null,
  status text not null check (status in ('queued','running','ready','failed')),
  phase text not null default 'queued',
  worker_id text,
  execution_id uuid,
  lease_until timestamptz,
  preview_url text,
  error text,
  updated_at timestamptz not null default now(),
  foreign key (project_id,user_id) references public.ita_projects(id,user_id) on delete cascade
);
alter table public.ita_preview_recoveries enable row level security;
alter table public.ita_preview_recoveries force row level security;
revoke all on public.ita_preview_recoveries from public, anon, authenticated;
grant select on public.ita_preview_recoveries to authenticated;
grant all on public.ita_preview_recoveries to service_role;
drop policy if exists ita_preview_read on public.ita_preview_recoveries;
create policy ita_preview_read on public.ita_preview_recoveries for select to authenticated
  using (user_id=(select auth.uid()));

create or replace function public.ita_request_preview_recovery(p_project_id uuid)
returns public.ita_preview_recoveries language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; j public.ita_preview_recoveries;
begin
  select * into p from public.ita_projects where id=p_project_id and user_id=(select auth.uid()) for update;
  if p.id is null then raise exception 'project not owned' using errcode='42501'; end if;
  if p.deletion_state is not null then raise exception 'PROJECT_DELETING'; end if;
  if p.sandbox_id is null then raise exception 'PREVIEW_SANDBOX_MISSING'; end if;
  select * into j from public.ita_preview_recoveries where project_id=p.id;
  if j.sandbox_id=p.sandbox_id and
    (j.status='queued' or (j.status='running' and j.lease_until>now()) or
     (j.status='ready' and j.updated_at>now()-interval '15 seconds')) then return j; end if;
  insert into public.ita_preview_recoveries(project_id,user_id,sandbox_id,status)
    values(p.id,p.user_id,p.sandbox_id,'queued')
    on conflict(project_id) do update set sandbox_id=excluded.sandbox_id,status='queued',phase='queued',
      worker_id=null,execution_id=null,lease_until=null,preview_url=null,error=null,updated_at=now()
    returning * into j;
  return j;
end $$;

create or replace function public.ita_claim_preview_recovery(p_worker_id text)
returns setof public.ita_preview_recoveries language plpgsql security definer set search_path='' as $$
begin
  if p_worker_id is null or p_worker_id='' then raise exception 'worker required'; end if;
  return query with candidate as (
    select j.project_id from public.ita_preview_recoveries j
    join public.ita_projects p on p.id=j.project_id and p.user_id=j.user_id
    where (j.status='queued' or (j.status='running' and j.lease_until<=now()))
      and p.deletion_state is null and p.sandbox_id=j.sandbox_id
      and not exists(select 1 from public.ita_tasks t where t.project_id=p.id and t.status in ('queued','running'))
    order by j.updated_at for update of j skip locked limit 1
  ) update public.ita_preview_recoveries j set status='running',phase='checking',worker_id=p_worker_id,
      execution_id=gen_random_uuid(),lease_until=now()+interval '5 minutes',updated_at=now()
    from candidate c where j.project_id=c.project_id returning j.*;
end $$;

create or replace function public.ita_update_preview_recovery(
  p_project_id uuid,p_worker_id text,p_execution_id uuid,p_phase text,
  p_url text default null,p_error text default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; j public.ita_preview_recoveries;
begin
  select * into p from public.ita_projects where id=p_project_id for update;
  if p.id is null or p.deletion_state is not null then return false; end if;
  select * into j from public.ita_preview_recoveries where project_id=p.id for update;
  if j.status is distinct from 'running' or j.worker_id is distinct from p_worker_id or
     p_execution_id is null or j.execution_id is distinct from p_execution_id or
     j.lease_until is null or j.lease_until<=now() or j.sandbox_id is distinct from p.sandbox_id then return false; end if;
  if p_phase not in ('checking','starting','server','ready','failed') then raise exception 'invalid phase'; end if;
  if p_phase='ready' and (p_url is null or p_url not like 'https://%') then raise exception 'invalid preview URL'; end if;
  update public.ita_preview_recoveries set phase=p_phase,
    status=case when p_phase in ('ready','failed') then p_phase else 'running' end,
    preview_url=case when p_phase='ready' then p_url else null end,
    error=case when p_phase='failed' then left(p_error,300) else null end,
    lease_until=case when p_phase in ('ready','failed') then null else now()+interval '5 minutes' end,
    updated_at=now() where project_id=p.id;
  if p_phase='ready' then update public.ita_projects set preview_url=p_url,updated_at=now() where id=p.id; end if;
  return true;
end $$;
revoke all on function public.ita_request_preview_recovery(uuid) from public,anon,service_role;
grant execute on function public.ita_request_preview_recovery(uuid) to authenticated;
revoke all on function public.ita_claim_preview_recovery(text),
  public.ita_update_preview_recovery(uuid,text,uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.ita_claim_preview_recovery(text),
  public.ita_update_preview_recovery(uuid,text,uuid,text,text,text) to service_role;
notify pgrst,'reload schema';
commit;
