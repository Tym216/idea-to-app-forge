import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import { sourceManifest } from '../../worker/src/managed-source.js';
import {assertForgeTablePrivileges} from './forge-table-privileges.mjs';
const db = new PGlite();
process.on('uncaughtException', (e) => { console.error(e.message, e.where || '', e.stack?.split('\n').slice(-2).join('\n')); process.exit(1); });
await db.exec(`create schema auth; create table auth.users(id uuid primary key,email text);
create function auth.uid() returns uuid language sql stable as $$ select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid $$;
create role anon nologin; create role authenticated nologin; create role service_role nologin bypassrls;
grant usage on schema auth to anon,authenticated,service_role; grant select on auth.users to anon,authenticated,service_role;
grant execute on function auth.uid() to anon,authenticated,service_role;`);
const userId = randomUUID(), other = randomUUID(), exec = randomUUID();
await db.query('insert into auth.users values($1,$2),($3,$4)',[userId,'a@x',other,'b@x']);
for (const name of ['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0005_preview_recovery.sql']) await db.exec(readFileSync(new URL(`../migrations/${name}`,import.meta.url),'utf8'));
const [{id: project}] = (await db.query('insert into public.ita_projects(user_id,name) values($1,$2) returning id',[userId,'fixture'])).rows;
const [{id: task}] = (await db.query("insert into public.ita_tasks(project_id,user_id,mode,prompt,status,worker_id,execution_id,lease_until) values($1,$2,'build','test','running','w',$3,now()+interval '1 hour') returning id",[project,userId,exec])).rows;
await db.exec('set role service_role');
await db.query("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[exec,task]);
await db.exec('reset role');
const [{id: plan}] = (await db.query("insert into public.ita_plans(project_id,user_id,version,kind,status,content) values($1,$2,1,'action','approved','{}') returning id",[project,userId])).rows;
await db.exec('set role service_role');
await db.query('update public.ita_tasks set plan_id=$1,plan_version=1 where id=$2',[plan,task]);
await db.exec('reset role');
const [{id: legacyP}] = (await db.query('insert into public.ita_projects(user_id,name) values($1,$2) returning id',[userId,'legacy'])).rows;
const legacyIntents=[
 {tool:'change_journal',event:'intent',operation_id:'old-a',path:'a.ts',content:'A',sandbox_id:'old-sandbox',before_database_hash:null,before_sandbox_hash:null,intended_hash:sourceManifest([{path:'a.ts',content:'A'}]).files[0].hash},
 {tool:'change_journal',event:'intent',operation_id:'old-b',path:'b.ts',content:'B',sandbox_id:'old-sandbox',before_database_hash:null,before_sandbox_hash:null,intended_hash:sourceManifest([{path:'b.ts',content:'B'}]).files[0].hash},
];
const legacyExec=randomUUID();
const [{id:legacyTask}]=(await db.query("insert into public.ita_tasks(project_id,user_id,prompt) values($1,$2,'legacy') returning id",[legacyP,userId])).rows;
await db.exec('set role service_role');
await db.query("update public.ita_tasks set steps=$1,status='running',worker_id='w',execution_id=$2,lease_until=now()+interval '1 hour' where id=$3",[JSON.stringify(legacyIntents),legacyExec,legacyTask]);
await db.exec('reset role');
await db.exec(readFileSync(new URL('../migrations/0006_workspace_contract.sql',import.meta.url),'utf8'));
await assertForgeTablePrivileges(db);
async function as(role,uid,sql,args=[]) {
 await db.query('select set_config($1,$2,false)',['request.jwt.claims',uid?JSON.stringify({sub:uid}):'']); await db.exec(`set role ${role}`);
 try {return (await db.query(sql,args)).rows;} finally {await db.exec('reset role');}
}
const svc=(sql,args)=>as('service_role',null,sql,args);
const scope=[project,task,'w',exec];
async function call(name,extra=[],types=[]) {const ts=['uuid','uuid','text','uuid',...types]; const [r]=await svc(`select to_jsonb(public.${name}(${ts.map((t,i)=>`$${i+1}::${t}`).join(',')})) r`,[...scope,...extra]); return r.r;}
const read=()=>call('ita_workspace_read');
const hash=(files)=>sourceManifest(files).code_hash;
const empty=hash([]);
let w=await call('ita_workspace_acquire',[randomUUID(),'materialize','sb',null],['uuid','text','text','uuid']);
await call('ita_workspace_finish_operation',[w.token,empty],['uuid','text']);
assert.equal((await read()).state,'confirmed');
for(const files of [[],[{path:'src/你好.ts',content:'中\r\n"\\'}],[{path:'a',content:''},{path:'𐀀',content:'X'},{path:'\ue000',content:'Y'}]]) {
 const [{h}]=(await db.query('select public.ita_manifest_hash($1) h',[JSON.stringify(files)])).rows; assert.equal(h,hash(files));
}
await assert.rejects(svc('insert into public.ita_files(project_id,user_id,path,content) values($1,$2,$3,$4)',[project,userId,'x','bad']),/permission/);
await assert.rejects(as('authenticated',userId,'select public.ita_workspace_read($1,$2,$3,$4)',scope),/permission/);
assert.equal((await as('authenticated',other,'select * from public.ita_changesets')).length,0);
// Authority must be protected by privileges, including service_role BYPASSRLS.
const authority={workspace_revision:'99',workspace_state:"'confirmed'",workspace_hash:"'"+'d'.repeat(64)+"'",workspace_writer:"'{}'::jsonb",workspace_epoch:'99',workspace_build:"'{}'::jsonb",workspace_verify:"'{}'::jsonb",checkpoint_id:'null'};
for(const role of ['service_role','authenticated','anon']) for(const [col,value] of Object.entries(authority)) {
 await assert.rejects(as(role,userId,`update public.ita_projects set ${col}=${value} where id=$1`,[project]),/permission/);
}
await assert.rejects(svc('insert into public.ita_projects(user_id,name,workspace_revision) values($1,$2,99)',[userId,'bypass']),/permission/);
await svc('update public.ita_projects set name=$1 where id=$2',['allowed metadata',project]);
for(const sql of ["insert into public.ita_files(project_id,user_id,path,content) values($1,$2,'x','bad')", "update public.ita_files set content='bad' where project_id=$1 and user_id=$2", "delete from public.ita_files where project_id=$1 and user_id=$2"])
 await assert.rejects(as('authenticated',userId,sql,[project,userId]),/permission/);
const target=[{path:'src/a.ts',content:'A'},{path:'package-lock.json',content:'{}'}];
const changes=target.map((f)=>({...f,operation:'write'}));
let c=await call('ita_workspace_prepare',['one','agent',0,JSON.stringify(changes),hash(target)],['text','text','bigint','jsonb','text']);
assert.equal((await call('ita_workspace_prepare',['one','agent',0,JSON.stringify(changes),hash(target)],['text','text','bigint','jsonb','text'])).id,c.id);
await assert.rejects(call('ita_workspace_prepare',['one','agent',0,'[]',empty],['text','text','bigint','jsonb','text']),/IDEMPOTENCY/);
w=await call('ita_workspace_acquire',[randomUUID(),'mutation','sb',c.id],['uuid','text','text','uuid']);
const epoch=w.epoch;
await assert.rejects(call('ita_workspace_acquire',[randomUUID(),'mutation','sb',c.id],['uuid','text','text','uuid']),/RECONCILE/);
await call('ita_workspace_result',[w.token,'partial','{}'],['uuid','text','jsonb']);
assert.equal((await read()).state,'partial');
await assert.rejects(call('ita_workspace_reconcile',[w.token,false,hash(target),JSON.stringify(target)],['uuid','boolean','text','jsonb']),/RECONCILE/);
// A new execution still cannot acquire a normal writer; old provenance does not invalidate evidence.
const nextExec=randomUUID(); await db.query('update public.ita_tasks set execution_id=$1 where id=$2',[nextExec,task]); scope[3]=nextExec;
await assert.rejects(call('ita_workspace_acquire',[randomUUID(),'mutation','sb',c.id],['uuid','text','text','uuid']),/RECONCILE/);
// Hash-only claims and third content cannot mint a continuation token.
await assert.rejects(call('ita_workspace_reconcile',[w.token,true,hash(target),'[]'],['uuid','boolean','text','jsonb']),/MANIFEST_CONFLICT/);
const third=[{path:'src/a.ts',content:'unrecorded'},{path:'package-lock.json',content:'{}'}];
await assert.rejects(call('ita_workspace_reconcile',[w.token,true,hash(third),JSON.stringify(third)],['uuid','boolean','text','jsonb']),/MANIFEST_CONFLICT/);
assert.equal((await read()).writer.token,w.token);
const recovered=await call('ita_workspace_reconcile',[w.token,true,hash(target),JSON.stringify(target)],['uuid','boolean','text','jsonb']);
assert.ok(recovered.writer.epoch>epoch);
await assert.rejects(call('ita_workspace_commit',[w.token,c.id,JSON.stringify(target),hash(target)],['uuid','uuid','jsonb','text']),/FENCE/);
w=recovered.writer;
await call('ita_workspace_commit',[w.token,c.id,JSON.stringify(target),hash(target)],['uuid','uuid','jsonb','text']);
assert.equal((await read()).revision,1);
await call('ita_workspace_commit',[w.token,c.id,JSON.stringify(target),hash(target)],['uuid','uuid','jsonb','text']); assert.equal((await read()).revision,1);
await assert.rejects(call('ita_workspace_prepare',['stale','agent',0,'[]',hash(target)],['text','text','bigint','jsonb','text']),/REVISION_CONFLICT/); assert.equal((await read()).state,'confirmed');
const b='b'.repeat(64),v='c'.repeat(64);
async function evidence(kind,status,revision=1,basis=kind==='build'?b:v) {return call('ita_workspace_evidence',[kind,JSON.stringify({workspace_revision:revision,code_hash:hash(target),basis_fingerprint:basis,status,execution_id:exec})],['text','jsonb']);}
assert.equal(await evidence('build','passed',0),false);
assert.equal(await evidence('build','passed'),true);
assert.equal(await evidence('verify','blocker'),true);
const complete=()=>call('ita_complete_build_checkpoint',['finish',1,hash(target),b,v,plan,'summary','https://preview.test/'],['text','bigint','text','text','text','uuid','text','text']);
await assert.rejects(complete(),/VERIFY_STALE/);
await evidence('verify','tool_error'); await assert.rejects(complete(),/VERIFY_STALE/);
await evidence('verify','inconclusive');
// No-op preserves both revision and evidence, despite a new operation/execution.
c=await call('ita_workspace_prepare',['noop','agent',1,'[]',hash(target)],['text','text','bigint','jsonb','text']);
w=await call('ita_workspace_acquire',[randomUUID(),'mutation','sb',c.id],['uuid','text','text','uuid']);
await call('ita_workspace_commit',[w.token,c.id,JSON.stringify(target),hash(target)],['uuid','uuid','jsonb','text']);
assert.equal((await read()).revision,1); assert.equal((await read()).build.basis_fingerprint,b);
const done=await complete(); assert.equal(done.completed,true);
assert.equal((await complete()).snapshot_id,done.snapshot_id);
const completionArgs=['finish',1,hash(target),b,v,plan,'summary','https://preview.test/'];
for(const [index,value] of [[3,'e'.repeat(64)],[4,'e'.repeat(64)],[5,randomUUID()],[6,'different summary']]) {
 const altered=[...completionArgs];altered[index]=value;
 await assert.rejects(call('ita_complete_build_checkpoint',altered,['text','bigint','text','text','text','uuid','text','text']),/IDEMPOTENCY_CONFLICT/);
}
// A lost completion response may be retried after execution has ended; provenance/URL is not identity.
scope[3]=randomUUID();completionArgs[7]='https://preview.test/?token=refreshed';
assert.equal((await call('ita_complete_build_checkpoint',completionArgs,['text','bigint','text','text','text','uuid','text','text'])).snapshot_id,done.snapshot_id);
assert.equal((await svc('select count(*)::int n from public.ita_snapshots where project_id=$1',[project]))[0].n,1);
assert.equal((await svc('select count(*)::int n from public.ita_messages where project_id=$1',[project]))[0].n,1);
assert.equal((await svc('select phase from public.ita_tasks where id=$1',[task]))[0].phase,'done_with_warnings');
await assert.rejects(db.query("update public.ita_snapshots set files='[]' where id=$1",[done.snapshot_id]),/IMMUTABLE/);
for(const role of ['service_role','authenticated']) {
 await assert.rejects(as(role,userId,'delete from public.ita_snapshots where id=$1',[done.snapshot_id]),/permission/);
 await assert.rejects(as(role,userId,"update public.ita_snapshots set files='[]' where id=$1",[done.snapshot_id]),/permission/);
}
await assert.rejects(db.query('delete from public.ita_snapshots where id=$1',[done.snapshot_id]),/IMMUTABLE/);
const [{workspace_state,workspace_writer}]=await svc('select workspace_state,workspace_writer from public.ita_projects where id=$1',[legacyP]);
assert.equal(workspace_state,'uncertain'); assert.equal(workspace_writer.kind,'legacy');
const legacyScope=[legacyP,legacyTask,'w',legacyExec];
const legacyAcquire=()=>svc('select public.ita_workspace_acquire($1,$2,$3,$4,$5,$6,$7,null)',[...legacyScope,randomUUID(),'materialize','old-sandbox']);
await assert.rejects(legacyAcquire(),/RECONCILE/);
const legacyResolve=(files,quiesced=true)=>svc('select public.ita_workspace_reconcile_legacy($1,$2,$3,$4,$5,$6) r',[legacyP,workspace_writer.token,'old-sandbox',quiesced,JSON.stringify(files),hash(files)]);
await assert.rejects(legacyResolve([],false),/QUIESCENCE/);
await assert.rejects(as('authenticated',userId,'select public.ita_workspace_reconcile_legacy($1,$2,$3,true,$4,$5)',[legacyP,workspace_writer.token,'old-sandbox','[]',empty]),/permission/);
await assert.rejects(legacyResolve([{path:'a.ts',content:'A'},{path:'b.ts',content:'third'}]),/MANIFEST_CONFLICT/);
assert.equal((await svc("select count(*)::int n from public.ita_changesets where project_id=$1 and status='uncertain'",[legacyP]))[0].n,2);
await assert.rejects(legacyAcquire(),/RECONCILE/);
// Even an inconsistent parent state cannot hide a second blocking changeset.
await db.query("update public.ita_projects set workspace_state='confirmed',workspace_writer=null where id=$1",[legacyP]);
await assert.rejects(legacyAcquire(),/RECONCILE/);
await db.query("update public.ita_projects set workspace_state='uncertain',workspace_writer=$1 where id=$2",[JSON.stringify(workspace_writer),legacyP]);
const legacyResolved=(await legacyResolve([{path:'a.ts',content:'A'}]))[0].r;
assert.equal(legacyResolved.state,'confirmed');assert.equal(legacyResolved.revision,1);
assert.deepEqual(legacyResolved.outcomes.map(o=>o.status).sort(),['committed','not_applied']);
assert.equal((await legacyAcquire()).length,1); // successful normal admission only after all blockers resolved
await svc('delete from public.ita_projects where id=$1',[project]);
assert.equal((await svc('select count(*)::int n from public.ita_changesets where project_id=$1',[project]))[0].n,0);
// Service + real SQL + real Linux gateway. Build/preview/browser endpoints below are deliberate fakes.
const { Workspace } = await import('../../worker/src/workspace.js');
const fs = await import('node:fs/promises');
const os = await import('node:os');
const path = await import('node:path');
const { promisify } = await import('node:util');
const { execFile } = await import('node:child_process');
const execute = promisify(execFile);
const dir=await fs.mkdtemp(path.join(os.tmpdir(),'forge-workspace-bridge-'));
try {
 const [{id: p2}]=await svc('insert into public.ita_projects(user_id,name) values($1,$2) returning id',[userId,'service']);
 const e2=randomUUID();
 const [{id: t2}]=await svc("insert into public.ita_tasks(project_id,user_id,mode,prompt) values($1,$2,'build','test') returning id",[p2,userId]);
 await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[e2,t2]);
 const rpc=async(name,args)=>{
  const keys=Object.keys(args);
  const values=Object.values(args).map(v=>v&&typeof v==='object'?JSON.stringify(v):v);
  try {const [r]=await svc(`select to_jsonb(public.${name}(${keys.map((k,i)=>`${k}=>$${i+1}`).join(',')})) r`,values);return {data:r.r,error:null};}
  catch(e) {return {data:null,error:{message:e.message}};}
 };
 const sb={
  resolve:async()=>({workdir:dir}),
  writeFile:async(_id,p,c)=>{const full=path.isAbsolute(p)?p:path.join(dir,p);await fs.mkdir(path.dirname(full),{recursive:true});await fs.writeFile(full,c);},
  readFile:async(_id,p)=>fs.readFile(path.join(dir,p),'utf8'),
  listFiles:async()=> (await ws.gateway.scan()).files.map(f=>f.path),
  exec:async(_id,cmd)=>{
   if(cmd.startsWith('npm install')||cmd.startsWith('npm ci')) {try {await fs.access(path.join(dir,'package-lock.json'));} catch {await fs.writeFile(path.join(dir,'package-lock.json'),'{}');}return {exitCode:0,stdout:'',stderr:''};}
   if(cmd==='npm run --ignore-scripts build'||cmd.startsWith('pkill')) return {exitCode:0,stdout:'',stderr:''};
   try {const r=await execute('bash',['-lc',cmd],{cwd:dir,maxBuffer:32*1024*1024});return {exitCode:0,stdout:r.stdout,stderr:r.stderr};}
   catch(e){return {exitCode:e.code??1,stdout:e.stdout||'',stderr:e.stderr||''};}
  },
  startBackground:async()=>({commandId:'fixture'}),isPortListening:async()=>true,
  readLogs:async()=>'',previewUrl:async()=> 'https://fixture.test/',
 };
 const args={rpc,projectId:p2,taskId:t2,workerId:'w',executionId:e2,sandbox:sb,sandboxId:'fixture'};
 let ws=new Workspace(args);await ws.initialize({newSandbox:true});
 let r=await ws.apply([{operation:'write',path:'a.ts',content:'A'},{operation:'write',path:'b.ts',content:'B'}]);
 assert.equal(r.revision,1);
 r=await ws.apply([{operation:'write',path:'a.ts',content:'A'}]);assert.equal(r.revision,1);assert.equal(r.changed,false);
 r=await ws.apply([{operation:'delete',path:'b.ts'}]);assert.equal(r.revision,2);
 await ws.runtime('install',()=>sb.exec('fixture','npm install'),{adoptLockfile:true}); assert.equal(ws.state.revision,3);
 assert.ok(ws.manifest.files.some(f=>f.path==='package-lock.json'));
 // Partial real side effect, then a new execution reconciles only the original request.
 const originalRun=ws.gateway.run.bind(ws.gateway);let inject=true;
 ws.gateway.run=async(mode,w,values,n)=>originalRun(mode,w,mode==='promote'&&inject?(inject=false,{...values,testFailAfter:1}):values,n);
 await assert.rejects(ws.apply([{operation:'write',path:'a.ts',content:'AA'},{operation:'write',path:'c.ts',content:'C'}]),/TEST_PARTIAL/);
 await ws.read();assert.ok(ws.state.writer);
 const e3=randomUUID();await svc('update public.ita_tasks set execution_id=$1 where id=$2',[e3,t2]);
 ws=new Workspace({...args,executionId:e3});await ws.read();await ws.reconcile();assert.equal(ws.state.revision,4);
 assert.equal(await fs.readFile(path.join(dir,'a.ts'),'utf8'),'AA');
 await ws.initialize();assert.equal(ws.state.revision,4);
 // Crash after durable install_drift prepare, before commit; new execution must not reinstall.
 let preparedInstall;
 ws.commit=async(writer,change)=>{preparedInstall=change;throw new Error('TEST_CRASH_BEFORE_INSTALL_COMMIT');};
 await assert.rejects(ws.runtime('install',async()=>{await fs.writeFile(path.join(dir,'package-lock.json'),'{"lockfileVersion":3}');return {exitCode:0};},{adoptLockfile:true}),/TEST_CRASH/);
 await ws.read();assert.equal(ws.state.writer.changeset_id,preparedInstall.id);assert.equal(ws.state.writer.runtime_completed,true);
 assert.equal(ws.state.revision,4);
 const e4=randomUUID();await svc('update public.ita_tasks set execution_id=$1 where id=$2',[e4,t2]);
 ws=new Workspace({...args,executionId:e4});await ws.read();await ws.reconcile();
 assert.equal(ws.state.revision,5);assert.equal(ws.manifest.files.find(f=>f.path==='package-lock.json').content,'{"lockfileVersion":3}');
 assert.equal((await svc('select status from public.ita_changesets where id=$1',[preparedInstall.id]))[0].status,'committed');
 // Third hash stays fenced in the service too: no reconcile RPC and no subsequent promote.
 const stoppedRpc=ws.rpc;let reconcileCalls=0;ws.rpc=async(name,params)=>{if(name==='ita_workspace_reconcile')reconcileCalls++;return stoppedRpc(name,params);};
 const savedRun=ws.gateway.run.bind(ws.gateway);let failNext=true;
 ws.gateway.run=async(mode,w,values,n)=>savedRun(mode,w,mode==='promote'&&failNext?(failNext=false,{...values,testFailAfter:1}):values,n);
 await assert.rejects(ws.apply([{operation:'write',path:'a.ts',content:'AAA'},{operation:'write',path:'c.ts',content:'CC'}]),/TEST_PARTIAL/);
 await fs.writeFile(path.join(dir,'a.ts'),'third');await ws.read();
 await assert.rejects(ws.reconcile(),/冲突/);assert.equal(reconcileCalls,0);
 // Restore only the known intended value in this fixture, then safely reconcile the original request.
 await fs.writeFile(path.join(dir,'a.ts'),'AAA');await ws.reconcile();assert.equal(ws.state.revision,6);
 await ws.apply([{operation:'write',path:'package.json',content:'{"scripts":{"build":"vite build","dev":"vite"},"dependencies":{}}'}]);
 process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';
 const {runBuild,buildRuntimeBasis}=await import('../../worker/src/agent.js');
 const {buildFingerprint,verifyFingerprint}=await import('../../worker/src/managed-source.js');
 const acceptance=[{id:'A1',action:'查看内容',expect:'A',external:false,severity:'core',steps:[{op:'expectText',selector:'main',contains:'A'}]}];
 const buildBasis=buildFingerprint(await buildRuntimeBasis(sb,'fixture')), verifyBasis=verifyFingerprint(acceptance);
 const task2={id:t2,project_id:p2,user_id:userId,execution_id:e4,tool_steps:0,fix_rounds:0,steps:[]};
 const actions=[{tool:'build',args:{}},{tool:'start_dev',args:{}},{tool:'verify',args:{}},{tool:'finish',args:{summary:'fixture'}}];let at=0;
 const deps={chat:async()=>JSON.stringify(actions[at++]),checkLease:async()=>{},appendStep:async(t,s)=>t.steps.push(s),updateTask:async()=>{},updateProject:async()=>{},
  verifyApp:async()=>({base:{blocking:[],warnings:[]},checks:[{id:'A1',status:'pass'}],screenshots:[]})};
 const result=await runBuild(task2,{},sb,'fixture','fixture',deps,'',acceptance,{workspace:ws,buildBasis,verifyBasis});
 assert.equal(result.verificationKind,'passed');assert.equal(ws.state.build.status,'passed');assert.equal(ws.state.verify.status,'passed');
 // Resume with no source/basis change performs no new build/verify. Starting runtime retains conclusion.
 let expensive=0;const origExec=sb.exec;sb.exec=async(id,cmd)=>{if(cmd==='npm run --ignore-scripts build')expensive++;return origExec(id,cmd);};
 at=0;deps.verifyApp=async()=>{throw new Error('must not re-verify');};
 const resume=await runBuild({...task2,tool_steps:0}, {},sb,'fixture','resume',deps,'',acceptance,{workspace:ws,buildBasis,verifyBasis});
 assert.equal(resume.verificationKind,'passed');assert.equal(expensive,0);
 await assert.rejects(ws.runtime('build',async()=>{await fs.writeFile(path.join(dir,'a.ts'),'unexpected');return {exitCode:0};}),/未声明源码/);
 await ws.read();assert.equal(ws.state.state,'conflict');
 await assert.rejects(ws.apply([{operation:'write',path:'a.ts',content:'overwrite'}]),/REVISION_CONFLICT|BUSY|RECONCILE/);
 assert.equal(await fs.readFile(path.join(dir,'a.ts'),'utf8'),'unexpected');
 console.log('PASS service bridge: real SQL/gateway mutations, no-op, delete, lockfile revision, install prepare/crash/new-execution recovery, third-hash service fence, partial takeover, materialization, Agent wiring and cross-execution evidence reuse; build/browser endpoints simulated');
} finally {
 const {sha256}=await import('../../worker/src/managed-source.js');
 await fs.rm(path.join(path.dirname(dir),'.forge-workspace-'+sha256(dir).slice(0,24)),{recursive:true,force:true});
 await fs.rm(dir,{recursive:true,force:true});
}

await db.close();
console.log('PASS workspace SQL: canonical hash, source privilege cutover, RLS, lease/epoch, partial recovery, no-op, stale conflict, evidence reuse, blocker/tool-error, immutable idempotent checkpoint, legacy multi-intent committed/not_applied exit, authority ACLs, third-hash rejection, completion identity, DELETE immutability, cascade (single-connection PGlite; not concurrency proof)');
