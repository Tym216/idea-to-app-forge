/** Stage B quiescence evidence only: no wake, execute, upload, task mutation or workspace export. */
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';
import {verifyFrozen} from './ops-ingress-gate.mjs';
import {readFileSync,readdirSync,readlinkSync,writeFileSync} from 'node:fs';
import {parseEnv} from 'node:util';import {createRequire} from 'node:module';import path from 'node:path';
const dir=path.join(operationalRoot,'app/worker/.cutover/stage-b-2026-10-08');let db;
try{
 const c=await operationalConnect('main');db=c.db;await verifyFrozen(db);
 const tasks=(await db.query("select id,project_id,status,phase,execution_id,worker_id,lease_until,heartbeat_at,plan_id,plan_version,last_tool,steps from public.ita_tasks")).rows;
 const projects=(await db.query('select id,sandbox_id from public.ita_projects')).rows;
 const preview=(await db.query("select project_id,status,worker_id,execution_id,lease_until from public.ita_preview_recoveries where status in ('queued','running')")).rows;
 const deletion=(await db.query("select project_id,status,worker_id,lease_until from public.ita_project_deletions where status in ('pending','running')")).rows;
 const pending=new Map(),resolved=new Set(),uncertain=[];
 for(const t of tasks)for(const s of t.steps||[]){const key=t.project_id+':'+s.operation_id;
  if(s.tool==='change_journal'&&s.operation_id){if(s.event==='intent')pending.set(key,{task_id:t.id,project_id:t.project_id,operation_id:s.operation_id});if(s.event==='resolved')resolved.add(key);}
  if(['run_command','build','verify','command'].includes(s.tool)&&(s.timedOut===true||s.status==='uncertain'||/COMMAND_UNCERTAIN|WORKSPACE_UNCERTAIN|client timeout|timed out|执行超时/.test(String(s.observation||''))))uncertain.push({task_id:t.id,tool:s.tool});
 }
 const rights=(await db.query("select has_table_privilege('authenticated','public.ita_tasks','INSERT') user_task_insert,has_function_privilege('authenticated','public.ita_resume_task(uuid)','EXECUTE') user_resume,has_function_privilege('authenticated','public.ita_retry_task(uuid,text)','EXECUTE') user_retry,has_table_privilege(current_user,'public.ita_tasks','INSERT') admin_task_insert,has_function_privilege(current_user,'public.ita_approve_plan(uuid,integer)','EXECUTE') admin_approve")).rows[0];
 const user=(await db.query('select id from auth.users order by created_at limit 1')).rows[0]?.id;if(!user)throw new Error('CANARY_AUTH_USER_MISSING');
 await db.query('select set_config($1,$2,true)',['request.jwt.claims',JSON.stringify({sub:user,role:'authenticated'})]);await db.query('SET LOCAL ROLE authenticated');
 const reads={projects:(await db.query('select count(*)::int n from public.ita_projects')).rows[0].n,tasks:(await db.query('select count(*)::int n from public.ita_tasks')).rows[0].n,plans:(await db.query('select count(*)::int n from public.ita_plans')).rows[0].n,files:(await db.query('select count(*)::int n from public.ita_files')).rows[0].n};
 await db.query('ROLLBACK');await db.end();db=null;
 const workers=[];for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p)))try{
  const argv=readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean),cwd=readlinkSync('/proc/'+pid+'/cwd');
  if((argv[0]&&/node$/.test(argv[0])&&argv.slice(1).some(s=>/(^|\/)src\/index\.js$/.test(s)))||(cwd===path.join(operationalRoot,'app/worker')&&argv.some(s=>/npm(?:-cli\.js)?$/.test(s))&&argv.includes('start')))workers.push({pid:Number(pid),cwd});
 }catch{}
 const env=parseEnv(readFileSync(path.join(operationalRoot,'app/worker/.env'),'utf8'));
 const req=createRequire(path.join(operationalRoot,'app/worker/package.json'));const {Daytona}=req('@daytona/sdk');
 const daytona=new Daytona({apiKey:env.DAYTONA_API_KEY,apiUrl:env.DAYTONA_API_URL||'https://app.daytona.io/api',target:env.DAYTONA_TARGET||'us',requestTimeoutMs:15000});
 const sandboxes=await Promise.all([...new Set(projects.map(p=>p.sandbox_id).filter(Boolean))].map(async id=>{
  try{const sb=await daytona.get(id);let sessions;
   try{const data=await sb.process.listSessions();sessions={status:'PASS',sessions:data.map(s=>({id:s.sessionId||s.id,commands:(s.commands||[]).map(c=>({id:c.id||c.commandId,exit_code:c.exitCode??null}))}))};}
   catch(e){sessions={status:'UNKNOWN',http_status:e.statusCode||e.response?.status||null,error_type:typeof e.code==='string'?e.code:'DAYTONA_SESSION_QUERY_FAILED'};}
   return {id,state:String(sb.state),sessions,upload_quiescence:'UNKNOWN',lifecycle_changed:false};
  }catch(e){return {id,status:'UNKNOWN',error_type:typeof e.code==='string'?e.code:'DAYTONA_GET_FAILED',lifecycle_changed:false};}
 }));
 const result={checked_at:new Date().toISOString(),main_ref:c.config.ref,tls_verified:true,ingress_frozen:true,rights,authenticated_read_only_access:reads,local_workers:workers,active_tasks:tasks.filter(t=>['queued','running'].includes(t.status)).map(({steps,...t})=>t),paused_tasks:tasks.filter(t=>t.status==='paused').map(({steps,...t})=>t),preview_active:preview,deletion_active:deletion,unresolved_journals:[...pending].filter(([k])=>!resolved.has(k)).map(([,v])=>v),uncertain_commands:uncertain,sandboxes,remote_quiescence:'UNKNOWN',paused_physical_source:'NOT_READ',backup_created:false,restore_performed:false,migration_0006_executed:false,unfrozen:false};
 writeFileSync(path.join(dir,'quiescence-inspection.json'),JSON.stringify(result,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:typeof e.code==='string'?e.code:'STAGE_B_INSPECTION_FAILED'}));process.exitCode=1;}
finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
