-- App identity is separate from the fresh technical checkpoint created by restore.
-- Existing immutable snapshots are neither updated nor renumbered.
begin;
alter table public.ita_projects add column active_app_version_id uuid;
alter table public.ita_snapshots add column app_version_id uuid;
alter table public.ita_projects add constraint ita_active_app_version_fk
 foreign key(id,active_app_version_id) references public.ita_snapshots(project_id,id) deferrable initially deferred;
alter table public.ita_snapshots add constraint ita_checkpoint_app_version_fk
 foreign key(project_id,app_version_id) references public.ita_snapshots(project_id,id) deferrable initially deferred;
revoke insert(active_app_version_id),update(active_app_version_id) on public.ita_projects from public,anon,authenticated,service_role;
revoke insert(app_version_id),update(app_version_id) on public.ita_snapshots from public,anon,authenticated,service_role;
create or replace function public.ita_complete_build_checkpoint(p_project_id uuid,p_task_id uuid,p_worker_id text,p_execution_id uuid,
 p_key text,p_revision bigint,p_hash text,p_build_basis text,p_verify_basis text,p_basis_id uuid,p_summary text,p_preview_url text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; s public.ita_snapshots; phase_name text; fingerprint text; next_version bigint; parent_id uuid; active_id uuid; restore_id uuid; sid uuid:=gen_random_uuid();
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 select (c.submission_basis->>'restore_checkpoint_id')::uuid into restore_id
 from public.ita_tasks t join public.ita_changesets c on c.id=t.requested_changeset_id
 where t.id=p_task_id and t.project_id=p.id and t.operation='user_apply' and c.project_id=p.id;
 -- Completion identity excludes transient execution/worker/proxy URL provenance.
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('project',p_project_id,'task',p_task_id,'key',p_key,'revision',p_revision,'hash',p_hash,
   'build_basis',p_build_basis,'verify_basis',p_verify_basis,'basis_id',p_basis_id,'summary',p_summary)::text,'UTF8')),'hex');
 if restore_id is not null then
  fingerprint:=encode(sha256(convert_to(jsonb_build_object('request',fingerprint,'restore_target',restore_id)::text,'UTF8')),'hex');
 end if;
 select * into s from public.ita_snapshots where project_id=p.id and completion_key=p_key;
 if s.id is not null then
   if s.completion_fingerprint is distinct from fingerprint then raise exception 'CHECKPOINT_IDEMPOTENCY_CONFLICT'; end if;
   return jsonb_build_object('snapshot_id',s.id,'completed',true,'version_number',coalesce(s.version_number,(select version_number from public.ita_snapshots where id=s.app_version_id)),'app_version_id',coalesce(s.app_version_id,s.id));
 end if;
 perform public.ita_workspace_authorize(p_project_id,p_task_id,p_worker_id,p_execution_id);
 if p_key is null or length(p_key) not between 1 and 240 or coalesce(p_build_basis,'') !~ '^[0-9a-f]{64}$' or coalesce(p_verify_basis,'') !~ '^[0-9a-f]{64}$' or p_task_id is null or public.ita_workspace_has_unresolved(p.id) or p.workspace_state<>'confirmed' or p.workspace_writer is not null or p.workspace_revision is distinct from p_revision
   or p.workspace_hash is distinct from p_hash or public.ita_manifest_hash(public.ita_workspace_files(p.id))<>p_hash then raise exception 'CHECKPOINT_SOURCE_NOT_CONFIRMED'; end if;
 if (p.workspace_build->>'workspace_revision')::bigint is distinct from p_revision or p.workspace_build->>'code_hash' is distinct from p_hash
   or p.workspace_build->>'basis_fingerprint' is distinct from p_build_basis or p.workspace_build->>'status' is distinct from 'passed' then raise exception 'CHECKPOINT_BUILD_STALE'; end if;
 if (p.workspace_verify->>'workspace_revision')::bigint is distinct from p_revision or p.workspace_verify->>'code_hash' is distinct from p_hash
   or p.workspace_verify->>'basis_fingerprint' is distinct from p_verify_basis or coalesce(p.workspace_verify->>'status','') not in ('passed','success_with_warnings','inconclusive') then raise exception 'CHECKPOINT_VERIFY_STALE'; end if;
 if not exists(select 1 from public.ita_plans b join public.ita_tasks t on t.plan_id=b.id and t.plan_version=b.version where b.id=p_basis_id and b.project_id=p.id and b.user_id=p.user_id and t.id=p_task_id) then raise exception 'CHECKPOINT_BASIS_INVALID'; end if;
 -- Restoring code produces new revision-bound evidence, not a new user App version.
 if restore_id is not null then
  if not exists(select 1 from public.ita_snapshots where id=restore_id and project_id=p.id
   and user_id=p.user_id and kind='checkpoint' and version_number is not null
   and code_hash=p_hash and public.ita_manifest_hash(files)=p_hash) then
   raise exception 'RESTORE_SOURCE_CHANGED: confirmed source differs from requested historical version';
  end if;
  active_id:=restore_id; parent_id:=p.checkpoint_id; next_version:=null;
 else
  active_id:=sid; parent_id:=coalesce(p.active_app_version_id,p.checkpoint_id);
  select coalesce(max(version_number),0)+1 into next_version from public.ita_snapshots where project_id=p.id;
 end if;
 insert into public.ita_snapshots(id,app_version_id,project_id,user_id,task_id,label,files,kind,workspace_revision,code_hash,build_evidence,verify_evidence,basis_id,source_execution_id,completion_key,completion_fingerprint,version_number,parent_checkpoint_id)
 values(sid,active_id,p.id,p.user_id,p_task_id,left(p_summary,120),public.ita_workspace_files(p.id),'checkpoint',p_revision,p_hash,p.workspace_build,p.workspace_verify,p_basis_id,p_execution_id,p_key,fingerprint,next_version,parent_id) returning * into s;
 phase_name:=case when p.workspace_verify->>'status'='passed' then 'done' else 'done_with_warnings' end;
 insert into public.ita_messages(project_id,user_id,task_id,role,content,meta) values(p.id,p.user_id,p_task_id,'assistant',p_summary,jsonb_build_object('checkpointId',s.id,'appVersionId',active_id,'versionNumber',coalesce(s.version_number,(select version_number from public.ita_snapshots where id=active_id)),'previewUrl',p_preview_url,'kind',case when restore_id is null then 'version_created' else 'restore_completed' end));
 update public.ita_projects set checkpoint_id=s.id,active_app_version_id=active_id,status='ready',preview_url=p_preview_url,updated_at=now() where id=p.id;
 update public.ita_tasks set status='succeeded',phase=phase_name,finished_at=now(),lease_until=null,updated_at=now() where id=p_task_id;
 return jsonb_build_object('snapshot_id',s.id,'completed',true,'phase',phase_name,'version_number',coalesce(s.version_number,(select version_number from public.ita_snapshots where id=s.app_version_id)),'app_version_id',coalesce(s.app_version_id,s.id));
