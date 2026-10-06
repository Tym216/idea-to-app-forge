/** Inspection only: no task/RPC mutation, no sandbox ensure/start/resolve, no backups or deploy. */
import {readFileSync,readdirSync,readlinkSync} from 'node:fs';
import {parseEnv} from 'node:util';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../../../',import.meta.url)).replace(/\/$/,'');
const env=parseEnv(readFileSync(root+'/app/worker/.env','utf8'));
const ref=new URL(env.SUPABASE_URL).hostname.split('.')[0];
if(ref!=='vfzyimhapttcdxeabvur')throw new Error('UNEXPECTED_MAIN_PROJECT');
const key=env.SUPABASE_SERVICE_ROLE_KEY;
const claims=JSON.parse(Buffer.from(key.split('.')[1],'base64url').toString());
if(claims.ref!==ref||claims.role!=='service_role')throw new Error('MAIN_SERVICE_ROLE_MISMATCH');
const log=v=>console.log(JSON.stringify(v));
const api=async(path,extra={})=>{
 const r=await fetch(env.SUPABASE_URL+path,{method:'GET',headers:{apikey:key,Authorization:'Bearer '+key,...extra},signal:AbortSignal.timeout(15000)});
 if(!r.ok){let b;try{b=await r.json();}catch{}throw Object.assign(new Error('READ_FAILED'),{code:b?.code||'HTTP_'+r.status});}
 return {data:await r.json(),range:r.headers.get('content-range')};
};
async function rows(table,query){
 const all=[];for(let offset=0;offset<100000;offset+=200){const r=await api('/rest/v1/'+table+'?'+query,{Range:offset+'-'+(offset+199),Prefer:'count=exact'});all.push(...r.data);
 const total=Number(r.range?.split('/')[1]);if(r.data.length<200||(Number.isFinite(total)&&all.length>=total))return all;}
 throw new Error('READ_INCOMPLETE');
}
try {
 const openapi=(await api('/rest/v1/',{Accept:'application/openapi+json'})).data;
 const defs=openapi.definitions||{};const paths=openapi.paths||{};
 const checks={
  '0001':!!defs.ita_projects&&!!defs.ita_tasks&&!!defs.ita_files&&!!defs.ita_snapshots,
  '0002':!!defs.ita_plans&&!!defs.ita_tasks?.properties?.execution_id&&!!paths['/rpc/ita_worker_save_plan'],
  '0003':!!defs.ita_project_deletions&&!!defs.ita_audit_log&&!!paths['/rpc/ita_request_project_delete'],
  '0004':!!paths['/rpc/ita_pause_task']&&!!paths['/rpc/ita_resume_task'],
  '0005':!!defs.ita_preview_recoveries&&!!paths['/rpc/ita_claim_preview_recovery'],
  '0006_present':!!defs.ita_changesets||!!defs.ita_projects?.properties?.workspace_revision,
 };
 log({inspection:'main migration API surface',ref,checks,proof_limit:'not a full PostgreSQL DDL/ACL/trigger fingerprint'});
 const tasks=await rows('ita_tasks','select=id,project_id,status,phase,worker_id,execution_id,lease_until,heartbeat_at,last_tool&status=in.(queued,running,paused)');
 log({inspection:'tasks',ref,counts:Object.fromEntries(['queued','running','paused'].map(s=>[s,tasks.filter(t=>t.status===s).length])),items:tasks});
 const recovery=await rows('ita_preview_recoveries','select=project_id,status,phase,worker_id,execution_id,lease_until,updated_at');
 log({inspection:'preview recovery',counts:Object.fromEntries(['queued','running','ready','failed'].map(s=>[s,recovery.filter(j=>j.status===s).length])),pending:recovery.filter(j=>['queued','running'].includes(j.status))});
 const deletions=await rows('ita_project_deletions','select=project_id,status,worker_id,lease_until,attempts');
 log({inspection:'deletion queue',counts:Object.fromEntries(['pending','running','failed'].map(s=>[s,deletions.filter(j=>j.status===s).length]))});
 const journalRows=await rows('ita_tasks','select=id,project_id,status,steps&steps=cs.'+encodeURIComponent(JSON.stringify([{tool:'change_journal',event:'intent'}])));
 const pending=[];for(const pid of new Set(journalRows.map(t=>t.project_id))){
   const history=await rows('ita_tasks','select=id,project_id,steps&project_id=eq.'+pid);
   const intent=new Map(),resolved=new Set();for(const t of history)for(const s of t.steps||[]){if(s.tool!=='change_journal'||!s.operation_id)continue;if(s.event==='intent')intent.set(s.operation_id,{task_id:t.id,project_id:pid,operation_id:s.operation_id,sandbox_id:s.sandbox_id,path:s.path});if(s.event==='resolved')resolved.add(s.operation_id);}
   pending.push(...[...intent].filter(([id])=>!resolved.has(id)).map(([,s])=>s));
 }
 log({inspection:'unresolved legacy journal',count:pending.length,items:pending});
 // Completed task status cannot establish remote command quiescence. Scan error records conservatively.
 const histories=await rows('ita_tasks','select=id,project_id,status,steps');
 const suspects=[];for(const t of histories)for(const s of t.steps||[]){if(!['run_command','build','verify','command'].includes(s.tool))continue;
   const text=String(s.observation||'');if(s.timedOut===true||s.status==='uncertain'||/COMMAND_UNCERTAIN|WORKSPACE_UNCERTAIN|client timeout|timed out|执行超时/.test(text))suspects.push({task_id:t.id,project_id:t.project_id,task_status:t.status,tool:s.tool,step_status:s.status||null});}
 log({inspection:'historical possible uncertain command records',count:suspects.length,items:suspects,proof_limit:'requires matching process/upload completion evidence; not automatically unresolved'});
 const projects=await rows('ita_projects','select=id,sandbox_id,status,deletion_state');
 log({inspection:'projects',count:projects.length,sandbox_references:projects.filter(p=>p.sandbox_id).length});
 const req=createRequire(root+'/app/worker/package.json');const {Daytona}=req('@daytona/sdk');
 const daytona=new Daytona({apiKey:env.DAYTONA_API_KEY,apiUrl:env.DAYTONA_API_URL||'https://app.daytona.io/api',target:env.DAYTONA_TARGET||'us'});
 for(const id of new Set(projects.map(p=>p.sandbox_id).filter(Boolean))) {
  try {
   const sb=await daytona.get(id);const state=String(sb.state);const sessions=[];
   if(state.toLowerCase()==='started'){
    for(const session of await sb.process.listSessions())for(const c of session.commands||[])sessions.push({session_id:session.sessionId||session.id||null,command_id:c.id||c.commandId||null,exit_code:c.exitCode??null,potentially_live:c.exitCode==null,kind:/vite|npm run .*dev/.test(c.command||'')?'dev':/install|build|forge-workspace|write|cp |mv /.test(c.command||'')?'possible_writer':'other'});
   }
   log({inspection:'referenced sandbox',sandbox_id:id,state,sessions,proof_limit:'session metadata only; synchronous commands, detached processes and inflight SDK uploads not proven quiesced'});
  }catch(e){log({inspection:'referenced sandbox',sandbox_id:id,error_type:e.statusCode||e.response?.status||e.code||'READ_FAILED'});}
 }
 const workers=[];for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p)))try{
  const argv=readFileSync('/proc/'+pid+'/cmdline').toString().split('\0').filter(Boolean);
  if(argv[0]&&/node$/.test(argv[0])&&argv.slice(1).some(a=>/(^|\/)src\/index\.js$/.test(a)))workers.push({pid:Number(pid),cwd:readlinkSync('/proc/'+pid+'/cwd')});
 }catch{}
 log({inspection:'WSL Worker processes',workers,proof_limit:'does not cover Render/other hosts/Windows services'});
 log({inspection:'primary DB/management credential availability',variables_present:['MAIN_DATABASE_URL','DATABASE_URL','SUPABASE_DB_URL','SUPABASE_DATABASE_URL','SUPABASE_ACCESS_TOKEN'].filter(n=>!!env[n])});
 try{const remote=execFileSync('git',['ls-remote','origin','refs/heads/main'],{cwd:root,env:{...process.env,GIT_TERMINAL_PROMPT:'0'},timeout:15000,stdio:['ignore','pipe','pipe']}).toString().trim().split(/\s+/)[0];log({inspection:'remote main',sha:remote});}
 catch{log({inspection:'remote main',error_type:'REMOTE_READ_UNAVAILABLE'});}
}catch(e){log({inspection:'main readonly preflight',error_type:e.code||'INSPECTION_FAILED'});process.exitCode=1;}
