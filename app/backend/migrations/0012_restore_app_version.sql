-- Restore immutable historical code through the existing User Apply mutation protocol.
-- No snapshot UPDATE, no revision rewind, no business-data rollback.
begin;
create function public.ita_restore_app_version(p_project_id uuid,p_checkpoint_id uuid,p_request_id text,p_base_revision bigint)
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
 if target=p.workspace_hash then return jsonb_build_object('accepted',true,'noop',true); end if;
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
revoke all on function public.ita_restore_app_version(uuid,uuid,text,bigint) from public,anon,service_role;
grant execute on function public.ita_restore_app_version(uuid,uuid,text,bigint) to authenticated;
notify pgrst,'reload schema';
commit;