end $$;

create or replace function public.ita_restore_app_version(p_project_id uuid,p_checkpoint_id uuid,p_request_id text,p_base_revision bigint)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; s public.ita_snapshots; current_s public.ita_snapshots; b public.ita_plans;
 c public.ita_changesets; t public.ita_tasks; changes jsonb; target text; fingerprint text; cid uuid:=gen_random_uuid();
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 if p.id is null or p.user_id is distinct from (select auth.uid()) then raise exception 'RESTORE_NOT_OWNED' using errcode='42501'; end if;
 if p_request_id is null or length(p_request_id) not between 1 and 200 or p_base_revision is null then raise exception 'RESTORE_INPUT'; end if;
 select * into s from public.ita_snapshots where id=p_checkpoint_id and project_id=p.id and user_id=p.user_id and kind='checkpoint' and version_number is not null;
 if s.id is null then raise exception 'RESTORE_TARGET_INVALID'; end if;
 target:=public.ita_manifest_hash(s.files);
 if target is distinct from s.code_hash then raise exception 'RESTORE_TARGET_INVALID'; end if;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('project',p.id,'base',p_base_revision,'restore_checkpoint',s.id,'target_hash',target)::text,'UTF8')),'hex');
 select * into c from public.ita_changesets where project_id=p.id and request_id='restore:'||p_request_id;
 if c.id is not null then
  if c.actor<>'user' or c.submission_fingerprint is distinct from fingerprint then raise exception 'USER_APPLY_REQUEST_CONFLICT'; end if;
  return jsonb_build_object('accepted',true,'task_id',c.task_id,'changeset_id',c.id);
 end if;
 if p.deletion_state is not null then raise exception 'PROJECT_DELETING'; end if;
 if p.workspace_revision is distinct from p_base_revision then raise exception 'WORKSPACE_REVISION_CONFLICT: reload and retry restore'; end if;
 if p.workspace_state<>'confirmed' or p.workspace_writer is not null or public.ita_workspace_has_unresolved(p.id) then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 if exists(select 1 from public.ita_tasks where project_id=p.id and status in ('queued','running','paused'))
 or exists(select 1 from public.ita_preview_recoveries where project_id=p.id and status in ('queued','running')) then raise exception 'PROJECT_BUSY'; end if;
 if target=p.workspace_hash then
  -- Selecting an identical historical version must still have current source/evidence.
  if not exists(select 1 from public.ita_snapshots k where k.id=p.checkpoint_id and k.project_id=p.id
   and k.workspace_revision=p.workspace_revision and k.code_hash=p.workspace_hash
   and public.ita_manifest_hash(k.files)=p.workspace_hash
   and k.build_evidence->>'status'='passed'
   and k.build_evidence is not distinct from p.workspace_build
   and k.verify_evidence is not distinct from p.workspace_verify
   and k.verify_evidence->>'status' in ('passed','success_with_warnings','inconclusive')) then
    raise exception 'USER_APPLY_STABLE_BASIS_REQUIRED';
  end if;
  update public.ita_projects set active_app_version_id=s.id,updated_at=now() where id=p.id;
  return jsonb_build_object('accepted',true,'noop',true);
 end if;
 select * into current_s from public.ita_snapshots where id=p.checkpoint_id and project_id=p.id and kind='checkpoint';
 select * into b from public.ita_plans where id=s.basis_id and project_id=p.id and user_id=p.user_id;
 if current_s.id is null or b.id is null or s.workspace_revision is null
 or coalesce(s.build_evidence->>'basis_fingerprint','') !~ '^[0-9a-f]{64}$'
 or coalesce(s.verify_evidence->>'basis_fingerprint','') !~ '^[0-9a-f]{64}$'
 or s.build_evidence->>'workspace_revision' is distinct from s.workspace_revision::text
 or s.verify_evidence->>'workspace_revision' is distinct from s.workspace_revision::text
 or s.build_evidence->>'code_hash' is distinct from target or s.verify_evidence->>'code_hash' is distinct from target
 or s.build_evidence->>'status' is distinct from 'passed'
 or coalesce(s.verify_evidence->>'status','') not in ('passed','success_with_warnings','inconclusive')
 or jsonb_typeof(b.content->'acceptance') is distinct from 'array' or jsonb_array_length(b.content->'acceptance')=0
 then raise exception 'USER_APPLY_STABLE_BASIS_REQUIRED'; end if;
 -- Full manifest diff is derived server-side from an owned immutable snapshot.
 -- Only this endpoint may remove an agent-created file absent from that target.
 with old_files as(select f->>'path' path,f->>'content' content from jsonb_array_elements(public.ita_workspace_files(p.id)) f),
 new_files as(select f->>'path' path,f->>'content' content from jsonb_array_elements(s.files) f),
 diff as(select coalesce(o.path,n.path) path,o.content before_content,n.content after_content,n.path new_path
 from old_files o full join new_files n using(path) where o.content is distinct from n.content)
 select coalesce(jsonb_agg(jsonb_build_object('operation',case when new_path is null then 'delete' else 'write' end,
 'path',path,'content',after_content,
 'before_hash',case when before_content is null then null else encode(sha256(convert_to(before_content,'UTF8')),'hex') end,
 'after_hash',case when after_content is null then null else encode(sha256(convert_to(after_content,'UTF8')),'hex') end) order by path collate "C"),'[]') into changes from diff;
 if jsonb_array_length(changes)>32 then raise exception 'RESTORE_CHANGE_LIMIT: too many changed files for this execution budget'; end if;
 if public.ita_manifest_hash(public.ita_workspace_target_files(p.id,changes))<>target then raise exception 'RESTORE_TARGET_INVALID'; end if;
 insert into public.ita_tasks(project_id,user_id,mode,prompt,plan_id,plan_version,operation,requested_changeset_id,base_workspace_revision,context_workspace_revision)
 values(p.id,p.user_id,'build','恢复到 App v'||s.version_number,b.id,b.version,'user_apply',cid,p.workspace_revision,p.workspace_revision) returning * into t;
 insert into public.ita_changesets(id,project_id,user_id,request_id,actor,origin,task_id,base_revision,base_hash,target_hash,status,changes,submission_fingerprint,submission_basis)
 values(cid,p.id,p.user_id,'restore:'||p_request_id,'user','user_apply',t.id,p.workspace_revision,p.workspace_hash,target,'prepared',changes,fingerprint,
 jsonb_build_object('checkpoint_id',current_s.id,'restore_checkpoint_id',s.id,'basis_id',b.id,
 'build_basis',s.build_evidence->>'basis_fingerprint','verify_basis',s.verify_evidence->>'basis_fingerprint'));
 insert into public.ita_messages(project_id,user_id,task_id,role,content,meta)
 values(p.id,p.user_id,t.id,'user',t.prompt,jsonb_build_object('kind','restore_version','restoreCheckpointId',s.id,'restoreVersion',s.version_number));
 return jsonb_build_object('accepted',true,'task_id',t.id,'changeset_id',cid);
end $$;
notify pgrst,'reload schema';
commit;
