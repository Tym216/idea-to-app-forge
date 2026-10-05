-- 0001 -> 0005 prerequisite. Stop old Worker before cutover; old direct source writes are revoked.
begin;

alter table public.ita_projects
  add column if not exists workspace_epoch bigint not null default 0,
  add column if not exists workspace_revision bigint not null default 0,
  add column if not exists workspace_state text not null default 'uninitialized',
  add column if not exists workspace_hash text,
  add column if not exists workspace_writer jsonb,
  add column if not exists workspace_build jsonb,
  add column if not exists workspace_verify jsonb,
  add column if not exists checkpoint_id uuid;
alter table public.ita_tasks
  add column if not exists base_workspace_revision bigint,
  add column if not exists context_workspace_revision bigint;

create table if not exists public.ita_changesets (
  id uuid primary key default gen_random_uuid(), project_id uuid not null, user_id uuid not null,
  request_id text not null, actor text not null check(actor in ('agent','user','system')),
  origin text not null, task_id uuid, execution_id uuid,
  base_revision bigint, resulting_revision bigint, base_hash text, target_hash text,
  status text not null check(status in ('prepared','applying','committed','partial','uncertain','conflict','not_applied','cancelled')),
  changes jsonb not null, result jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(project_id, request_id),
  foreign key(project_id,user_id) references public.ita_projects(id,user_id) on delete cascade
);
alter table public.ita_changesets enable row level security;
alter table public.ita_changesets force row level security;
revoke all on public.ita_changesets from public, anon, authenticated, service_role;
grant select on public.ita_changesets to authenticated,service_role;
drop policy if exists ita_changesets_read on public.ita_changesets;
create policy ita_changesets_read on public.ita_changesets for select to authenticated using(user_id=(select auth.uid()));


insert into public.ita_changesets(project_id,user_id,request_id,actor,origin,task_id,execution_id,base_revision,base_hash,target_hash,status,changes,result)
select t.project_id,t.user_id,'legacy:'||(s->>'operation_id'),'agent','legacy',t.id,t.execution_id,0,null,null,'uncertain',
 jsonb_build_array(jsonb_build_object('path',s->>'path','operation','write','content',s->>'content','before_hash',s->>'before_sandbox_hash','after_hash',s->>'intended_hash')),
 jsonb_build_object('legacy',s)
from public.ita_tasks t cross join lateral jsonb_array_elements(t.steps) s
where s->>'tool'='change_journal' and s->>'event'='intent' and s->>'operation_id' is not null
and not exists(select 1 from public.ita_tasks r cross join lateral jsonb_array_elements(r.steps) x
 where r.project_id=t.project_id and x->>'tool'='change_journal' and x->>'event'='resolved' and x->>'operation_id'=s->>'operation_id')
on conflict(project_id,request_id) do nothing;
update public.ita_projects p set workspace_state='uncertain',workspace_writer=jsonb_build_object('kind','legacy','token',gen_random_uuid(),'epoch',0,'changeset_id',c.id,'sandbox_id',c.result->'legacy'->>'sandbox_id')
from public.ita_changesets c where c.project_id=p.id and c.origin='legacy' and c.status='uncertain' and p.workspace_writer is null;

alter table public.ita_snapshots
  add column if not exists kind text not null default 'legacy',
  add column if not exists workspace_epoch bigint not null default 0,
  add column if not exists workspace_revision bigint,
  add column if not exists code_hash text,
  add column if not exists build_evidence jsonb,
  add column if not exists verify_evidence jsonb,
  add column if not exists basis_id uuid,
  add column if not exists source_execution_id uuid,
  add column if not exists completion_key text,
  add column if not exists completion_fingerprint text;
create unique index if not exists ita_checkpoint_completion_unique on public.ita_snapshots(project_id,completion_key) where completion_key is not null;

create or replace function public.ita_managed_source_path(p text) returns boolean
language sql immutable set search_path='' as $$
 select p is not null and p<>'' and octet_length(p)<=240 and p !~ '[[:cntrl:]\\]' and p !~ '^(/|~|[A-Za-z]:)'
 and p !~ '(^|/)(\.|\.\.)(/|$)' and p !~ '//|/$'
 and p !~ '(^|/)(node_modules|\.git|\.forge-[^/]*)(/|$)'
 and p !~ '^(dist|build|out|\.vite|\.cache|\.next|\.turbo|coverage|logs|tmp|temp|test-results|playwright-report|screenshots|videos)(/|$)'
 and (p !~ '(^|/)\.env(\.[^/]*)?$' or p ~ '(^|/)\.env\.example$');
$$;

