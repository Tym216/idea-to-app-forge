-- Product editor additions. Reuse existing authority, immutable checkpoints and task lifecycle.
begin;
create or replace function public.ita_submit_user_apply(p_project_id uuid,p_request_id text,p_base_revision bigint,p_files jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; s public.ita_snapshots; b public.ita_plans; c public.ita_changesets; t public.ita_tasks;
 fs jsonb; changes jsonb; target text; fingerprint text; cid uuid:=gen_random_uuid();
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 if p.id is null or p.user_id is distinct from (select auth.uid()) then raise exception 'USER_APPLY_NOT_OWNED' using errcode='42501'; end if;
 if p_request_id is null or length(p_request_id) not between 1 and 200 or p_base_revision is null or jsonb_typeof(p_files) is distinct from 'array' then raise exception 'USER_APPLY_INPUT'; end if;
 if jsonb_array_length(p_files) not between 1 and 8 then raise exception 'USER_APPLY_INPUT'; end if;
 if exists(select 1 from jsonb_array_elements(p_files) f where jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(f->'path') is distinct from 'string'
 or not public.ita_managed_source_path(f->>'path')
 or coalesce(f->>'operation','write') not in ('write','create','delete')
 or (coalesce(f->>'operation','write')<>'delete' and jsonb_typeof(f->'content') is distinct from 'string')
 or (coalesce(f->>'operation','write')='delete' and f ? 'content')
 or exists(select 1 from jsonb_object_keys(f) k where k not in ('path','content','operation'))) then raise exception 'USER_APPLY_INPUT'; end if;
 if exists(select 1 from jsonb_array_elements(p_files) f group by f->>'path' having count(*)>1) then raise exception 'USER_APPLY_INPUT'; end if;
 perform public.ita_manifest_hash(coalesce((select jsonb_agg(jsonb_build_object('path',f->>'path','content',f->>'content')) from jsonb_array_elements(p_files) f where coalesce(f->>'operation','write')<>'delete'),'[]'));
 if (select sum(octet_length(f->>'content')) from jsonb_array_elements(p_files) f)>131072 then raise exception 'USER_APPLY_INPUT'; end if;
 select jsonb_agg(case when coalesce(f->>'operation','write')='write' then f-'operation' else f end order by (f->>'path') collate "C") into fs from jsonb_array_elements(p_files) f;
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('project',p.id,'base',p_base_revision,'files',fs)::text,'UTF8')),'hex');
 select * into c from public.ita_changesets where project_id=p.id and request_id='user:'||p_request_id;
 if c.id is not null then
  if c.actor<>'user' or c.submission_fingerprint is distinct from fingerprint then raise exception 'USER_APPLY_REQUEST_CONFLICT'; end if;
  return jsonb_build_object('accepted',true,'task_id',c.task_id,'changeset_id',c.id);
 end if;
 if p.deletion_state is not null then raise exception 'PROJECT_DELETING'; end if;
 if p.workspace_revision is distinct from p_base_revision then raise exception 'WORKSPACE_REVISION_CONFLICT: reload and reapply'; end if;
 if p.workspace_state<>'confirmed' or p.workspace_writer is not null or public.ita_workspace_has_unresolved(p.id) then raise exception 'WORKSPACE_RECONCILE_REQUIRED'; end if;
 if exists(select 1 from public.ita_tasks where project_id=p.id and status in ('queued','running','paused'))
 or exists(select 1 from public.ita_preview_recoveries where project_id=p.id and status in ('queued','running')) then raise exception 'PROJECT_BUSY'; end if;
 if exists(select 1 from jsonb_array_elements(fs) f where coalesce(f->>'operation','write')='create' and exists(select 1 from public.ita_files x where x.project_id=p.id and x.path=f->>'path' and not x.deleted)) then raise exception 'USER_APPLY_FILE_EXISTS'; end if;
 if exists(select 1 from jsonb_array_elements(fs) f where coalesce(f->>'operation','write')='delete' and
  (not exists(select 1 from public.ita_files x where x.project_id=p.id and x.path=f->>'path' and not x.deleted)
   or f->>'path' in ('package.json','package-lock.json','index.html','src/main.tsx','src/App.tsx','src/index.css','src/design-tokens.css','vite.config.ts','tsconfig.json')
   or not exists(select 1 from public.ita_changesets cs cross join lateral jsonb_array_elements(cs.changes) ch
    where cs.project_id=p.id and cs.actor='user' and cs.status='committed' and ch->>'path'=f->>'path' and ch->>'operation'='write' and ch->'before_hash'='null'::jsonb)))
 then raise exception 'USER_APPLY_DELETE_NOT_ALLOWED'; end if;
 select jsonb_agg(jsonb_build_object('operation',case when f->>'operation'='delete' then 'delete' else 'write' end,
  'path',f->>'path','content',case when f->>'operation'='delete' then null else f->>'content' end,
  'before_hash',case when x.path is not null then encode(sha256(convert_to(x.content,'UTF8')),'hex') else null end,
  'after_hash',case when f->>'operation'='delete' then null else encode(sha256(convert_to(f->>'content','UTF8')),'hex') end) order by (f->>'path') collate "C") into changes
 from jsonb_array_elements(fs) f left join public.ita_files x on x.project_id=p.id and x.path=f->>'path' and not x.deleted;
 target:=public.ita_manifest_hash(public.ita_workspace_target_files(p.id,changes));
 -- A no-op is not a new mutation or another build/verify/publish opportunity.
 -- Under the project lock, compare the authoritative whole-source target, not a client flag.
 if target=p.workspace_hash then return jsonb_build_object('accepted',true,'noop',true); end if;
 select * into s from public.ita_snapshots where id=p.checkpoint_id and project_id=p.id and kind='checkpoint';
 select * into b from public.ita_plans where id=s.basis_id and project_id=p.id;
 if s.id is null or s.workspace_revision is null or coalesce(s.code_hash,'') !~ '^[0-9a-f]{64}$' or coalesce(s.build_evidence->>'basis_fingerprint','') !~ '^[0-9a-f]{64}$' or coalesce(s.verify_evidence->>'basis_fingerprint','') !~ '^[0-9a-f]{64}$' or s.build_evidence->>'workspace_revision' is distinct from s.workspace_revision::text or s.build_evidence->>'code_hash' is distinct from s.code_hash or s.verify_evidence->>'workspace_revision' is distinct from s.workspace_revision::text or s.verify_evidence->>'code_hash' is distinct from s.code_hash or s.build_evidence->>'status' is distinct from 'passed'
 or coalesce(s.verify_evidence->>'status','') not in ('passed','success_with_warnings','inconclusive') or b.id is null
 or jsonb_typeof(b.content->'acceptance') is distinct from 'array' or jsonb_array_length(b.content->'acceptance')=0 then raise exception 'USER_APPLY_STABLE_BASIS_REQUIRED'; end if;
 insert into public.ita_tasks(project_id,user_id,mode,prompt,plan_id,plan_version,operation,requested_changeset_id,base_workspace_revision,context_workspace_revision)
 values(p.id,p.user_id,'build',(select string_agg(case when f->>'operation'='delete' then '删除 ' when not exists(select 1 from public.ita_files x where x.project_id=p.id and x.path=f->>'path' and not x.deleted) then '新增 ' else '修改 ' end||(f->>'path'),'；' order by f->>'path') from jsonb_array_elements(fs) f),b.id,b.version,'user_apply',cid,p.workspace_revision,p.workspace_revision) returning * into t;
 insert into public.ita_changesets(id,project_id,user_id,request_id,actor,origin,task_id,base_revision,base_hash,target_hash,status,changes,submission_fingerprint,submission_basis)
 values(cid,p.id,p.user_id,'user:'||p_request_id,'user','user_apply',t.id,p.workspace_revision,p.workspace_hash,target,'prepared',changes,fingerprint,jsonb_build_object('checkpoint_id',s.id,'basis_id',b.id,'build_basis',s.build_evidence->>'basis_fingerprint','verify_basis',s.verify_evidence->>'basis_fingerprint'));
 insert into public.ita_messages(project_id,user_id,task_id,role,content,meta)
 values(p.id,p.user_id,t.id,'user',t.prompt,jsonb_build_object('kind','user_apply',
 'createdFiles',coalesce((select jsonb_agg(ch->>'path') from jsonb_array_elements(changes) ch where ch->>'operation'='write' and ch->'before_hash'='null'::jsonb),'[]'),
 'deletedFiles',coalesce((select jsonb_agg(ch->>'path') from jsonb_array_elements(changes) ch where ch->>'operation'='delete'),'[]')));
 return jsonb_build_object('accepted',true,'task_id',t.id,'changeset_id',cid);
end $$;
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
 values(p.id,p.user_id,p_task_id,left(case when parent_id is null then 'Initial app' else coalesce((select prompt from public.ita_tasks where id=p_task_id),p_summary) end,120),public.ita_workspace_files(p.id),'checkpoint',p_revision,p_hash,p.workspace_build,p.workspace_verify,p_basis_id,p_execution_id,p_key,fingerprint,next_version,parent_id) returning * into s;
 phase_name:=case when p.workspace_verify->>'status'='passed' then 'done' else 'done_with_warnings' end;
 insert into public.ita_messages(project_id,user_id,task_id,role,content,meta) values(p.id,p.user_id,p_task_id,'assistant',p_summary,jsonb_build_object('checkpointId',s.id,'versionNumber',s.version_number,'previewUrl',p_preview_url));
 update public.ita_projects set checkpoint_id=s.id,status='ready',preview_url=p_preview_url,updated_at=now() where id=p.id;
 update public.ita_tasks set status='succeeded',phase=phase_name,finished_at=now(),lease_until=null,updated_at=now() where id=p_task_id;
 return jsonb_build_object('snapshot_id',s.id,'completed',true,'phase',phase_name,'version_number',s.version_number);
end $$;

notify pgrst,'reload schema';
commit;
