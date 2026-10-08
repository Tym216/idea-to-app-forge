/** Stage A: read-only DB/Daytona metadata, no lifecycle RPC/start/stop/upload/file export. */
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';
import {captureIngress,gateSQL} from './ops-ingress-gate.mjs';
import {readFileSync,readdirSync,readlinkSync,writeFileSync,mkdirSync} from 'node:fs';
import {parseEnv} from 'node:util';import {createRequire} from 'node:module';import path from 'node:path';
import {sourceManifest} from '../../worker/src/managed-source.js';
let db;
try{
 const c=await operationalConnect('main');db=c.db;
 const tasks=(await db.query('select id,project_id,user_id,status,phase,execution_id,worker_id,lease_until,heartbeat_at,plan_id,plan_version,tool_steps,fix_rounds,steps,last_tool from public.ita_tasks order by created_at')).rows;
 const projects=(await db.query('select id,user_id,sandbox_id,status,deletion_state from public.ita_projects order by id')).rows;
 const pending=new Map(),resolved=new Set(),uncertain=[];
 for(const t of tasks)for(const s of t.steps||[]){
  const key=t.project_id+':'+s.operation_id;
  if(s.tool==='change_journal'&&s.operation_id){if(s.event==='intent')pending.set(key,{task_id:t.id,project_id:t.project_id,operation_id:s.operation_id,sandbox_id:s.sandbox_id,path:s.path});if(s.event==='resolved')resolved.add(key);}
  if(['run_command','build','verify','command'].includes(s.tool)&&(s.timedOut===true||s.status==='uncertain'||/COMMAND_UNCERTAIN|WORKSPACE_UNCERTAIN|client timeout|timed out|执行超时/.test(String(s.observation||''))))uncertain.push({task_id:t.id,project_id:t.project_id,tool:s.tool,status:s.status||null});
 }
 const paused=[];
 for(const t of tasks.filter(t=>t.status==='paused')){
  const p=projects.find(p=>p.id===t.project_id);const files=(await db.query('select path,content from public.ita_files where project_id=$1 and not deleted order by path',[t.project_id])).rows;
  const manifest=sourceManifest(files);
  const plan=(await db.query('select id,version,kind,status,content from public.ita_plans where id=$1',[t.plan_id])).rows[0];
  const snapshots=(await db.query('select id,task_id,label,created_at,jsonb_typeof(files) files_type from public.ita_snapshots where project_id=$1 order by created_at desc',[t.project_id])).rows;
  paused.push({task_id:t.id,project_id:t.project_id,user_id:t.user_id,status:t.status,phase:t.phase,execution_id:t.execution_id,worker_id:t.worker_id,lease_until:t.lease_until,heartbeat_at:t.heartbeat_at,last_tool:t.last_tool,tool_steps:t.tool_steps,fix_rounds:t.fix_rounds,sandbox_id:p?.sandbox_id,plan:plan?{id:plan.id,version:plan.version,kind:plan.kind,status:plan.status,bound_version:t.plan_version,acceptance:(plan.content?.acceptance||[]).map(a=>({id:a.id,severity:a.severity||null,steps:a.steps?.length||0}))}:null,source:{origin:'ita_files durable DB rows',managed_files:manifest.files.length,code_hash:manifest.code_hash,paths:manifest.files.map(f=>f.path),lockfile:manifest.files.some(f=>f.path==='package-lock.json'),physical_sandbox_manifest_verified:false},snapshots,pending_source_intents:[...pending].filter(([k])=>!resolved.has(k)&&k.startsWith(t.project_id+':')).map(([,v])=>v)});
 }
 const queues={preview:(await db.query('select project_id,status,worker_id,execution_id,lease_until from public.ita_preview_recoveries')).rows,deletion:(await db.query('select project_id,status,worker_id,lease_until,attempts from public.ita_project_deletions')).rows};
 const v6=(await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed;
 const writer=v6?(await db.query('select id,workspace_state,workspace_writer from public.ita_projects where workspace_writer is not null')).rows:[];
 const auth=(await db.query('select id from auth.users order by created_at')).rows;
 const resumeACL=(await db.query("select has_function_privilege('authenticated','public.ita_resume_task(uuid)','EXECUTE') authenticated_resume,has_function_privilege('authenticated','public.ita_retry_task(uuid,text)','EXECUTE') authenticated_retry")).rows[0];
 const database=(await db.query("select current_setting('server_version') server_version,pg_backend_pid() pid,current_setting('transaction_read_only') read_only")).rows[0];
 const activity=(await db.query("select application_name,state,count(*)::int sessions from pg_stat_activity where datname=current_database() and pid<>pg_backend_pid() group by application_name,state order by application_name,state")).rows;
 const catalog={auth_columns:(await db.query("select table_name,column_name,data_type,is_nullable from information_schema.columns where table_schema='auth' order by table_name,ordinal_position")).rows,extensions:(await db.query('select extname,extversion from pg_extension order by extname')).rows,storage_objects:(await db.query('select count(*)::int n from storage.objects')).rows[0].n,storage_buckets:(await db.query('select count(*)::int n from storage.buckets')).rows[0].n,vault_secrets:(await db.query('select count(*)::int n from vault.secrets')).rows[0].n,custom_roles:(await db.query("select rolname from pg_roles where rolname !~ '^(pg_|supabase_)' and rolname not in ('postgres','anon','authenticated','service_role','authenticator','dashboard_user','pgbouncer') order by rolname")).rows};
 const gate=await captureIngress(db,c.config.ref);const freezeSQL=gateSQL(gate),unfreezeSQL=gateSQL(gate,true);
 await db.query('ROLLBACK');
 // Explicit Worker env is read ONLY for Daytona credentials. No Supabase .env fallback or SDK resolve/ensure calls.
 const env=parseEnv(readFileSync(path.join(operationalRoot,'app/worker/.env'),'utf8'));
 const req=createRequire(path.join(operationalRoot,'app/worker/package.json'));const {Daytona}=req('@daytona/sdk');
 const daytona=new Daytona({apiKey:env.DAYTONA_API_KEY,apiUrl:env.DAYTONA_API_URL||'https://app.daytona.io/api',target:env.DAYTONA_TARGET||'us'});
 const sandboxes=[];
 for(const id of new Set(projects.map(p=>p.sandbox_id).filter(Boolean))){try{const sb=await daytona.get(id),state=String(sb.state);const sessions=state.toLowerCase()==='started'?(await sb.process.listSessions()).map(s=>({id:s.sessionId||s.id,commands:(s.commands||[]).map(c=>({id:c.id||c.commandId,exit_code:c.exitCode??null,potentially_live:c.exitCode==null}))})):[];sandboxes.push({id,state,sessions,inflight_upload_proven_quiesced:false});}catch(e){sandboxes.push({id,error_type:e.statusCode||e.response?.status||e.code||'DAYTONA_READ_ERROR'});}}
 const workers=[];for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p)))try{const a=readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean);if(a[0]&&/node$/.test(a[0])&&a.slice(1).some(v=>/(^|\/)src\/index\.js$/.test(v)))workers.push({pid:Number(pid),cwd:readlinkSync('/proc/'+pid+'/cwd')});}catch{}
 const result={status:'INSPECTED_NOT_GO',main_ref:c.config.ref,tls_verified:true,database,task_counts:Object.fromEntries(['queued','running','paused','failed','succeeded','cancelled'].map(s=>[s,tasks.filter(t=>t.status===s).length])),active_tasks:tasks.filter(t=>['queued','running'].includes(t.status)).map(({steps,...t})=>t),paused,unresolved_journal:[...pending].filter(([k])=>!resolved.has(k)).map(([,s])=>s),uncertain_command_records:uncertain,queues,v6_installed:v6,workspace_writers:writer,auth_user_ids:auth.map(x=>x.id),resumeACL,workers,sandboxes,activity,catalog,gate_capture:{grants:gate.grants.length,freeze_SQL_generated:true,unfreeze_SQL_generated:true,applied:false},main_modified:false};
 const dir=path.join(operationalRoot,'app/worker/.cutover/stage-a-2026-10-08');mkdirSync(dir,{recursive:true,mode:0o700});
 for(const [name,data] of [['main-operational.json',JSON.stringify(result,null,2)],['main-ingress-preview.json',JSON.stringify(gate,null,2)],['main-ingress-preview.freeze.sql',freezeSQL],['main-ingress-preview.unfreeze.sql',unfreezeSQL]])writeFileSync(path.join(dir,name),data,{mode:0o600});
 console.log(JSON.stringify({main_ref:c.config.ref,tls_verified:true,database,task_counts:result.task_counts,paused,unresolved_journal:result.unresolved_journal,uncertain_command_records:uncertain,queues,workspace_writers:writer,workers,sandboxes,catalog_summary:{auth_tables:new Set(catalog.auth_columns.map(c=>c.table_name)).size,extensions:catalog.extensions,storage_objects:catalog.storage_objects,storage_buckets:catalog.storage_buckets,vault_secrets:catalog.vault_secrets,custom_roles:catalog.custom_roles},gate:result.gate_capture,canary_candidate_user_ids:result.auth_user_ids,resumeACL,main_modified:false}));
}catch(e){console.log(JSON.stringify({stage:'Main operational readonly',status:'FAIL',error_type:typeof e.code==='string'?e.code:'OPERATIONAL_INSPECTION_FAILED'}));process.exitCode=1;}
finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