create or replace function public.ita_manifest_hash(p_files jsonb) returns text
language plpgsql immutable set search_path='' as $$
declare v_hash text;
begin
 if jsonb_typeof(p_files) is distinct from 'array' or jsonb_array_length(p_files)>2000 then raise exception 'SOURCE_LIMIT'; end if;
 if exists(select 1 from jsonb_array_elements(p_files) f where not public.ita_managed_source_path(f->>'path') or jsonb_typeof(f->'content') is distinct from 'string'
   or octet_length(f->>'content')>1048576) then raise exception 'SOURCE_PATH_OR_ENCODING'; end if;
 if (select coalesce(sum(octet_length(f->>'content')),0) from jsonb_array_elements(p_files) f)>8388608 then raise exception 'SOURCE_LIMIT'; end if;
 if exists(select 1 from jsonb_array_elements(p_files) f group by f->>'path' having count(*)>1) then raise exception 'SOURCE_DUPLICATE'; end if;
 select encode(sha256(convert_to('['||coalesce(string_agg('['||to_json(f->>'path')::text||','||to_json(encode(sha256(convert_to(f->>'content','UTF8')),'hex'))::text||']',',' order by (f->>'path') collate "C"),'')||']','UTF8')),'hex')
 into v_hash from jsonb_array_elements(p_files) f;
 return v_hash;
end $$;

create or replace function public.ita_workspace_files(p_project uuid) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('path',path,'content',content) order by path collate "C"),'[]'::jsonb)
 from public.ita_files where project_id=p_project and not deleted and public.ita_managed_source_path(path);
$$;

-- Full observed manifests, not caller-supplied hashes, are the reconcile proof.
create or replace function public.ita_workspace_target_files(p_project uuid,p_changes jsonb) returns jsonb
language sql stable security definer set search_path='' as $$
 select coalesce(jsonb_agg(f order by f->>'path' collate "C"),'[]'::jsonb) from (
 select b as f from jsonb_array_elements(public.ita_workspace_files(p_project)) b
 where not exists(select 1 from jsonb_array_elements(p_changes) x where x->>'path'=b->>'path')
 union all select jsonb_build_object('path',x->>'path','content',x->>'content')
 from jsonb_array_elements(p_changes) x where x->>'operation'='write') q;
$$;

create or replace function public.ita_workspace_observed_compatible(p_project uuid,p_changes jsonb,p_files jsonb,p_subset boolean default false) returns boolean
language sql stable security definer set search_path='' as $$
 with b as (select f->>'path' path,f->>'content' content from jsonb_array_elements(public.ita_workspace_files(p_project)) f),
 t as (select f->>'path' path,f->>'content' content from jsonb_array_elements(public.ita_workspace_target_files(p_project,p_changes)) f),
 a as (select f->>'path' path,f->>'content' content from jsonb_array_elements(p_files) f),
 paths as (select path from b union select path from t union select path from a)
 select not exists(select 1 from paths x left join b using(path) left join t using(path) left join a using(path)
 where case when p_subset then a.content is not null and a.content is distinct from b.content
 else a.content is distinct from b.content and a.content is distinct from t.content end);
$$;

create or replace function public.ita_workspace_has_unresolved(p_project uuid,p_except uuid default null) returns boolean
language sql stable security definer set search_path='' as $$
 select exists(select 1 from public.ita_changesets where project_id=p_project and id is distinct from p_except
 and status in ('applying','partial','uncertain','conflict'));
$$;

create or replace function public.ita_workspace_authorize(p_project uuid,p_task uuid,p_worker text,p_execution uuid) returns void
language plpgsql security definer set search_path='' as $$
begin
 if p_execution is null or not exists(select 1 from public.ita_projects where id=p_project and deletion_state is null) then raise exception 'LEASE_LOST'; end if;
 if p_task is not null then
   perform 1 from public.ita_tasks where id=p_task and project_id=p_project and status='running' and worker_id=p_worker and execution_id=p_execution and lease_until>clock_timestamp() for update;
   if not found then raise exception 'LEASE_LOST'; end if;
 else
   perform 1 from public.ita_preview_recoveries where project_id=p_project and status='running' and worker_id=p_worker and execution_id=p_execution and lease_until>clock_timestamp() for update;
   if not found then raise exception 'LEASE_LOST'; end if;
 end if;
end $$;

