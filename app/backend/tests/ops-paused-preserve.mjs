/** Authorized full read-only source preservation. No managed write, no task resume, no writer. */
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';import {verifyFrozen} from './ops-ingress-gate.mjs';
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';import path from 'node:path';import {parseEnv} from 'node:util';import {createRequire} from 'node:module';
import {sourceManifest,sourceDiff,sha256} from '../../worker/src/managed-source.js';
const dir=path.join(operationalRoot,'app/worker/.cutover/stage-b-2026-10-08'),sid='9394813e-2d8d-4ccf-8642-5c9e95e0f570',pid='93a2f63a-9ec6-4194-b962-4e68dbeea80d';let db,sb,result,failure;
const env=parseEnv(readFileSync(path.join(operationalRoot,'app/worker/.env'),'utf8')),req=createRequire(path.join(operationalRoot,'app/worker/package.json')),{Daytona}=req('@daytona/sdk');
const daytona=new Daytona({apiKey:env.DAYTONA_API_KEY,apiUrl:env.DAYTONA_API_URL||'https://app.daytona.io/api',target:env.DAYTONA_TARGET||'us'});
const allowed=p=>p.comm==='daytona'&&p.args==='/usr/local/bin/daytona sleep infinity'||p.comm==='zsh'&&p.args==='/usr/bin/zsh'||p.comm==='python3'&&p.args==='python3 /tmp/daytona_repl_worker.py'||p.comm==='tail'&&p.args==='tail -f /dev/null'||p.comm==='sleep'&&p.args==='sleep infinity'||p.comm==='daytona-compute'&&p.args==='/usr/local/lib/daytona-computer-use'||p.comm==='dbus-daemon'&&p.args==='/usr/bin/dbus-daemon --syslog --fork --print-pid 4 --print-address 6 --session'||p.comm==='ps'&&p.args==='ps -eo pid,ppid,comm,args --no-headers';
async function runtimeCheck(){const sessions=await sb.process.listSessions();if(sessions.length)throw new Error('UNEXPECTED_SESSION');const ps=await sb.process.executeCommand('ps -eo pid,ppid,comm,args --no-headers',undefined,undefined,30);if(ps.exitCode!==0)throw new Error('PROCESS_INSPECTION_FAILED');const processes=ps.result.trim().split('\n').map(l=>{const m=/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(l);if(!m)throw new Error('PROCESS_INSPECTION_PARSE');return{pid:Number(m[1]),ppid:Number(m[2]),comm:m[3],args:m[4]};});writeFileSync(path.join(dir,'paused-pre-read-processes.private.json'),JSON.stringify(processes,null,2),{mode:0o600,flag:'wx'});if(processes.some(p=>!allowed(p)))throw new Error('UNEXPECTED_PROCESS');return {sessions:0,process_count:processes.length,unexpected:0,classification:'explicit daemon/code-interpreter/computer-use/IPC/idle shell and own ps commands; no application runtime',provider_reference:'https://www.daytona.io/docs/en/architecture/'};}
try{
 if(JSON.parse(readFileSync(path.join(dir,'lifecycle-quiescence-proof.json'),'utf8')).status!=='PASS')throw new Error('LIFECYCLE_PROOF_REQUIRED');
 const c=await operationalConnect('main');db=c.db;await verifyFrozen(db);
 const task=(await db.query('select id,status,execution_id,worker_id,lease_until from public.ita_tasks where id=$1',['e0d9c783-7de6-4a02-a219-50a24b7e55c5'])).rows[0];if(task?.status!=='paused'||task.execution_id||task.worker_id||task.lease_until)throw new Error('TASK_CHANGED');
 const dbRows=(await db.query('select path,content from public.ita_files where project_id=$1 and not deleted order by path',[pid])).rows,dbManifest=sourceManifest(dbRows);
 await db.query('ROLLBACK');await db.end();db=null;
 sb=await daytona.get(sid);await sb.refreshData();if(sb.state!=='started')throw new Error('EXPECTED_CONTROLLED_STARTED_SANDBOX');
 const runtime=await runtimeCheck();
 const module=readFileSync(path.join(operationalRoot,'app/worker/src/managed-source.js'),'utf8');
 const scanner=module+String.raw`
 import fs from 'node:fs/promises';import {TextDecoder} from 'node:util';
 const root='/home/daytona/app';const rows=[],resources=[];let total=0;
 if((await fs.lstat(root)).isSymbolicLink())throw new Error('SOURCE_ROOT_SYMLINK');
 async function walk(relative=''){for(const ent of await fs.readdir(path.join(root,relative),{withFileTypes:true})){const p=relative?relative+'/'+ent.name:ent.name;if(!isManagedPath(p))continue;
  if(ent.isSymbolicLink())throw new Error('SOURCE_SYMLINK: '+p);if(ent.isDirectory()){await walk(p);continue;}if(!ent.isFile())throw new Error('SOURCE_TYPE: '+p);
  const data=await fs.readFile(path.join(root,p));total+=data.length;if(data.length>SOURCE_LIMITS.fileBytes||total>SOURCE_LIMITS.bytes||rows.length+resources.length>=SOURCE_LIMITS.files)throw new Error('SOURCE_LIMIT');
  try{const content=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(data);if(content.includes('\0'))throw new Error('BINARY');rows.push({path:p,content});}
  catch{resources.push({path:p,hash:sha256(data),bytes:data.length,base64:data.toString('base64')});}
 }}
 await walk();console.log('__FORGE_PRESERVE__'+JSON.stringify({complete:true,manifest:sourceManifest(rows),resources,total_bytes:total}));`;
 const encoded=Buffer.from(scanner).toString('base64');
 const command=`node --input-type=module -e 'await import("data:text/javascript;base64,${encoded}")'`;
 const scan=await sb.process.executeCommand(command,undefined,undefined,60);writeFileSync(path.join(dir,'paused-source-scan.private.txt'),scan.result||'',{mode:0o600,flag:'wx'});
 if(scan.exitCode!==0)throw new Error('FULL_SOURCE_SCAN_FAILED');
 const marker='__FORGE_PRESERVE__',at=scan.result.indexOf(marker);if(at<0)throw new Error('SOURCE_SCAN_NO_OUTPUT');
 const physical=JSON.parse(scan.result.slice(at+marker.length).trim());if(!physical.complete||!physical.manifest.complete)throw new Error('SOURCE_SCAN_INCOMPLETE');
 const verified=sourceManifest(physical.manifest.files);if(verified.code_hash!==physical.manifest.code_hash)throw new Error('SOURCE_SCAN_HASH_MISMATCH');
 for(const r of physical.resources)if(sha256(Buffer.from(r.base64,'base64'))!==r.hash)throw new Error('RESOURCE_HASH_MISMATCH');
 const sourceDir=path.join(dir,'paused-source');mkdirSync(sourceDir,{mode:0o700});
 writeFileSync(path.join(sourceDir,'physical-manifest.json'),JSON.stringify(physical,null,2),{mode:0o600,flag:'wx'});writeFileSync(path.join(sourceDir,'db-manifest.json'),JSON.stringify(dbManifest,null,2),{mode:0o600,flag:'wx'});
 const changes=sourceDiff(dbManifest,verified).map(({content,...d})=>d);
 result={status:changes.length||physical.resources.length?'DISCREPANCY':'PASS',preserved_at:new Date().toISOString(),main_ref:c.config.ref,task_id:task.id,project_id:pid,sandbox_id:sid,runtime_check:runtime,db_files:dbManifest.files.length,db_hash:dbManifest.code_hash,physical_files:verified.files.length,physical_hash:verified.code_hash,total_bytes:physical.total_bytes,changes,extra_binary_resources:physical.resources.map(({base64,...r})=>r),complete_content_preserved:true,db_overwritten:false,new_revision_created:false,task_resumed:false,new_writer:false,managed_source_modified:false};
}catch(e){failure=e;result={status:'FAIL',error_type:e.code||e.message||'SOURCE_PRESERVATION_FAILED',sandbox_id:sid,db_overwritten:false,task_resumed:false,new_writer:false};}
finally{
 if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}
 try{sb??=await daytona.get(sid);await sb.refreshData();if(sb.state==='started')await sb.stop(120);await sb.refreshData();if(sb.state==='stopped')await sb.archive();
  const end=Date.now()+180000;while(sb.state==='archiving'&&Date.now()<end){await new Promise(r=>setTimeout(r,2000));await sb.refreshData();}
  result.final_state=sb.state;result.lifecycle_cleanup=sb.state==='archived'?'PASS':'FAIL';if(sb.state!=='archived')failure??=new Error('SANDBOX_ARCHIVE_INCOMPLETE');
 }catch(e){result.lifecycle_cleanup='FAIL';result.cleanup_error_type=e.code||'LIFECYCLE_CLEANUP_FAILED';failure??=e;}
 writeFileSync(path.join(dir,'paused-preservation-result.json'),JSON.stringify(result,null,2),{flag:'wx',mode:0o600});console.log(JSON.stringify(result));
 if(failure||result.status!=='PASS'||result.lifecycle_cleanup!=='PASS')process.exitCode=1;
}
