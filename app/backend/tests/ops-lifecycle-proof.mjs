/** Approved lifecycle-based proof; read-only DB/control plane. No runtime session query or wake. */
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';import {verifyFrozen} from './ops-ingress-gate.mjs';
import {readFileSync,readdirSync,readlinkSync,writeFileSync} from 'node:fs';import path from 'node:path';import {parseEnv} from 'node:util';import {createRequire} from 'node:module';
const dir=path.join(operationalRoot,'app/worker/.cutover/stage-b-2026-10-08');
const env=parseEnv(readFileSync(path.join(operationalRoot,'app/worker/.env'),'utf8'));
const req=createRequire(path.join(operationalRoot,'app/worker/package.json'));const {Daytona}=req('@daytona/sdk');
const daytona=new Daytona({apiKey:env.DAYTONA_API_KEY,apiUrl:env.DAYTONA_API_URL||'https://app.daytona.io/api',target:env.DAYTONA_TARGET||'us',requestTimeoutMs:15000});
async function observe(){let db;try{
 const c=await operationalConnect('main');db=c.db;await verifyFrozen(db);
 const tasks=(await db.query('select id,project_id,status,execution_id,worker_id,lease_until,heartbeat_at,steps from public.ita_tasks')).rows;
 const active=(await db.query(`select
 (select count(*)::int from public.ita_tasks where status in ('queued','running')) tasks,
 (select count(*)::int from public.ita_tasks where lease_until>clock_timestamp()) live_lease,
 (select count(*)::int from public.ita_tasks where heartbeat_at>clock_timestamp()-interval '1 hour') recent_heartbeat,
 (select count(*)::int from public.ita_preview_recoveries where status in ('queued','running')) preview,
 (select count(*)::int from public.ita_project_deletions where status in ('pending','running')) deletion`)).rows[0];
 const v6=(await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed;if(v6)throw new Error('EXPECT_PRE_0006');
 const projects=(await db.query('select id,user_id,sandbox_id from public.ita_projects order by id')).rows;
 const pending=new Set(),resolved=new Set(),uncertain=[];
 for(const t of tasks)for(const s of t.steps||[]){const key=t.project_id+':'+s.operation_id;if(s.tool==='change_journal'&&s.operation_id){if(s.event==='intent')pending.add(key);if(s.event==='resolved')resolved.add(key);}
  if(['run_command','build','verify','command'].includes(s.tool)&&(s.timedOut===true||s.status==='uncertain'||/COMMAND_UNCERTAIN|WORKSPACE_UNCERTAIN|client timeout|timed out|执行超时/.test(String(s.observation||''))))uncertain.push({task_id:t.id,tool:s.tool});
 }
 const unresolved=[...pending].filter(k=>!resolved.has(k));
 const workers=[];for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p)))try{const a=readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean),cwd=readlinkSync('/proc/'+pid+'/cwd');if((a[0]&&/node$/.test(a[0])&&a.slice(1).some(s=>/(^|\/)src\/index\.js$/.test(s)))||(cwd===path.join(operationalRoot,'app/worker')&&a.some(s=>/npm(?:-cli\.js)?$/.test(s))&&a.includes('start')))workers.push({pid,cwd});}catch{}
 const paused=tasks.filter(t=>t.status==='paused').map(({steps,...t})=>t);
 await db.query('ROLLBACK');await db.end();db=null;
 const sandboxes=await Promise.all([...new Set(projects.map(p=>p.sandbox_id).filter(Boolean))].sort().map(async id=>{const sb=await daytona.get(id);await sb.refreshData();return {id,state:String(sb.state),desired_state:sb.desiredState??null,sandbox_class:sb.sandboxClass??null,updated_at:sb.updatedAt??null,last_activity_at:sb.lastActivityAt??null,backup_state:sb.backupState??null,error_present:!!sb.errorReason};}));
 const good=Object.values(active).every(n=>n===0)&&!workers.length&&!unresolved.length&&!uncertain.length&&sandboxes.length===9&&sandboxes.every(s=>['stopped','archived'].includes(s.state)&&!s.error_present&&(!s.desired_state||['stopped','archived'].includes(s.desired_state)));
 return {observed_at:new Date().toISOString(),main_ref:c.config.ref,tls_verified:true,ingress_frozen:true,active,workers,unresolved_journals:unresolved,uncertain_commands:uncertain,paused,sandboxes,status:good?'PASS':'FAIL'};
}finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}}
try{
 const first=await observe();writeFileSync(path.join(dir,'lifecycle-observation-1.json'),JSON.stringify(first,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify(first));if(first.status!=='PASS')throw new Error('FIRST_LIFECYCLE_OBSERVATION_FAILED');
 await new Promise(r=>setTimeout(r,20000));
 const second=await observe();writeFileSync(path.join(dir,'lifecycle-observation-2.json'),JSON.stringify(second,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify(second));
 if(second.status!=='PASS'||JSON.stringify(first.sandboxes)!==JSON.stringify(second.sandboxes))throw new Error('LIFECYCLE_OR_ACTIVITY_CHANGED');
 const proof={status:'PASS',confirmed_at:new Date().toISOString(),main_ref:first.main_ref,observation_times:[first.observed_at,second.observed_at],stable_inactive_sandboxes:9,producer_review:{worker_owned_awaited_http_upload:true,independent_upload_queue:false,presigned_source_upload:false,external_write_job_service:false,detached_preview_process:'sandbox runtime; terminated by stop lifecycle'},scope:'known Forge managed-source/Main DB producers and sandbox executors; not an assertion about every internal platform event',inactive_listSessions_400:'not applicable to inactive runtime; prior errors retained',contract_source:'https://www.daytona.io/docs/en/sandboxes/',paused_task_not_resumed:true,no_new_writer:true,sandbox_lifecycle_changed:false,main_migration_0006_executed:false};
 writeFileSync(path.join(dir,'lifecycle-quiescence-proof.json'),JSON.stringify(proof,null,2),{mode:0o600,flag:'wx'});console.log(JSON.stringify(proof));
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||e.message||'LIFECYCLE_PROOF_FAILED'}));process.exitCode=1;}