create or replace function public.ita_workspace_read(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; fs jsonb;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 fs:=public.ita_workspace_files(p_project_id);
 return jsonb_build_object('revision',p.workspace_revision,'state',p.workspace_state,'code_hash',p.workspace_hash,'files',fs,'writer',p.workspace_writer,
   'build',p.workspace_build,'verify',p.workspace_verify,'sandbox_id',p.sandbox_id,
   'pending',coalesce((select jsonb_agg(to_jsonb(c)) from public.ita_changesets c where c.project_id=p.id and c.status in ('applying','partial','uncertain','conflict')),'[]'::jsonb));
end $$;

create or replace function public.ita_workspace_acquire(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,
 p_operation_id uuid,p_kind text,p_sandbox_id text,p_changeset_id uuid default null) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; c public.ita_changesets; w jsonb;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 if p_operation_id is null or coalesce(p_sandbox_id,'')='' then raise exception 'WORKSPACE_OPERATION_INVALID'; end if;
 if p_kind is null or p_kind not in ('mutation','materialize','install','build','start','verify','preview','checkpoint') then raise exception 'WORKSPACE_OPERATION_INVALID'; end if;
 if p.workspace_writer is not null then
   if p.workspace_writer->>'operation_id'=p_operation_id::text and p.workspace_writer->>'execution_id'=p_execution_id::text then return p.workspace_writer; end if;
   raise exception 'WORKSPACE_RECONCILE_REQUIRED';
 end if;
 if public.ita_workspace_has_unresolved(p.id) then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 if p.workspace_state not in ('confirmed','uninitialized') then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 if p.workspace_state='uninitialized' and p_kind<>'materialize' then raise exception 'WORKSPACE_MATERIALIZE_REQUIRED'; end if;
 if (p_kind='mutation') is distinct from (p_changeset_id is not null) then raise exception 'WORKSPACE_CHANGESET_REQUIRED'; end if;
 if p_changeset_id is not null then
   select * into c from public.ita_changesets where id=p_changeset_id and project_id=p.id for update;
   if c.id is null or c.status is distinct from 'prepared' or c.base_revision<>p.workspace_revision or c.base_hash<>p.workspace_hash then raise exception 'WORKSPACE_REVISION_CONFLICT'; end if;
 end if;
 w:=jsonb_build_object('operation_id',p_operation_id,'token',gen_random_uuid(),'kind',p_kind,'task_id',p_task_id,'worker_id',p_worker_id,'execution_id',p_execution_id,
   'sandbox_id',p_sandbox_id,'epoch',p.workspace_epoch+1,'base_revision',p.workspace_revision,'base_hash',coalesce(p.workspace_hash,public.ita_manifest_hash(public.ita_workspace_files(p.id))),'target_hash',case when p_changeset_id is not null then c.target_hash when p_kind='materialize' then coalesce(p.workspace_hash,public.ita_manifest_hash(public.ita_workspace_files(p.id))) else null end,'changeset_id',p_changeset_id,'started_at',now());
 update public.ita_projects set workspace_writer=w,workspace_epoch=p.workspace_epoch+1,workspace_state='applying',workspace_hash=w->>'base_hash' where id=p.id;
 if p_changeset_id is not null then update public.ita_changesets set status='applying',updated_at=now() where id=c.id; end if;
 if p_task_id is not null then update public.ita_tasks set base_workspace_revision=coalesce(base_workspace_revision,p.workspace_revision),context_workspace_revision=p.workspace_revision where id=p_task_id; end if;
 return w;
end $$;

create or replace function public.ita_workspace_prepare(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,
 p_request_id text,p_origin text,p_base_revision bigint,p_changes jsonb,p_target_hash text,p_observed_files jsonb default null) returns public.ita_changesets
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; c public.ita_changesets;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 select * into c from public.ita_changesets where project_id=p.id and request_id=p_request_id;
 if c.id is not null then
   if c.changes<>p_changes or c.target_hash<>p_target_hash or c.base_revision<>p_base_revision then raise exception 'WORKSPACE_IDEMPOTENCY_CONFLICT'; end if;
   return c;
 end if;
 if p_request_id is null or length(p_request_id) not between 1 and 240 or p_target_hash is null or p_target_hash !~ '^[0-9a-f]{64}$' or jsonb_typeof(p_changes) is distinct from 'array' then raise exception 'WORKSPACE_REQUEST_INVALID'; end if;
 if exists(select 1 from jsonb_array_elements(p_changes) a where not public.ita_managed_source_path(a->>'path') or coalesce(a->>'operation','') not in ('write','delete') or (a->>'operation'='write' and jsonb_typeof(a->'content') is distinct from 'string')) then raise exception 'SOURCE_PATH'; end if;
 if p_base_revision is distinct from p.workspace_revision or p.workspace_state not in ('confirmed','applying') then raise exception 'WORKSPACE_REVISION_CONFLICT'; end if;
 if p.workspace_writer is not null and (p.workspace_writer->>'execution_id' is distinct from p_execution_id::text or p_origin is distinct from 'install_drift' or p.workspace_writer->>'kind' is distinct from 'install') then raise exception 'WORKSPACE_BUSY'; end if;
 if exists(select 1 from jsonb_array_elements(p_changes) a group by a->>'path' having count(*)>1) then raise exception 'SOURCE_DUPLICATE'; end if;
 if public.ita_workspace_has_unresolved(p.id) then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 if p_origin='install_drift' then
   -- Only the controlled, returned install may attest completion. Unknown commands stay fenced.
   if p.workspace_writer is null or p.workspace_writer->>'kind' is distinct from 'install'
     or p_request_id is distinct from p.workspace_writer->>'operation_id'
     or exists(select 1 from jsonb_array_elements(p_changes) a where a->>'path'<>'package-lock.json')
     or public.ita_manifest_hash(p_observed_files) is distinct from p_target_hash
     or public.ita_manifest_hash(public.ita_workspace_target_files(p.id,p_changes)) is distinct from p_target_hash
     then raise exception 'WORKSPACE_INSTALL_PROOF_REQUIRED'; end if;
 end if;
 insert into public.ita_changesets(project_id,user_id,request_id,actor,origin,task_id,execution_id,base_revision,base_hash,target_hash,status,changes)
 values(p.id,p.user_id,p_request_id,case when p_origin in ('scaffold','design','install_drift') then 'system' else 'agent' end,p_origin,p_task_id,p_execution_id,p.workspace_revision,p.workspace_hash,p_target_hash,'prepared',p_changes)
 returning * into c;
 if p_origin='install_drift' then
   update public.ita_changesets set status='applying' where id=c.id returning * into c;
   update public.ita_projects set workspace_writer=workspace_writer||jsonb_build_object('changeset_id',c.id,'target_hash',p_target_hash,'runtime_completed',true) where id=p.id;
 end if;
 return c;
end $$;

create or replace function public.ita_workspace_result(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,p_token uuid,p_state text,p_result jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 if p_token is null or p.workspace_writer is null or p.workspace_writer->>'token' is distinct from p_token::text then raise exception 'WORKSPACE_FENCE_LOST'; end if;
 if p_state not in ('partial','uncertain','conflict') then raise exception 'WORKSPACE_STATE_INVALID'; end if;
 update public.ita_projects set workspace_state=p_state,workspace_writer=workspace_writer||jsonb_build_object('result',p_result) where id=p.id;
 update public.ita_changesets set status=p_state,result=result||p_result,updated_at=now() where id=(p.workspace_writer->>'changeset_id')::uuid;
end $$;

create or replace function public.ita_workspace_commit(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,
 p_token uuid,p_changeset_id uuid,p_files jsonb,p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; c public.ita_changesets; changed boolean; f jsonb; next_revision bigint;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 select * into c from public.ita_changesets where id=p_changeset_id and project_id=p.id for update;
 if c.status='committed' and c.target_hash is distinct from p_hash then raise exception 'WORKSPACE_IDEMPOTENCY_CONFLICT'; end if;
 if c.status='committed' then return jsonb_build_object('revision',c.resulting_revision,'code_hash',c.target_hash,'changed',c.base_hash<>c.target_hash); end if;
 if c.id is null or (p.workspace_writer->>'changeset_id' is distinct from c.id::text and not (p.workspace_writer->>'kind'='install' and c.origin='install_drift' and c.execution_id=p_execution_id)) or p_token is null or p.workspace_writer is null or p.workspace_writer->>'token' is distinct from p_token::text or c.base_revision<>p.workspace_revision then raise exception 'WORKSPACE_FENCE_LOST'; end if;
 if p_hash is null or public.ita_manifest_hash(p_files) is distinct from p_hash or c.target_hash is distinct from p_hash then raise exception 'WORKSPACE_MANIFEST_CONFLICT'; end if;
 -- Files outside this declared change set must still match the committed baseline.
 if exists(select 1 from public.ita_files b where b.project_id=p.id and not b.deleted
   and not exists(select 1 from jsonb_array_elements(c.changes) x where x->>'path'=b.path)
   and not exists(select 1 from jsonb_array_elements(p_files) a where a->>'path'=b.path and a->>'content'=b.content))
   or exists(select 1 from jsonb_array_elements(p_files) a where not exists(select 1 from jsonb_array_elements(c.changes) x where x->>'path'=a->>'path')
   and not exists(select 1 from public.ita_files b where b.project_id=p.id and not b.deleted and b.path=a->>'path' and b.content=a->>'content')) then raise exception 'WORKSPACE_UNDECLARED_DRIFT'; end if;
 if exists(select 1 from jsonb_array_elements(c.changes) x where
   (x->>'operation'='write' and not exists(select 1 from jsonb_array_elements(p_files) a where a->>'path'=x->>'path' and a->>'content'=x->>'content'))
   or (x->>'operation'='delete' and exists(select 1 from jsonb_array_elements(p_files) a where a->>'path'=x->>'path'))) then raise exception 'WORKSPACE_TARGET_CONFLICT'; end if;
 if public.ita_workspace_has_unresolved(p.id,c.id) then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 changed:=c.base_hash<>p_hash; next_revision:=p.workspace_revision+case when changed then 1 else 0 end;
 update public.ita_files b set deleted=true,updated_at=now() where b.project_id=p.id and not b.deleted and not exists(select 1 from jsonb_array_elements(p_files) a where a->>'path'=b.path);
 for f in select value from jsonb_array_elements(p_files) loop
   insert into public.ita_files(project_id,user_id,path,content,deleted) values(p.id,p.user_id,f->>'path',f->>'content',false)
   on conflict(project_id,path) do update set content=excluded.content,deleted=false,updated_at=now();
 end loop;
 update public.ita_changesets set status='committed',resulting_revision=next_revision,result=result||jsonb_build_object('source_confirmed',true,'previous_evidence',jsonb_build_object('build',p.workspace_build,'verify',p.workspace_verify)),updated_at=now() where id=c.id;
 update public.ita_projects set workspace_revision=next_revision,workspace_hash=p_hash,workspace_state='confirmed',workspace_writer=null,
   workspace_build=case when changed then null else workspace_build end,workspace_verify=case when changed then null else workspace_verify end where id=p.id;
 if p_task_id is not null then update public.ita_tasks set context_workspace_revision=next_revision where id=p_task_id; end if;
 return jsonb_build_object('revision',next_revision,'code_hash',p_hash,'changed',changed);
end $$;

create or replace function public.ita_workspace_finish_operation(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,p_token uuid,p_hash text) returns void
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 if p_token is null or p.workspace_writer is null or p.workspace_writer->>'token' is distinct from p_token::text then raise exception 'WORKSPACE_FENCE_LOST'; end if;
 if p_hash is null or p_hash is distinct from p.workspace_hash or p_hash is distinct from public.ita_manifest_hash(public.ita_workspace_files(p.id)) then raise exception 'WORKSPACE_SOURCE_DRIFT'; end if;
 if p.workspace_writer->>'changeset_id' is not null then raise exception 'WORKSPACE_COMMIT_REQUIRED'; end if;
 if public.ita_workspace_has_unresolved(p.id) then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 update public.ita_projects set workspace_state='confirmed',workspace_writer=null where id=p.id;
end $$;

create or replace function public.ita_workspace_reconcile(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,p_old_token uuid,p_quiesced boolean,p_hash text,p_files jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; c public.ita_changesets; w jsonb;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 if not coalesce(p_quiesced,false) or p_old_token is null or p.workspace_writer is null or p.workspace_writer->>'token' is distinct from p_old_token::text then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 if p_hash is null or public.ita_manifest_hash(p_files) is distinct from p_hash then raise exception 'WORKSPACE_MANIFEST_CONFLICT'; end if;
 if p.workspace_writer->>'kind'='legacy' then raise exception 'WORKSPACE_LEGACY_QUIESCENCE_REQUIRED'; end if;
 if public.ita_workspace_has_unresolved(p.id,(p.workspace_writer->>'changeset_id')::uuid) then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 if p.workspace_writer->>'changeset_id' is null and p.workspace_writer->>'kind'<>'materialize' then
   if p_hash is null or p_hash is distinct from p.workspace_hash then raise exception 'WORKSPACE_SOURCE_DRIFT'; end if;
   update public.ita_projects set workspace_writer=null,workspace_state='confirmed' where id=p.id;
   return jsonb_build_object('state','not_applied');
 end if;
 if p.workspace_writer->>'changeset_id' is null then
   if not public.ita_workspace_observed_compatible(p.id,'[]',p_files,true) then raise exception 'WORKSPACE_MANIFEST_CONFLICT'; end if;
   w:=p.workspace_writer||jsonb_build_object('token',gen_random_uuid(),'epoch',p.workspace_epoch+1,'task_id',p_task_id,'worker_id',p_worker_id,'execution_id',p_execution_id);
   update public.ita_projects set workspace_writer=w,workspace_epoch=p.workspace_epoch+1,workspace_state='applying' where id=p.id;
   return jsonb_build_object('state','continue_materialize','writer',w);
 end if;
 select * into c from public.ita_changesets where id=(p.workspace_writer->>'changeset_id')::uuid for update;
 if c.id is null then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 if c.origin='legacy' then raise exception 'WORKSPACE_LEGACY_QUIESCENCE_REQUIRED'; end if;
 if p.workspace_writer->>'kind'='install' and (c.origin<>'install_drift' or p.workspace_writer->>'runtime_completed' is distinct from 'true') then raise exception 'WORKSPACE_INSTALL_PROOF_REQUIRED'; end if;
 if c.base_revision is distinct from p.workspace_revision or c.base_hash is distinct from p.workspace_hash
 or public.ita_manifest_hash(public.ita_workspace_target_files(p.id,c.changes)) is distinct from c.target_hash
 or not public.ita_workspace_observed_compatible(p.id,c.changes,p_files) then raise exception 'WORKSPACE_MANIFEST_CONFLICT'; end if;
 w:=p.workspace_writer||jsonb_build_object('token',gen_random_uuid(),'task_id',p_task_id,'worker_id',p_worker_id,'execution_id',p_execution_id,'epoch',p.workspace_epoch+1,'reconcile_only',true);
 update public.ita_projects set workspace_writer=w,workspace_epoch=p.workspace_epoch+1,workspace_state='applying' where id=p.id;
 return jsonb_build_object('state','continue_recorded','writer',w,'changeset',to_jsonb(c));
end $$;

create or replace function public.ita_workspace_reconcile_legacy(p_project_id uuid,p_old_token uuid,p_sandbox_id text,p_quiesced boolean,p_files jsonb,p_hash text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; c public.ita_changesets; old_hash text; observed text; persisted text; intended text;
 next_revision bigint; outcomes jsonb:='[]'; f jsonb; outcome text;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 if p.id is null or p.deletion_state is not null or not coalesce(p_quiesced,false)
 or p.workspace_writer->>'kind' is distinct from 'legacy' or p_old_token is null
 or p.workspace_writer->>'token' is distinct from p_old_token::text then raise exception 'WORKSPACE_LEGACY_QUIESCENCE_REQUIRED'; end if;
 if p_hash is null or public.ita_manifest_hash(p_files) is distinct from p_hash then raise exception 'WORKSPACE_MANIFEST_CONFLICT'; end if;
 if exists(select 1 from public.ita_changesets where project_id=p.id and status in ('applying','partial','uncertain','conflict') and origin<>'legacy') then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 old_hash:=public.ita_manifest_hash(public.ita_workspace_files(p.id));
 -- Unrecorded drift is never adopted. Multiple legacy intents resolve together under the project lock.
 if not public.ita_workspace_observed_compatible(p.id,
   coalesce((select jsonb_agg(x) from public.ita_changesets cs cross join lateral jsonb_array_elements(cs.changes) x
     where cs.project_id=p.id and cs.origin='legacy' and cs.status in ('applying','partial','uncertain','conflict')),'[]'),p_files)
 then raise exception 'WORKSPACE_MANIFEST_CONFLICT'; end if;
 for c in select * from public.ita_changesets where project_id=p.id and origin='legacy'
   and status in ('applying','partial','uncertain','conflict') order by id for update loop
   if not (c.result->'legacy' ? 'before_database_hash' and c.result->'legacy' ? 'before_sandbox_hash')
     or not public.ita_managed_source_path(c.result->'legacy'->>'path')
     or jsonb_typeof(c.result->'legacy'->'content') is distinct from 'string'
     or coalesce(c.result->'legacy'->>'intended_hash','') !~ '^[0-9a-f]{64}$'
     then raise exception 'WORKSPACE_LEGACY_RECORD_INVALID'; end if;
   if coalesce(p_sandbox_id,'')='' or c.result->'legacy'->>'sandbox_id' is distinct from p_sandbox_id then raise exception 'WORKSPACE_LEGACY_SANDBOX_CONFLICT'; end if;
   select encode(sha256(convert_to(a->>'content','UTF8')),'hex') into observed from jsonb_array_elements(p_files) a where a->>'path'=c.result->'legacy'->>'path';
   select encode(sha256(convert_to(content,'UTF8')),'hex') into persisted from public.ita_files where project_id=p.id and not deleted and path=c.result->'legacy'->>'path';
   intended:=encode(sha256(convert_to(c.result->'legacy'->>'content','UTF8')),'hex');
   if intended is distinct from c.result->'legacy'->>'intended_hash'
     or not (persisted is not distinct from c.result->'legacy'->>'before_database_hash' or persisted is not distinct from intended)
     then raise exception 'WORKSPACE_MANIFEST_CONFLICT'; end if;
   if observed is not distinct from intended then outcome:='committed';
   elsif observed is not distinct from c.result->'legacy'->>'before_sandbox_hash'
     and persisted is not distinct from c.result->'legacy'->>'before_database_hash'
     and observed is not distinct from persisted then outcome:='not_applied';
   else raise exception 'WORKSPACE_MANIFEST_CONFLICT'; end if;
   outcomes:=outcomes||jsonb_build_array(jsonb_build_object('id',c.id,'status',outcome));
 end loop;
 if jsonb_array_length(outcomes)=0 then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 next_revision:=p.workspace_revision+case when old_hash is distinct from p_hash then 1 else 0 end;
 for f in select value from jsonb_array_elements(p_files) loop
   insert into public.ita_files(project_id,user_id,path,content,deleted) values(p.id,p.user_id,f->>'path',f->>'content',false)
   on conflict(project_id,path) do update set content=excluded.content,deleted=false,updated_at=now();
 end loop;
 for f in select value from jsonb_array_elements(outcomes) loop
   update public.ita_changesets set status=f->>'status',base_revision=p.workspace_revision,base_hash=old_hash,
     resulting_revision=next_revision,target_hash=p_hash,
     result=result||jsonb_build_object('source_confirmed',true,'quiescence','operator_attested','observed_hash',p_hash),updated_at=now() where id=(f->>'id')::uuid;
 end loop;
 if public.ita_workspace_has_unresolved(p.id) then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 update public.ita_projects set workspace_revision=next_revision,workspace_hash=p_hash,workspace_state='confirmed',workspace_writer=null,
   workspace_epoch=workspace_epoch+1,workspace_build=null,workspace_verify=null where id=p.id;
 return jsonb_build_object('state','confirmed','revision',next_revision,'code_hash',p_hash,'outcomes',outcomes);
end $$;

create or replace function public.ita_workspace_evidence(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,p_kind text,p_evidence jsonb) returns boolean
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 if public.ita_workspace_has_unresolved(p.id) or p.workspace_state<>'confirmed' or p.workspace_writer is not null or (p_evidence->>'workspace_revision')::bigint is distinct from p.workspace_revision
   or p_evidence->>'code_hash' is distinct from p.workspace_hash or coalesce(p_evidence->>'basis_fingerprint','') !~ '^[0-9a-f]{64}$' or p.workspace_hash is distinct from public.ita_manifest_hash(public.ita_workspace_files(p.id)) then return false; end if;
 if p_kind='verify' and coalesce(p_evidence->>'status','') not in ('passed','success_with_warnings','inconclusive','blocker','tool_error') then raise exception 'WORKSPACE_EVIDENCE_STATUS'; end if;
 if p_kind='build' and coalesce(p_evidence->>'status','') not in ('passed','failed') then raise exception 'WORKSPACE_EVIDENCE_STATUS'; end if;
 if p_kind='build' then update public.ita_projects set workspace_build=p_evidence where id=p.id;
 elsif p_kind='verify' then update public.ita_projects set workspace_verify=p_evidence where id=p.id;
 else raise exception 'WORKSPACE_EVIDENCE_KIND'; end if;
 return true;
end $$;

create or replace function public.ita_complete_build_checkpoint(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,
 p_key text,p_revision bigint,p_hash text,p_build_basis text,p_verify_basis text,p_basis_id uuid,p_summary text,p_preview_url text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; s public.ita_snapshots; phase_name text; fingerprint text;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 -- Completion identity excludes transient execution/worker/proxy URL provenance.
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('project',p_project_id,'task',p_task_id,'key',p_key,'revision',p_revision,'hash',p_hash,
   'build_basis',p_build_basis,'verify_basis',p_verify_basis,'basis_id',p_basis_id,'summary',p_summary)::text,'UTF8')),'hex');
 select * into s from public.ita_snapshots where project_id=p.id and completion_key=p_key;
 if s.id is not null then
   if s.completion_fingerprint is distinct from fingerprint then raise exception 'CHECKPOINT_IDEMPOTENCY_CONFLICT'; end if;
   return jsonb_build_object('snapshot_id',s.id,'completed',true);
 end if;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 if p_key is null or length(p_key) not between 1 and 240 or coalesce(p_build_basis,'') !~ '^[0-9a-f]{64}$' or coalesce(p_verify_basis,'') !~ '^[0-9a-f]{64}$' or p_task_id is null or public.ita_workspace_has_unresolved(p.id) or p.workspace_state<>'confirmed' or p.workspace_writer is not null or p.workspace_revision is distinct from p_revision
   or p.workspace_hash is distinct from p_hash or public.ita_manifest_hash(public.ita_workspace_files(p.id))<>p_hash then raise exception 'CHECKPOINT_SOURCE_NOT_CONFIRMED'; end if;
 if (p.workspace_build->>'workspace_revision')::bigint is distinct from p_revision or p.workspace_build->>'code_hash' is distinct from p_hash
   or p.workspace_build->>'basis_fingerprint' is distinct from p_build_basis or p.workspace_build->>'status' is distinct from 'passed' then raise exception 'CHECKPOINT_BUILD_STALE'; end if;
 if (p.workspace_verify->>'workspace_revision')::bigint is distinct from p_revision or p.workspace_verify->>'code_hash' is distinct from p_hash
   or p.workspace_verify->>'basis_fingerprint' is distinct from p_verify_basis or coalesce(p.workspace_verify->>'status','') not in ('passed','success_with_warnings','inconclusive') then raise exception 'CHECKPOINT_VERIFY_STALE'; end if;
 if not exists(select 1 from public.ita_plans b join public.ita_tasks t on t.plan_id=b.id and t.plan_version=b.version where b.id=p_basis_id and b.project_id=p.id and b.user_id=p.user_id and t.id=p_task_id) then raise exception 'CHECKPOINT_BASIS_INVALID'; end if;
 insert into public.ita_snapshots(project_id,user_id,task_id,label,files,kind,workspace_revision,code_hash,build_evidence,verify_evidence,basis_id,source_execution_id,completion_key,completion_fingerprint)
 values(p.id,p.user_id,p_task_id,left(p_summary,120),public.ita_workspace_files(p.id),'checkpoint',p_revision,p_hash,p.workspace_build,p.workspace_verify,p_basis_id,p_execution_id,p_key,fingerprint) returning * into s;
 phase_name:=case when p.workspace_verify->>'status'='passed' then 'done' else 'done_with_warnings' end;
 insert into public.ita_messages(project_id,user_id,task_id,role,content,meta) values(p.id,p.user_id,p_task_id,'assistant',p_summary,jsonb_build_object('checkpointId',s.id,'previewUrl',p_preview_url));
 update public.ita_projects set checkpoint_id=s.id,status='ready',preview_url=p_preview_url,updated_at=now() where id=p.id;
 update public.ita_tasks set status='succeeded',phase=phase_name,finished_at=now(),lease_until=null,updated_at=now() where id=p_task_id;
 return jsonb_build_object('snapshot_id',s.id,'completed',true,'phase',phase_name);
end $$;

create or replace function public.ita_checkpoint_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if TG_OP='DELETE' then
   -- FK cascade runs after parent removal. Deleting an extant project's checkpoint is forbidden even to owner SQL.
   if old.kind<>'legacy' and exists(select 1 from public.ita_projects where id=old.project_id) then raise exception 'CHECKPOINT_IMMUTABLE'; end if;
   return old;
 end if;
 if old.kind<>'legacy' then raise exception 'CHECKPOINT_IMMUTABLE'; end if;
 return new;
end $$;
drop trigger if exists ita_checkpoint_immutable_trg on public.ita_snapshots;
create trigger ita_checkpoint_immutable_trg before update or delete on public.ita_snapshots for each row execute function public.ita_checkpoint_immutable();
revoke insert,update,delete on public.ita_files from public,anon,authenticated,service_role;
revoke insert,update,delete on public.ita_snapshots from public,anon,authenticated,service_role;
-- BYPASSRLS does not bypass privileges. Revoke table-level grants before allowing non-authority columns.
revoke update,insert on public.ita_projects from public,anon,service_role;
do $$ declare cols text; authority text:='workspace_revision,workspace_state,workspace_hash,workspace_writer,workspace_epoch,workspace_build,workspace_verify,checkpoint_id'; begin
 execute 'revoke update ('||authority||'),insert ('||authority||') on public.ita_projects from public,anon,authenticated,service_role';
 select string_agg(quote_ident(column_name),',' order by ordinal_position) into cols from information_schema.columns
 where table_schema='public' and table_name='ita_projects' and column_name not in ('workspace_revision','workspace_state','workspace_hash','workspace_writer','workspace_epoch','workspace_build','workspace_verify','checkpoint_id');
 execute 'grant insert ('||cols||'),update ('||cols||') on public.ita_projects to service_role';
end $$;

create or replace function public.ita_worker_save_plan(p_task_id uuid, p_worker_id text, p_execution_id uuid, p_kind text, p_content jsonb)
returns public.ita_plans language plpgsql security definer set search_path = '' as $$
declare v_task public.ita_tasks; v_plan public.ita_plans; v_version int;
begin
  perform 1 from public.ita_projects where id=(select project_id from public.ita_tasks where id=p_task_id) for update;
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

-- All helper/mutation functions are closed by default. Only the workspace protocol is executable by Worker.
do $$ declare f record; begin
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
   and (p.proname like 'ita_workspace_%' or p.proname in ('ita_managed_source_path','ita_manifest_hash','ita_complete_build_checkpoint','ita_checkpoint_immutable')) loop
   execute format('revoke all on function %s from public,anon,authenticated,service_role',f.sig);
 end loop;
 for f in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public'
   and p.proname in ('ita_workspace_read','ita_workspace_acquire','ita_workspace_prepare','ita_workspace_result','ita_workspace_commit','ita_workspace_finish_operation','ita_workspace_reconcile','ita_workspace_reconcile_legacy','ita_workspace_evidence','ita_complete_build_checkpoint') loop
   execute format('grant execute on function %s to service_role',f.sig);
 end loop;
end $$;
notify pgrst,'reload schema';
commit;
