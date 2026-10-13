-- Narrow authenticated submission; Phase 2 remains the sole mutation authority.
begin;
alter table public.ita_tasks add column operation text not null default 'agent' check(operation in ('agent','user_apply')), add column requested_changeset_id uuid;
alter table public.ita_tasks add constraint ita_tasks_requested_changeset_fk foreign key(requested_changeset_id) references public.ita_changesets(id) deferrable initially deferred;
-- Immutable submission inputs are separate from mutable mutation/reconcile outcomes.
alter table public.ita_changesets add column submission_fingerprint text, add column submission_basis jsonb;
drop index public.ita_tasks_plan_approval_unique;
create unique index ita_tasks_plan_approval_unique on public.ita_tasks(plan_id) where mode='build' and plan_id is not null and retry_of is null and operation='agent';
create function public.ita_user_submission_immutable() returns trigger language plpgsql set search_path='' as $$
begin
 if old.origin='user_apply' and (to_jsonb(new)-array['status','result','updated_at','execution_id','resulting_revision']) is distinct from (to_jsonb(old)-array['status','result','updated_at','execution_id','resulting_revision']) then raise exception 'USER_APPLY_SUBMISSION_IMMUTABLE'; end if;
 return new;
end $$;
create trigger ita_user_submission_immutable_trg before update on public.ita_changesets for each row execute function public.ita_user_submission_immutable();
create function public.ita_submit_user_apply(p_project_id uuid,p_request_id text,p_base_revision bigint,p_files jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare p public.ita_projects; s public.ita_snapshots; b public.ita_plans; c public.ita_changesets; t public.ita_tasks;
 fs jsonb; changes jsonb; target text; fingerprint text; cid uuid:=gen_random_uuid();
begin
 select * into p from public.ita_projects where id=p_project_id for update;
 if p.id is null or p.user_id is distinct from (select auth.uid()) then raise exception 'USER_APPLY_NOT_OWNED' using errcode='42501'; end if;
 if p_request_id is null or length(p_request_id) not between 1 and 200 or p_base_revision is null or jsonb_typeof(p_files) is distinct from 'array' then raise exception 'USER_APPLY_INPUT'; end if;
 if jsonb_array_length(p_files) not between 1 and 8 then raise exception 'USER_APPLY_INPUT'; end if;
 if exists(select 1 from jsonb_array_elements(p_files) f where jsonb_typeof(f) is distinct from 'object' or jsonb_typeof(f->'path') is distinct from 'string'
 or jsonb_typeof(f->'content') is distinct from 'string' or not public.ita_managed_source_path(f->>'path') or (select count(*) from jsonb_object_keys(f))<>2) then raise exception 'USER_APPLY_INPUT'; end if;
 perform public.ita_manifest_hash(p_files);
 if (select sum(octet_length(f->>'content')) from jsonb_array_elements(p_files) f)>131072 then raise exception 'USER_APPLY_INPUT'; end if;
 select jsonb_agg(f order by (f->>'path') collate "C") into fs from jsonb_array_elements(p_files) f;
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
 if exists(select 1 from jsonb_array_elements(fs) f where not exists(select 1 from public.ita_files x where x.project_id=p.id and x.path=f->>'path' and not x.deleted)) then raise exception 'USER_APPLY_EXISTING_TEXT_ONLY'; end if;
 select jsonb_agg(jsonb_build_object('operation','write','path',f->>'path','content',f->>'content','before_hash',encode(sha256(convert_to(x.content,'UTF8')),'hex'),'after_hash',encode(sha256(convert_to(f->>'content','UTF8')),'hex')) order by (f->>'path') collate "C") into changes
 from jsonb_array_elements(fs) f join public.ita_files x on x.project_id=p.id and x.path=f->>'path' and not x.deleted;
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
 values(p.id,p.user_id,'build','Apply user file edits',b.id,b.version,'user_apply',cid,p.workspace_revision,p.workspace_revision) returning * into t;
 insert into public.ita_changesets(id,project_id,user_id,request_id,actor,origin,task_id,base_revision,base_hash,target_hash,status,changes,submission_fingerprint,submission_basis)
 values(cid,p.id,p.user_id,'user:'||p_request_id,'user','user_apply',t.id,p.workspace_revision,p.workspace_hash,target,'prepared',changes,fingerprint,jsonb_build_object('checkpoint_id',s.id,'basis_id',b.id,'build_basis',s.build_evidence->>'basis_fingerprint','verify_basis',s.verify_evidence->>'basis_fingerprint'));
 return jsonb_build_object('accepted',true,'task_id',t.id,'changeset_id',cid);
end $$;
revoke all on function public.ita_submit_user_apply(uuid,text,bigint,jsonb) from public,anon,service_role;
grant execute on function public.ita_submit_user_apply(uuid,text,bigint,jsonb) to authenticated;
revoke all on function public.ita_user_submission_immutable() from public,anon,authenticated,service_role;

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
  where t.plan_id = v_plan.id and t.mode = 'build' and t.retry_of is null and t.operation='agent';
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
    where t.plan_id = v_plan.id and t.mode = 'build' and t.retry_of is null and t.operation='agent';
    if v_task.id is null then
      raise exception 'PROJECT_BUSY: 该项目已有正在执行的任务' using errcode = 'P0001';
    end if;
  end;
  return v_task;
end $$;

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
  if v_old.operation='user_apply' and p_kind='new' then raise exception 'USER_APPLY_RELOAD_REQUIRED'; end if;
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
   if c.id is null or (c.actor='user' and (c.task_id is distinct from p_task_id or not exists(select 1 from public.ita_tasks where id=p_task_id and operation='user_apply' and requested_changeset_id=c.id))) or c.status is distinct from 'prepared' or c.base_revision<>p.workspace_revision or c.base_hash<>p.workspace_hash then raise exception 'WORKSPACE_REVISION_CONFLICT'; end if;
 end if;
 w:=jsonb_build_object('operation_id',p_operation_id,'token',gen_random_uuid(),'kind',p_kind,'task_id',p_task_id,'worker_id',p_worker_id,'execution_id',p_execution_id,
   'sandbox_id',p_sandbox_id,'epoch',p.workspace_epoch+1,'base_revision',p.workspace_revision,'base_hash',coalesce(p.workspace_hash,public.ita_manifest_hash(public.ita_workspace_files(p.id))),'target_hash',case when p_changeset_id is not null then c.target_hash when p_kind='materialize' then coalesce(p.workspace_hash,public.ita_manifest_hash(public.ita_workspace_files(p.id))) else null end,'changeset_id',p_changeset_id,'started_at',now());
 update public.ita_projects set workspace_writer=w,workspace_epoch=p.workspace_epoch+1,workspace_state='applying',workspace_hash=w->>'base_hash' where id=p.id;
 if p_changeset_id is not null then update public.ita_changesets set status='applying',updated_at=now() where id=c.id; end if;
 if p_task_id is not null then update public.ita_tasks set base_workspace_revision=coalesce(base_workspace_revision,p.workspace_revision),context_workspace_revision=p.workspace_revision where id=p_task_id; end if;
 return w;
end $$;
notify pgrst,'reload schema';
commit;
