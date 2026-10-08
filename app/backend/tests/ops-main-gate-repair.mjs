/** Authorized narrow repair: derive only the RLS helper EXECUTE from the saved pre-freeze ACL. */
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';
import {isPolicyHelperGrant,assertPolicyDependencies,verifyFrozen,gateSQL} from './ops-ingress-gate.mjs';
import {readFileSync,writeFileSync,existsSync} from 'node:fs';import path from 'node:path';let db;
const dir=path.join(operationalRoot,'app/worker/.cutover/stage-b-2026-10-08');
try{
 if(!process.argv.includes('--ack-narrow-helper-repair'))throw new Error('NARROW_REPAIR_APPROVAL_REQUIRED');
 if(existsSync(path.join(dir,'narrow-gate-repair.json')))throw new Error('NARROW_REPAIR_ALREADY_RECORDED');
 const original=JSON.parse(readFileSync(path.join(dir,'main-ingress.json'),'utf8'));
 if(original.ref!=='vfzyimhapttcdxeabvur'||original.version!==1)throw new Error('PRE_FREEZE_ACL_TARGET_MISMATCH');
 const helperGrants=original.grants.filter(isPolicyHelperGrant);
 if(helperGrants.length!==1||helperGrants[0].grantee!=='authenticated'||helperGrants[0].privilege!=='EXECUTE'||helperGrants[0].grantable!==false)throw new Error('ORIGINAL_HELPER_ACL_UNEXPECTED');
 const sql=gateSQL({...original,grants:helperGrants},true);
 const c=await operationalConnect('main');db=c.db;await db.query('ROLLBACK');await db.query('BEGIN');
 const dependencies=await assertPolicyDependencies(db);
 if((await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed)throw new Error('EXPECT_PRE_0006');
 await db.query(sql);await verifyFrozen(db);
 const users=(await db.query('select id from auth.users order by created_at')).rows;if(users.length<2)throw new Error('NEED_EXISTING_TWO_USERS_FOR_ISOLATION');
 const tables=['ita_projects','ita_tasks','ita_plans','ita_files','ita_messages'],baseline={};
 for(const table of tables)baseline[table]=(await db.query(`select user_id,count(*)::int n from public.${table} group by user_id`)).rows;
 const owned=(await db.query('select id,user_id from public.ita_projects order by created_at')).rows;
 const reads=[],denials=[];
 for(const user of users){
  await db.query('select set_config($1,$2,true)',['request.jwt.claims',JSON.stringify({sub:user.id,role:'authenticated'})]);await db.query('SET LOCAL ROLE authenticated');
  for(const table of tables){
   const count=(await db.query(`select count(*)::int n from public.${table}`)).rows[0].n,expected=baseline[table].find(r=>r.user_id===user.id)?.n||0;
   if(count!==expected)throw new Error('RLS_OWNER_COUNT_MISMATCH');
   const foreign=(await db.query(`select count(*)::int n from public.${table} where user_id<>$1`,[user.id])).rows[0].n;
   if(foreign!==0)throw new Error('RLS_CROSS_USER_LEAK');reads.push({table,user_id:user.id,owned_rows:count,foreign_rows:foreign});
  }
  const project=owned.find(p=>p.user_id===user.id)||owned[0];if(!project)throw new Error('REAL_PROJECT_REQUIRED');
  const cases=[
   ['project INSERT',"insert into public.ita_projects(user_id,name) values($1,'must deny')",[user.id]],
   ['project UPDATE',"update public.ita_projects set name='must deny' where id=$1",[project.id]],
   ['Build enqueue',"insert into public.ita_tasks(project_id,user_id,mode,prompt) values($1,$2,'build','must deny')",[project.id,user.id]],
   ['file UPDATE',"update public.ita_files set content='must deny' where project_id=$1",[project.id]],
   ['file INSERT',"insert into public.ita_files(project_id,user_id,path,content) values($1,$2,'__gate_denied__.tsx','must deny')",[project.id,user.id]],
   ['message INSERT',"insert into public.ita_messages(project_id,user_id,role,content) values($1,$2,'user','must deny')",[project.id,user.id]],
   ['resume',"select public.ita_resume_task($1::uuid)",[project.id]],
   ['retry',"select public.ita_retry_task($1::uuid,'new')",[project.id]],
   ['approve Build',"select public.ita_approve_plan($1::uuid,1)",[project.id]],
   ['preview mutation',"select public.ita_request_preview_recovery($1::uuid)",[project.id]],
   ['delete mutation',"select public.ita_request_project_delete($1::uuid)",[project.id]],
   ['agent writer',"select public.ita_worker_update_task($1::uuid,'blocked',$2::uuid,'{}'::jsonb)",[project.id,project.id]],
   ['Worker claim',"select * from public.ita_claim_task('blocked',120)",[]]
  ];
  for(const [name,query,params] of cases){
   await db.query('SAVEPOINT forbidden_action');let code;
   try{await db.query(query,params);}catch(e){code=e.code;}
   finally{await db.query('ROLLBACK TO SAVEPOINT forbidden_action');await db.query('RELEASE SAVEPOINT forbidden_action');}
   if(code!=='42501')throw new Error('MUTATION_DENIAL_MISMATCH');denials.push({name,user_id:user.id,sqlstate:code});
  }
  await db.query('RESET ROLE');
 }
 const admin=(await db.query("select has_table_privilege(current_user,'public.ita_tasks','INSERT') enqueue,has_function_privilege(current_user,'public.ita_approve_plan(uuid,integer)','EXECUTE') approve")).rows[0];
 if(!admin.enqueue||!admin.approve)throw new Error('ADMIN_CANARY_PERMISSION_LOST');await verifyFrozen(db);
 await db.query('COMMIT');
 const result={status:'PASS',checked_at:new Date().toISOString(),main_ref:c.config.ref,tls_verified:true,exact_grant:sql,grant_source:'saved main-ingress.json actual pre-freeze ACL',allowlist:['public.ita_owns_project(uuid)'],policy_dependencies:dependencies,rls_execution:'real PostgreSQL authenticated role + existing Auth user claims; no service-role bypass; not a browser login test',reads,denials,admin_canary:admin,ingress_still_frozen:true,task_source_state_changed:false,migration_0006_executed:false,unfreeze_executed:false};
 writeFileSync(path.join(dir,'narrow-gate-repair.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}catch(e){if(db)await db.query('ROLLBACK').catch(()=>{});console.log(JSON.stringify({status:'FAIL',error_type:e.code||e.message||'NARROW_GATE_REPAIR_FAILED',main_unfrozen:false}));process.exitCode=1;}
finally{if(db)await db.end();}
