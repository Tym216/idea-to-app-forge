-- Additive App Versions. No UPDATE/backfill of existing immutable snapshots.
begin;
alter table public.ita_snapshots add column version_number bigint,add column parent_checkpoint_id uuid;
alter table public.ita_snapshots add constraint ita_version_number_check check(version_number is null or (version_number>0 and kind='checkpoint'));
create unique index ita_app_version_unique on public.ita_snapshots(project_id,version_number) where version_number is not null;
-- Parent identity includes its project; legacy unnumbered parents remain valid.
alter table public.ita_snapshots add constraint ita_snapshot_project_identity unique(project_id,id);
alter table public.ita_snapshots add constraint ita_version_parent_fk foreign key(project_id,parent_checkpoint_id) references public.ita_snapshots(project_id,id) deferrable initially deferred;
create or replace function public.ita_complete_build_checkpoint(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,
 p_key text,p_revision bigint,p_hash text,p_build_basis text,p_verify_basis text,p_basis_id uuid,p_summary text,p_preview_url text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; s public.ita_snapshots; phase_name text; fingerprint text; next_version bigint; parent_id uuid;
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 -- Completion identity excludes transient execution/worker/proxy URL provenance.
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('project',p_project_id,'task',p_task_id,'key',p_key,'revision',p_revision,'hash',p_hash,
   'build_basis',p_build_basis,'verify_basis',p_verify_basis,'basis_id',p_basis_id,'summary',p_summary)::text,'UTF8')),'hex');
 select * into s from public.ita_snapshots where project_id=p.id and completion_key=p_key;
 if s.id is not null then
   if s.completion_fingerprint is distinct from fingerprint then raise exception 'CHECKPOINT_IDEMPOTENCY_CONFLICT'; end if;
   return jsonb_build_object('snapshot_id',s.id,'completed',true,'version_number',s.version_number);
 end if;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 if p_key is null or length(p_key) not between 1 and 240 or coalesce(p_build_basis,'') !~ '^[0-9a-f]{64}$' or coalesce(p_verify_basis,'') !~ '^[0-9a-f]{64}$' or p_task_id is null or public.ita_workspace_has_unresolved(p.id) or p.workspace_state<>'confirmed' or p.workspace_writer is not null or p.workspace_revision is distinct from p_revision
   or p.workspace_hash is distinct from p_hash or public.ita_manifest_hash(public.ita_workspace_files(p.id))<>p_hash then raise exception 'CHECKPOINT_SOURCE_NOT_CONFIRMED'; end if;
 if (p.workspace_build->>'workspace_revision')::bigint is distinct from p_revision or p.workspace_build->>'code_hash' is distinct from p_hash
   or p.workspace_build->>'basis_fingerprint' is distinct from p_build_basis or p.workspace_build->>'status' is distinct from 'passed' then raise exception 'CHECKPOINT_BUILD_STALE'; end if;
 if (p.workspace_verify->>'workspace_revision')::bigint is distinct from p_revision or p.workspace_verify->>'code_hash' is distinct from p_hash
   or p.workspace_verify->>'basis_fingerprint' is distinct from p_verify_basis or coalesce(p.workspace_verify->>'status','') not in ('passed','success_with_warnings','inconclusive') then raise exception 'CHECKPOINT_VERIFY_STALE'; end if;
 if not exists(select 1 from public.ita_plans b join public.ita_tasks t on t.plan_id=b.id and t.plan_version=b.version where b.id=p_basis_id and b.project_id=p.id and b.user_id=p.user_id and t.id=p_task_id) then raise exception 'CHECKPOINT_BASIS_INVALID'; end if;
 parent_id:=p.checkpoint_id;
 select coalesce(max(version_number),0)+1 into next_version from public.ita_snapshots where project_id=p.id;
 insert into public.ita_snapshots(project_id,user_id,task_id,label,files,kind,workspace_revision,code_hash,build_evidence,verify_evidence,basis_id,source_execution_id,completion_key,completion_fingerprint,version_number,parent_checkpoint_id)
 values(p.id,p.user_id,p_task_id,left(p_summary,120),public.ita_workspace_files(p.id),'checkpoint',p_revision,p_hash,p.workspace_build,p.workspace_verify,p_basis_id,p_execution_id,p_key,fingerprint,next_version,parent_id) returning * into s;
 phase_name:=case when p.workspace_verify->>'status'='passed' then 'done' else 'done_with_warnings' end;
 insert into public.ita_messages(project_id,user_id,task_id,role,content,meta) values(p.id,p.user_id,p_task_id,'assistant',p_summary,jsonb_build_object('checkpointId',s.id,'versionNumber',s.version_number,'previewUrl',p_preview_url));
 update public.ita_projects set checkpoint_id=s.id,status='ready',preview_url=p_preview_url,updated_at=now() where id=p.id;
 update public.ita_tasks set status='succeeded',phase=phase_name,finished_at=now(),lease_until=null,updated_at=now() where id=p_task_id;
 return jsonb_build_object('snapshot_id',s.id,'completed',true,'phase',phase_name,'version_number',s.version_number);
end $$;

notify pgrst,'reload schema';
commit;
