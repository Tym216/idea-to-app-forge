begin;
alter table public.ita_preview_recoveries add column ready_revision bigint, add column ready_hash text;
drop function public.ita_update_preview_recovery(uuid,text,uuid,text,text,text);
create function public.ita_update_preview_recovery(
  p_project_id uuid,p_worker_id text,p_execution_id uuid,p_phase text,
  p_url text default null,p_error text default null,p_revision bigint default null,p_hash text default null)
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
  if p_phase='ready' and (p_revision is distinct from p.workspace_revision or p_hash is distinct from p.workspace_hash or p.workspace_state<>'confirmed' or p.workspace_writer is not null or public.ita_workspace_has_unresolved(p.id)
    or public.ita_manifest_hash(public.ita_workspace_files(p.id)) is distinct from p.workspace_hash) then raise exception 'WORKSPACE_SOURCE_NOT_CONFIRMED'; end if;
  update public.ita_preview_recoveries set ready_revision=case when p_phase='ready' then p.workspace_revision else null end,
    ready_hash=case when p_phase='ready' then p.workspace_hash else null end, phase=p_phase,
    status=case when p_phase in ('ready','failed') then p_phase else 'running' end,
    preview_url=case when p_phase='ready' then p_url else null end,
    error=case when p_phase='failed' then left(p_error,300) else null end,
    lease_until=case when p_phase in ('ready','failed') then null else now()+interval '5 minutes' end,
    updated_at=now() where project_id=p.id;
  if p_phase='ready' then update public.ita_projects set preview_url=p_url,updated_at=now() where id=p.id; end if;
  return true;
end $$;
revoke all on function public.ita_update_preview_recovery(uuid,text,uuid,text,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.ita_update_preview_recovery(uuid,text,uuid,text,text,text,bigint,text) to service_role;
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
     (j.status='ready' and j.ready_revision=p.workspace_revision and j.ready_hash=p.workspace_hash and p.workspace_state='confirmed' and p.workspace_writer is null and j.updated_at>now()-interval '15 seconds')) then return j; end if;
  insert into public.ita_preview_recoveries(project_id,user_id,sandbox_id,status)
    values(p.id,p.user_id,p.sandbox_id,'queued')
    on conflict(project_id) do update set sandbox_id=excluded.sandbox_id,status='queued',phase='queued',
      worker_id=null,execution_id=null,lease_until=null,preview_url=null,ready_revision=null,ready_hash=null,error=null,updated_at=now()
    returning * into j;
  return j;
end $$;
notify pgrst,'reload schema';
commit;
