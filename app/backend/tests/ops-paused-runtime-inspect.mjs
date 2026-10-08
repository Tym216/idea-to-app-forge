/** Authorized paused sandbox start + runtime inspection only. Does not read/modify managed source. */
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';import {verifyFrozen} from './ops-ingress-gate.mjs';
import {readFileSync,writeFileSync,readdirSync} from 'node:fs';import path from 'node:path';import {parseEnv} from 'node:util';import {createRequire} from 'node:module';
const dir=path.join(operationalRoot,'app/worker/.cutover/stage-b-2026-10-08'),sandboxId='9394813e-2d8d-4ccf-8642-5c9e95e0f570',taskId='e0d9c783-7de6-4a02-a219-50a24b7e55c5';let db;
try{
 const proof=JSON.parse(readFileSync(path.join(dir,'lifecycle-quiescence-proof.json'),'utf8'));if(proof.status!=='PASS'||proof.main_ref!=='vfzyimhapttcdxeabvur')throw new Error('QUIESCENCE_PROOF_REQUIRED');
 const c=await operationalConnect('main');db=c.db;await verifyFrozen(db);
 const task=(await db.query('select t.status,t.execution_id,t.worker_id,t.lease_until,p.sandbox_id from public.ita_tasks t join public.ita_projects p on p.id=t.project_id where t.id=$1',[taskId])).rows[0];
 if(task?.status!=='paused'||task.execution_id||task.worker_id||task.lease_until||task.sandbox_id!==sandboxId)throw new Error('PAUSED_TASK_STATE_CHANGED');
 if((await db.query("select count(*)::int n from public.ita_tasks where status in ('queued','running') or lease_until>now()")).rows[0].n)throw new Error('ACTIVE_PRODUCER');
 for(const pid of readdirSync('/proc').filter(p=>/^\d+$/.test(p)))try{const a=readFileSync('/proc/'+pid+'/cmdline').toString().split('\0');if(a[0]&&/node$/.test(a[0])&&a.slice(1).some(s=>/(^|\/)src\/index\.js$/.test(s)))throw Object.assign(new Error(),{code:'WORKER_PROCESS_PRESENT'});}catch(e){if(e.code==='WORKER_PROCESS_PRESENT')throw e;}
 await db.query('ROLLBACK');await db.end();db=null;
 const env=parseEnv(readFileSync(path.join(operationalRoot,'app/worker/.env'),'utf8')),req=createRequire(path.join(operationalRoot,'app/worker/package.json')),{Daytona}=req('@daytona/sdk');
 const daytona=new Daytona({apiKey:env.DAYTONA_API_KEY,apiUrl:env.DAYTONA_API_URL||'https://app.daytona.io/api',target:env.DAYTONA_TARGET||'us'}),sb=await daytona.get(sandboxId);await sb.refreshData();
 if(sb.state!=='archived'||sb.sandboxClass!=='container'||sb.autoDeleteInterval===0)throw new Error('PAUSED_SANDBOX_LIFECYCLE_GUARD');
 const before={state:sb.state,sandbox_class:sb.sandboxClass,auto_delete_interval:sb.autoDeleteInterval??null,auto_stop_interval:sb.autoStopInterval??null};
 console.log(JSON.stringify({step:'paused sandbox controlled start',sandbox_id:sandboxId,before,managed_source_read:false}));
 await sb.start(180);await sb.refreshData();if(sb.state!=='started')throw new Error('PAUSED_SANDBOX_NOT_STARTED');
 const sessions=await sb.process.listSessions();
 const ps=await sb.process.executeCommand('ps -eo pid,ppid,comm,args --no-headers',undefined,undefined,30);
 if(ps.exitCode!==0)throw new Error('PROCESS_INSPECTION_FAILED');
 writeFileSync(path.join(dir,'paused-process-list.private.txt'),ps.result,{flag:'wx',mode:0o600});
 const redact=s=>{for(const v of [env.DAYTONA_API_KEY])if(v)s=s.replaceAll(v,'[REDACTED]');return s.replace(/(?:postgres(?:ql)?:\/\/|https?:\/\/)\S+/g,'[URL]').replace(/(?:eyJ|dtn_|sb_secret_)\S+/g,'[REDACTED]').replace(/(--?(?:api[-_]?key|token|secret|password|authorization)(?:=|\s+))\S+/gi,'$1[REDACTED]');};
 const processes=ps.result.trim().split('\n').map(l=>{const m=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);if(!m)throw new Error('PROCESS_INSPECTION_PARSE');return {pid:Number(m[1]),ppid:Number(m[2]),comm:m[3],args:redact(m[4]).slice(0,220)};});
 const result={status:'INSPECTED_PENDING_PROCESS_REVIEW',checked_at:new Date().toISOString(),sandbox_id:sandboxId,original_state:before.state,current_state:sb.state,sessions:sessions.map(s=>({id:s.sessionId||s.id,commands:(s.commands||[]).map(c=>({id:c.id||c.commandId,exit_code:c.exitCode??null}))})),processes,managed_source_read:false,source_mutation:false,task_resumed:false,new_writer:false};
 writeFileSync(path.join(dir,'paused-runtime-inspection.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||e.message||'PAUSED_RUNTIME_INSPECTION_FAILED',requires_lifecycle_cleanup:true}));process.exitCode=1;}
finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}}
