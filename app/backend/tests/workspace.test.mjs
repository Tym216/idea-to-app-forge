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
const [{id: plan}] = (await db.query(`insert into public.ita_plans(project_id,user_id,version,kind,status,content) values($1,$2,1,'action','approved','{"acceptance":[{"id":"A1","action":"查看","expect":"内容","external":false,"steps":[{"op":"expectText","selector":"main","contains":"A"}]}]}') returning id`,[project,userId])).rows;
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
for (const name of ['0007_app_versions.sql','0008_user_apply.sql','0009_preview_basis.sql']) await db.exec(readFileSync(new URL('../migrations/'+name,import.meta.url),'utf8'));
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
const legacyBefore=(await db.query("insert into public.ita_snapshots(project_id,user_id,files,label) values($1,$2,'[]','legacy') returning id",[project,userId])).rows[0].id;
const immutableLegacyBefore=(await db.query('select to_jsonb(s) s from public.ita_snapshots s where id=$1',[legacyBefore])).rows[0].s;
await db.query('update public.ita_projects set checkpoint_id=$1 where id=$2',[legacyBefore,project]);
const done=await complete();
assert.equal((await db.query('select parent_checkpoint_id from public.ita_snapshots where id=$1',[done.snapshot_id])).rows[0].parent_checkpoint_id,legacyBefore);
assert.deepEqual((await db.query('select to_jsonb(s) s from public.ita_snapshots s where id=$1',[legacyBefore])).rows[0].s,immutableLegacyBefore);
 assert.equal(done.completed,true);
assert.equal((await complete()).snapshot_id,done.snapshot_id);
const completionArgs=['finish',1,hash(target),b,v,plan,'summary','https://preview.test/'];
for(const [index,value] of [[3,'e'.repeat(64)],[4,'e'.repeat(64)],[5,randomUUID()],[6,'different summary']]) {
 const altered=[...completionArgs];altered[index]=value;
 await assert.rejects(call('ita_complete_build_checkpoint',altered,['text','bigint','text','text','text','uuid','text','text']),/IDEMPOTENCY_CONFLICT/);
}
// A lost completion response may be retried after execution has ended; provenance/URL is not identity.
scope[3]=randomUUID();completionArgs[7]='https://preview.test/?token=refreshed';
assert.equal((await call('ita_complete_build_checkpoint',completionArgs,['text','bigint','text','text','text','uuid','text','text'])).snapshot_id,done.snapshot_id);
assert.equal((await svc("select count(*)::int n from public.ita_snapshots where project_id=$1 and kind='checkpoint'",[project]))[0].n,1);
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

// Demo additions use real local SQL/RLS, not direct client source DML.
assert.equal(done.version_number,1);
const snapshotBefore=(await db.query('select to_jsonb(s) s from public.ita_snapshots s where id=$1',[done.snapshot_id])).rows[0].s;
for(const col of ['version_number','parent_checkpoint_id'])
 await assert.rejects(db.query('update public.ita_snapshots set '+col+'=null where id=$1',[done.snapshot_id]),/IMMUTABLE/);
assert.deepEqual((await db.query('select to_jsonb(s) s from public.ita_snapshots s where id=$1',[done.snapshot_id])).rows[0].s,snapshotBefore);
const submit=(id='edit-one',base=1,fs=[{path:'src/a.ts',content:'B'}],uid=userId)=>as('authenticated',uid,'select public.ita_submit_user_apply($1,$2,$3,$4) r',[project,id,base,JSON.stringify(fs)]).then(x=>x[0].r);
await assert.rejects(submit('foreign',1,undefined,other),/NOT_OWNED/);
await assert.rejects(as('anon',null,'select public.ita_submit_user_apply($1,$2,1,$3)',[project,'anon','[]']),/permission/);
await assert.rejects(submit('stale',0),/REVISION_CONFLICT/);
await assert.rejects(submit('new-file',1,[{path:'src/new.ts',content:'X'}]),/EXISTING_TEXT_ONLY/);
await assert.rejects(submit('hidden-fields',1,[{path:'src/a.ts',content:'B',result:'committed'}]),/INPUT/);
await db.query("update public.ita_projects set workspace_writer='{}' where id=$1",[project]);
await assert.rejects(submit('writer'),/RECONCILE/);
await db.query('update public.ita_projects set workspace_writer=null where id=$1',[project]);
const blockerId=randomUUID();
await db.query("insert into public.ita_changesets(id,project_id,user_id,request_id,actor,origin,status,changes) values($1,$2,$3,'block','agent','agent','uncertain','[]')",[blockerId,project,userId]);
await assert.rejects(submit('unresolved'),/RECONCILE/);
await db.query('delete from public.ita_changesets where id=$1',[blockerId]);
const busyTask=(await svc("insert into public.ita_tasks(project_id,user_id,prompt) values($1,$2,'busy') returning id",[project,userId]))[0].id;
for(const status of ['queued','running','paused']) {
 await svc('update public.ita_tasks set status=$1 where id=$2',[status,busyTask]);
 await assert.rejects(submit('busy-'+status),/PROJECT_BUSY/);
}
await svc("update public.ita_tasks set status='cancelled' where id=$1",[busyTask]);
// Pure no-op must not allocate a task/ChangeSet/version or spend build/verify/model budget.
const noOpState=async()=>({
 source:(await db.query('select workspace_revision,workspace_hash,workspace_build,workspace_verify from public.ita_projects where id=$1',[project])).rows[0],
 counts:(await db.query('select (select count(*)::int from public.ita_tasks where project_id=$1) tasks,(select count(*)::int from public.ita_changesets where project_id=$1) changesets,(select count(*)::int from public.ita_snapshots where project_id=$1) snapshots',[project])).rows[0],
});
const beforeNoOp=await noOpState();
assert.deepEqual(await submit('same-content',1,[{path:'src/a.ts',content:'A'}]),{accepted:true,noop:true});
assert.deepEqual(await noOpState(),beforeNoOp);
console.log('PASS same-content User Apply: authoritative no-op, no task/ChangeSet/revision/version, no scheduled build/verify/LLM');
await db.query("update public.ita_projects set checkpoint_id=null where id=$1",[project]);
await assert.rejects(submit('no-basis'),/STABLE_BASIS/);
// No-op is only a source comparison: it does not require another publication basis.
assert.deepEqual(await submit('same-content-without-basis',1,[{path:'src/a.ts',content:'A'}]),{accepted:true,noop:true});
assert.deepEqual(await noOpState(),beforeNoOp);

await db.query("update public.ita_projects set checkpoint_id=$1 where id=$2",[done.snapshot_id,project]);

 // Preview ready is a receipt for the exact checked revision/hash, never just a URL.
 await svc('update public.ita_projects set sandbox_id=$1 where id=$2',['sb',project]);
 const previewQueued=(await as('authenticated',userId,'select to_jsonb(public.ita_request_preview_recovery($1)) j',[project]))[0].j;
 await assert.rejects(submit('preview-active'),/PROJECT_BUSY/);
 const previewJob=(await svc('select * from public.ita_claim_preview_recovery($1)',['w']))[0];
 await assert.rejects(svc('select public.ita_update_preview_recovery($1,$2,$3,$4,$5,null,$6,$7)',[project,'w',previewJob.execution_id,'ready','https://fixture.test/',0,hash(target)]),/SOURCE_NOT_CONFIRMED/);
 await svc('select public.ita_update_preview_recovery($1,$2,$3,$4,$5,null,$6,$7)',[project,'w',previewJob.execution_id,'ready','https://fixture.test/',1,hash(target)]);
 const readyRow=(await svc('select * from public.ita_preview_recoveries where project_id=$1',[project]))[0];
 assert.equal(readyRow.ready_revision,1);assert.equal(readyRow.ready_hash,hash(target));
 await db.query("update public.ita_preview_recoveries set ready_hash='old' where project_id=$1",[project]);
 assert.equal((await as('authenticated',userId,'select (public.ita_request_preview_recovery($1)).status s',[project]))[0].s,'queued');
 const previewAgain=(await svc('select * from public.ita_claim_preview_recovery($1)',['w']))[0];
 await svc('select public.ita_update_preview_recovery($1,$2,$3,$4,null,$5)',[project,'w',previewAgain.execution_id,'failed','fixture reset']);

const receipt=await submit();
assert.equal((await submit()).task_id,receipt.task_id);
await assert.rejects(submit('edit-one',1,[{path:'src/a.ts',content:'C'}]),/REQUEST_CONFLICT/);
const requested=(await svc('select * from public.ita_changesets where id=$1',[receipt.changeset_id]))[0];
const requestedTask=(await svc('select * from public.ita_tasks where id=$1',[receipt.task_id]))[0];
assert.equal(requested.actor,'user');assert.equal(requestedTask.operation,'user_apply');
assert.equal(requestedTask.plan_id,plan);
const frozenSubmission={checkpoint_id:done.snapshot_id,basis_id:plan,build_basis:b,verify_basis:v};
assert.deepEqual(requested.submission_basis,frozenSubmission);
assert.deepEqual(requested.result,{});
await assert.rejects(db.query("update public.ita_changesets set submission_basis=jsonb_set(submission_basis,'{basis_id}','null') where id=$1",[requested.id]),/SUBMISSION_IMMUTABLE/);

assert.equal((await db.query('select workspace_revision r from public.ita_projects where id=$1',[project])).rows[0].r,1); // Accepted is not Applied.
await assert.rejects(db.query("update public.ita_changesets set changes='[]' where id=$1",[requested.id]),/SUBMISSION_IMMUTABLE/);
await assert.rejects(as('authenticated',userId,"update public.ita_files set content='C' where project_id=$1",[project]),/permission/);
let applyExec=randomUUID();scope[1]=receipt.task_id;scope[3]=applyExec;
await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[applyExec,receipt.task_id]);
w=await call('ita_workspace_acquire',[randomUUID(),'mutation','sb',requested.id],['uuid','text','text','uuid']);
// All generic failure outcomes must persist without touching immutable submission inputs.
// A new execution reconciles this same request; no duplicate prepare or ChangeSet is allowed.
for(const state of ['partial','uncertain','conflict']) {
 const outcome={error:'fixture '+state,basis_id:'execution-outcome-only',status:state};
 await call('ita_workspace_result',[w.token,state,JSON.stringify(outcome)],['uuid','text','jsonb']);
 const failedChange=(await svc('select * from public.ita_changesets where id=$1',[requested.id]))[0];
 assert.equal(failedChange.status,state);assert.deepEqual(failedChange.result,outcome);
 assert.deepEqual(failedChange.submission_basis,frozenSubmission);
 assert.equal((await read()).state,state);
 await svc("update public.ita_tasks set status='failed' where id=$1",[receipt.task_id]);
 const resumed=(await as('authenticated',userId,'select to_jsonb(public.ita_retry_task($1,$2)) t',[receipt.task_id,'resume']))[0].t;
 assert.equal(resumed.requested_changeset_id,requested.id);
 applyExec=randomUUID();scope[3]=applyExec;
 await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[applyExec,receipt.task_id]);
 const retired=w.token;
 const reconcile=await call('ita_workspace_reconcile',[retired,true,hash(target),JSON.stringify(target)],['uuid','boolean','text','jsonb']);
 assert.equal(reconcile.state,'continue_recorded');assert.equal(reconcile.changeset.id,requested.id);
 assert.deepEqual(reconcile.changeset.submission_basis,frozenSubmission);
 w=reconcile.writer;
 assert.notEqual(w.token,retired);
 assert.equal((await svc("select count(*)::int n from public.ita_changesets where project_id=$1 and origin='user_apply'",[project]))[0].n,1);
}
console.log('PASS User Apply immutable basis: partial/uncertain/conflict persist; resume/reconcile preserves same request and basis, no second ChangeSet');

const edited=[{path:'src/a.ts',content:'B'},{path:'package-lock.json',content:'{}'}];
await call('ita_workspace_commit',[w.token,requested.id,JSON.stringify(edited),hash(edited)],['uuid','uuid','jsonb','text']);
assert.equal((await read()).revision,2);
assert.equal((await read()).build,null);assert.equal((await read()).verify,null);
await call('ita_workspace_commit',[w.token,requested.id,JSON.stringify(edited),hash(edited)],['uuid','uuid','jsonb','text']);assert.equal((await read()).revision,2);
for(const kind of ['build','verify']) await call('ita_workspace_evidence',[kind,JSON.stringify({workspace_revision:2,code_hash:hash(edited),basis_fingerprint:kind==='build'?b:v,status:'passed',result:{kind:'passed',items:[]}})],['text','jsonb']);
const v2args=['edit-complete',2,hash(edited),b,v,plan,'user edit','https://fixture.test/'];
const v2=await call('ita_complete_build_checkpoint',v2args,['text','bigint','text','text','text','uuid','text','text']);
assert.equal(v2.version_number,2);
const versionRow=(await svc('select * from public.ita_snapshots where id=$1',[v2.snapshot_id]))[0];
assert.equal(versionRow.parent_checkpoint_id,done.snapshot_id);
// Database-level parent identity cannot cross projects, including legacy parents.
const foreignParent=(await db.query("insert into public.ita_snapshots(project_id,user_id,files,label) values($1,$2,'[]','foreign legacy') returning id",[legacyP,userId])).rows[0].id;
await assert.rejects(db.query("insert into public.ita_snapshots(project_id,user_id,files,label,parent_checkpoint_id) values($1,$2,'[]','cross-project', $3)",[project,userId,foreignParent]),/ita_version_parent_fk|foreign key/);
console.log('PASS App Version parent: same-project numbered and legacy accepted; cross-project parent rejected by composite FK');

assert.equal((await call('ita_complete_build_checkpoint',v2args,['text','bigint','text','text','text','uuid','text','text'])).version_number,2);
await assert.rejects(db.query("insert into public.ita_snapshots(project_id,user_id,files,label,kind,version_number) values($1,$2,'[]','duplicate','checkpoint',2)",[project,userId]),/unique/);
await assert.rejects(as('authenticated',userId,'select public.ita_approve_plan($1,1)',[plan]),/not found/);


 // Formal Plan approval still returns its agent task even when User Apply shares the same basis.
 const formal=(await db.query("insert into public.ita_plans(project_id,user_id,version,kind,status,content) values($1,$2,2,'plan','draft',$3) returning id",[project,userId,JSON.stringify({acceptance:[{id:'A1',action:'view',expect:'B',external:false,steps:[{op:'expectText',selector:'main',contains:'B'}]}]})])).rows[0].id;
 const approved=(await as('authenticated',userId,'select to_jsonb(public.ita_approve_plan($1,2)) t',[formal]))[0].t;
 await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[applyExec,approved.id]);scope[1]=approved.id;scope[3]=applyExec;
 const formalArgs=['formal-complete',2,hash(edited),b,v,formal,'formal','https://fixture.test/'];
 const formalCp=await call('ita_complete_build_checkpoint',formalArgs,['text','bigint','text','text','text','uuid','text','text']);
 assert.equal(formalCp.version_number,3);
 const repeated=await Promise.all([call('ita_complete_build_checkpoint',formalArgs,['text','bigint','text','text','text','uuid','text','text']),call('ita_complete_build_checkpoint',formalArgs,['text','bigint','text','text','text','uuid','text','text'])]);
 assert.ok(repeated.every(x=>x.snapshot_id===formalCp.snapshot_id));
 const nextReceipt=await submit('formal-edit',2,[{path:'src/a.ts',content:'C'}]);
 assert.equal((await svc('select plan_id from public.ita_tasks where id=$1',[nextReceipt.task_id]))[0].plan_id,formal);
 assert.equal((await as('authenticated',userId,'select (public.ita_approve_plan($1,2)).id id',[formal]))[0].id,approved.id);
 await assert.rejects(as('authenticated',userId,'insert into public.ita_tasks(project_id,user_id,prompt,operation) values($1,$2,$3,$4)',[project,userId,'bypass','user_apply']),/permission/);
 await assert.rejects(as('authenticated',userId,'select public.ita_retry_task($1,$2)',[nextReceipt.task_id,'new']),/RELOAD_REQUIRED/);
 // Snapshot parent may be legacy; its original JSON is never modified or numbered.
 const legacyParent=(await db.query("insert into public.ita_snapshots(project_id,user_id,files,label) values($1,$2,'[]','legacy parent') returning id",[legacyP,userId])).rows[0].id;
 const oldLegacy=(await db.query('select to_jsonb(s) s from public.ita_snapshots s where id=$1',[legacyParent])).rows[0].s;
 assert.equal(oldLegacy.version_number,null);

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
   if(cmd.startsWith('curl '))return {exitCode:0,stdout:'200',stderr:''};
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

 // Real local SQL + real gateway User Apply; build/browser endpoints remain explicit fixtures.
 const {executeUserApply,userApplyBasis}=await import('../../worker/src/user-apply.js');
 const {runDeterministicValidation}=await import('../../worker/src/agent.js');
 const basisPlan=(await svc("insert into public.ita_plans(project_id,user_id,version,kind,status,content) values($1,$2,1,'action','approved',$3) returning *",[p2,userId,JSON.stringify({acceptance})]))[0];
 await svc('update public.ita_tasks set plan_id=$1,plan_version=1 where id=$2',[basisPlan.id,t2]);
 const cp=await ws.call('ita_complete_build_checkpoint',{p_key:'fixture-initial',p_revision:ws.state.revision,p_hash:ws.manifest.code_hash,p_build_basis:buildBasis,p_verify_basis:verifyBasis,p_basis_id:basisPlan.id,p_summary:'initial',p_preview_url:'https://fixture.test/'});
 const edit=(await as('authenticated',userId,'select public.ita_submit_user_apply($1,$2,$3,$4) r',[p2,'fixture-user',ws.state.revision,JSON.stringify([{path:'a.ts',content:'USER'}])]))[0].r;
 let userTask=(await svc('select * from public.ita_tasks where id=$1',[edit.task_id]))[0];const e5=randomUUID();
 await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[e5,userTask.id]);userTask.execution_id=e5;
 ws=new Workspace({...args,taskId:userTask.id,executionId:e5});await ws.read();
 let llmCalls=0,promotes=0;const originalGateway=ws.gateway.run.bind(ws.gateway);
 ws.gateway.run=async(...a)=>{if(a[0]==='promote')promotes++;return originalGateway(...a);};
 const loadChange=async()=>(await svc('select * from public.ita_changesets where id=$1',[edit.changeset_id]))[0];
 const deterministicDeps={...deps,chat:()=>{llmCalls++;throw Error('No model allowed');},verifyApp:async()=>({base:{blocking:[],warnings:[]},checks:[{id:'A1',status:'pass'}]})};
 const fixed={plan:basisPlan,acceptance,buildBasis,verifyBasis};
 const executeEdit=()=>executeUserApply({task:userTask,workspace:ws,loadChange,validateBasis:async change=>{
  assert.deepEqual(userApplyBasis(change),{checkpoint_id:cp.snapshot_id,basis_id:basisPlan.id,build_basis:buildBasis,verify_basis:verifyBasis});
  return fixed;
 },
 validateAndComplete:()=>runDeterministicValidation(userTask,sb,'fixture',ws,fixed,deterministicDeps)});
 await executeEdit();assert.equal(await fs.readFile(path.join(dir,'a.ts'),'utf8'),'USER');assert.equal(promotes,1);assert.equal(llmCalls,0);
 // Model-free resume after committed mutation and controlled lockfile revision.
 const nextRevision=ws.state.revision;
 await svc("update public.ita_tasks set status='failed' where id=$1",[userTask.id]);
 await as('authenticated',userId,'select public.ita_retry_task($1,$2)',[userTask.id,'resume']);
 const e6=randomUUID();await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[e6,userTask.id]);
 userTask=(await svc('select * from public.ita_tasks where id=$1',[userTask.id]))[0];
 ws=new Workspace({...args,taskId:userTask.id,executionId:e6});await ws.read();
 ws.gateway.run=async(...a)=>{if(a[0]==='promote')promotes++;return originalGateway(...a);};
 await executeEdit();assert.equal(ws.state.revision,nextRevision);assert.equal(promotes,1);assert.equal(llmCalls,0);
 const newVersion=await ws.call('ita_complete_build_checkpoint',{p_key:'fixture-user-complete',p_revision:ws.state.revision,p_hash:ws.manifest.code_hash,p_build_basis:buildBasis,p_verify_basis:verifyBasis,p_basis_id:basisPlan.id,p_summary:'user edit',p_preview_url:'https://fixture.test/'});
 assert.equal(newVersion.version_number,2);
 assert.equal((await svc('select parent_checkpoint_id from public.ita_snapshots where id=$1',[newVersion.snapshot_id]))[0].parent_checkpoint_id,cp.snapshot_id);
 // Retain confirmed edits on compile failure, never create a checkpoint or ask a model.
 const broken=(await as('authenticated',userId,'select public.ita_submit_user_apply($1,$2,$3,$4) r',[p2,'fixture-broken',ws.state.revision,JSON.stringify([{path:'a.ts',content:'BROKEN'}])]))[0].r;
 const brokenExec=randomUUID();userTask=(await svc('select * from public.ita_tasks where id=$1',[broken.task_id]))[0];
 await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[brokenExec,userTask.id]);
 ws=new Workspace({...args,taskId:userTask.id,executionId:brokenExec});await ws.read();
 const badChange=(await svc('select * from public.ita_changesets where id=$1',[broken.changeset_id]))[0];await ws.applyRequested(badChange);
 const goodExec=sb.exec;sb.exec=async(id,cmd)=>cmd==='npm run --ignore-scripts build'?{exitCode:1,stdout:'compile error'}:goodExec(id,cmd);
 await assert.rejects(runDeterministicValidation(userTask,sb,'fixture',ws,fixed,deterministicDeps),/VALIDATION_FAILED/);
 assert.equal(ws.state.state,'confirmed');assert.equal(await fs.readFile(path.join(dir,'a.ts'),'utf8'),'BROKEN');
 assert.equal((await svc('select checkpoint_id from public.ita_projects where id=$1',[p2]))[0].checkpoint_id,newVersion.snapshot_id);assert.equal(llmCalls,0);sb.exec=goodExec;
 await svc("update public.ita_tasks set status='failed' where id=$1",[userTask.id]);
 const repairReceipt=(await as('authenticated',userId,'select public.ita_submit_user_apply($1,$2,$3,$4) r',[p2,'manual-repair',ws.state.revision,JSON.stringify([{path:'a.ts',content:'REPAIRED'}])]))[0].r;
 assert.ok(repairReceipt.task_id); // Old stable basis can regress a confirmed failed draft, without a model.
 await svc("update public.ita_tasks set status='cancelled' where id=$1",[repairReceipt.task_id]);
 assert.equal(await fs.readFile(path.join(dir,'a.ts'),'utf8'),'BROKEN'); // Queued repair did not mutate source.


 await svc("update public.ita_tasks set status='running' where id=$1",[userTask.id]); // reactivate this local fixture for the following drift/lease assertion
 await assert.rejects(ws.runtime('build',async()=>{await fs.writeFile(path.join(dir,'a.ts'),'unexpected');return {exitCode:0};}),/未声明源码/);
 await ws.read();assert.equal(ws.state.state,'conflict');
 await assert.rejects(ws.apply([{operation:'write',path:'a.ts',content:'overwrite'}]),/REVISION_CONFLICT|BUSY|RECONCILE/);
 assert.equal(await fs.readFile(path.join(dir,'a.ts'),'utf8'),'unexpected');
 console.log('PASS User Apply local service: real SQL + Linux gateway, exact source/actor, zero model calls, committed resume no rewrite, fixed-basis validation reuse, compile failure retains source/no checkpoint, manual repair accepts prior stable basis; build/browser endpoints are fixtures');
 console.log('PASS service bridge: real SQL/gateway mutations, no-op, delete, lockfile revision, install prepare/crash/new-execution recovery, third-hash service fence, partial takeover, materialization, Agent wiring and cross-execution evidence reuse; build/browser endpoints simulated');
} finally {
 const {sha256}=await import('../../worker/src/managed-source.js');
 await fs.rm(path.join(path.dirname(dir),'.forge-workspace-'+sha256(dir).slice(0,24)),{recursive:true,force:true});
 await fs.rm(dir,{recursive:true,force:true});
}


await db.exec(readFileSync(new URL('../migrations/0010_product_editor.sql',import.meta.url),'utf8'));
// Product editor: use real mutation/evidence/completion RPCs, never direct source DML.
const productExec=randomUUID();
const productId=(await db.query('insert into public.ita_projects(user_id,name) values($1,$2) returning id',[userId,'Product editor'])).rows[0].id;
const productPlan=(await db.query("insert into public.ita_plans(project_id,user_id,version,kind,status,content) values($1,$2,1,'action','approved',$3) returning id",
 [productId,userId,JSON.stringify({acceptance:[{id:'A1',action:'read',expect:'A',external:false,steps:[{op:'expectText',selector:'main',contains:'A'}]}]})])).rows[0].id;
let productTask=(await db.query("insert into public.ita_tasks(project_id,user_id,mode,prompt,plan_id,plan_version) values($1,$2,'build','Initial',$3,1) returning id",[productId,userId,productPlan])).rows[0].id;
let productScope=[productId,productTask,'w',productExec];
await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[productExec,productTask]);
async function productCall(name,extra=[],types=[]){const ts=['uuid','uuid','text','uuid',...types];return (await svc('select to_jsonb(public.'+name+'('+ts.map((t,i)=>'$'+(i+1)+'::'+t).join(',')+')) r',[...productScope,...extra]))[0].r;}
const initialFiles=[{path:'src/a.ts',content:'A'}],initialHash=hash(initialFiles);
let productWriter=await productCall('ita_workspace_acquire',[randomUUID(),'materialize','product-sb',null],['uuid','text','text','uuid']);
await productCall('ita_workspace_finish_operation',[productWriter.token,empty],['uuid','text']);
const initialChange=await productCall('ita_workspace_prepare',['initial','agent',0,JSON.stringify([{operation:'write',path:'src/a.ts',content:'A'}]),initialHash],['text','text','bigint','jsonb','text']);
productWriter=await productCall('ita_workspace_acquire',[randomUUID(),'mutation','product-sb',initialChange.id],['uuid','text','text','uuid']);
await productCall('ita_workspace_commit',[productWriter.token,initialChange.id,JSON.stringify(initialFiles),initialHash],['uuid','uuid','jsonb','text']);
async function publishProduct(key,revision,files){
 const h=hash(files);
 for(const [kind,basis,status]of [['build',b,'passed'],['verify',v,'success_with_warnings']])
  await productCall('ita_workspace_evidence',[kind,JSON.stringify({workspace_revision:revision,code_hash:h,basis_fingerprint:basis,status,result:{warning:'fixed checks inconclusive'}})],['text','jsonb']);
 return productCall('ita_complete_build_checkpoint',[key,revision,h,b,v,productPlan,'Completed edits','https://stable.test/'],['text','bigint','text','text','text','uuid','text','text']);
}
const productV1=await publishProduct('product-v1',1,initialFiles);
const submitProduct=(key,rev,files)=>as('authenticated',userId,'select public.ita_submit_user_apply($1,$2,$3,$4) r',[productId,key,rev,JSON.stringify(files)]).then(rows=>rows[0].r);
const created=await submitProduct('add-file',1,[{operation:'create',path:'src/note.ts',content:'export const note = 1;'}]);
assert.equal((await submitProduct('add-file',1,[{operation:'create',path:'src/note.ts',content:'export const note = 1;'}])).task_id,created.task_id);
await assert.rejects(submitProduct('add-file',1,[{operation:'create',path:'src/note.ts',content:'changed'}]),/REQUEST_CONFLICT/);
async function applyProduct(receipt,files){
 const e=randomUUID();productScope=[productId,receipt.task_id,'w',e];
 await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[e,receipt.task_id]);
 const w=await productCall('ita_workspace_acquire',[randomUUID(),'mutation','product-sb',receipt.changeset_id],['uuid','text','text','uuid']);
 return productCall('ita_workspace_commit',[w.token,receipt.changeset_id,JSON.stringify(files),hash(files)],['uuid','uuid','jsonb','text']);
}
const withNote=[...initialFiles,{path:'src/note.ts',content:'export const note = 1;'}];
await applyProduct(created,withNote);
const productV2=await publishProduct('product-v2',2,withNote);
assert.equal(productV2.version_number,2);
assert.equal((await svc('select parent_checkpoint_id,label from public.ita_snapshots where id=$1',[productV2.snapshot_id]))[0].parent_checkpoint_id,productV1.snapshot_id);
assert.match((await svc('select label from public.ita_snapshots where id=$1',[productV2.snapshot_id]))[0].label,/新增 src\/note.ts/);
const editMessage=(await svc("select * from public.ita_messages where task_id=$1 and role='user'",[created.task_id]))[0];
assert.deepEqual(editMessage.meta.createdFiles,['src/note.ts']);
const beforeProductNoop=(await svc("select (select count(*) from public.ita_tasks where project_id=$1) tasks,(select count(*) from public.ita_changesets where project_id=$1) changes,(select count(*) from public.ita_snapshots where project_id=$1) versions,(select count(*) from public.ita_messages where project_id=$1) messages",[productId]))[0];
assert.deepEqual(await submitProduct('no-op',2,[{path:'src/a.ts',content:'A'}]),{accepted:true,noop:true});
assert.deepEqual((await svc("select (select count(*) from public.ita_tasks where project_id=$1) tasks,(select count(*) from public.ita_changesets where project_id=$1) changes,(select count(*) from public.ita_snapshots where project_id=$1) versions,(select count(*) from public.ita_messages where project_id=$1) messages",[productId]))[0],beforeProductNoop);
await assert.rejects(submitProduct('delete-agent-file',2,[{operation:'delete',path:'src/a.ts'}]),/DELETE_NOT_ALLOWED/);
const deleted=await submitProduct('delete-user-file',2,[{operation:'delete',path:'src/note.ts'}]);
await applyProduct(deleted,initialFiles);
const productV3=await publishProduct('product-v3',3,initialFiles);
assert.equal(productV3.version_number,3);
assert.deepEqual((await svc('select files from public.ita_snapshots where id=$1',[productV2.snapshot_id]))[0].files.map(f=>({path:f.path,content:f.content})),withNote);
await assertForgeTablePrivileges(db);
console.log('PASS product editor SQL: controlled create/delete, protected source, idempotency, persisted user messages, no-op no side effects, immutable parent versions and titles; existing authority preserved');


await db.exec(readFileSync(new URL('../migrations/0011_editor_intent.sql',import.meta.url),'utf8'));
const intentInput=[{path:'src/a.ts',content:'B'}];
const intentReceipt=(await as('authenticated',userId,'select public.ita_submit_user_apply($1,$2,$3,$4,$5) r',[productId,'intent-change',3,JSON.stringify(intentInput),'标题微调']))[0].r;
assert.equal((await svc('select prompt from public.ita_tasks where id=$1',[intentReceipt.task_id]))[0].prompt,'标题微调');
assert.equal((await svc("select count(*)::int n from public.ita_messages where task_id=$1 and role='user'",[intentReceipt.task_id]))[0].n,1);
assert.equal((await as('authenticated',userId,'select public.ita_submit_user_apply($1,$2,$3,$4,$5) r',[productId,'intent-change',3,JSON.stringify(intentInput),'标题微调']))[0].r.task_id,intentReceipt.task_id);
await assert.rejects(as('authenticated',userId,'select public.ita_submit_user_apply($1,$2,$3,$4,$5) r',[productId,'intent-change',3,JSON.stringify(intentInput),'different intent']),/REQUEST_CONFLICT/);
assert.equal((await svc("select has_function_privilege('authenticated','public.ita_submit_user_apply(uuid,text,bigint,jsonb,text)','EXECUTE') a,has_function_privilege('service_role','public.ita_submit_user_apply(uuid,text,bigint,jsonb,text)','EXECUTE') s"))[0].s,false);
console.log('PASS editor intent: atomic user message/task, same-input idempotency, changed-intent conflict, old four-argument compatibility, no new authority');


await db.exec(readFileSync(new URL('../migrations/0012_restore_app_version.sql',import.meta.url),'utf8'));
const restoreProduct=(key,rev,target)=>as('authenticated',userId,'select public.ita_restore_app_version($1,$2,$3,$4) r',[productId,target,key,rev]).then(rows=>rows[0].r);
await assert.rejects(restoreProduct('busy',3,productV2.snapshot_id),/RECONCILE|BUSY/);
await applyProduct(intentReceipt,[{path:'src/a.ts',content:'B'}]);
const productV4=await publishProduct('product-v4',4,[{path:'src/a.ts',content:'B'}]);
await assert.rejects(restoreProduct('stale',3,productV2.snapshot_id),/REVISION_CONFLICT/);
await assert.rejects(as('authenticated',randomUUID(),'select public.ita_restore_app_version($1,$2,$3,$4)',[productId,productV2.snapshot_id,'foreign',4]),/NOT_OWNED/);
const foreignCheckpoint=(await svc("select id from public.ita_snapshots where project_id<>$1 and kind='checkpoint' limit 1",[productId]))[0].id;
await assert.rejects(restoreProduct('foreign-target',4,foreignCheckpoint),/TARGET_INVALID/);
const beforeRestoreNoop=(await svc("select (select count(*) from public.ita_tasks where project_id=$1) tasks,(select count(*) from public.ita_changesets where project_id=$1) changes,(select count(*) from public.ita_snapshots where project_id=$1) versions",[productId]))[0];
assert.deepEqual(await restoreProduct('same-source',4,productV4.snapshot_id),{accepted:true,noop:true});
assert.deepEqual((await svc("select (select count(*) from public.ita_tasks where project_id=$1) tasks,(select count(*) from public.ita_changesets where project_id=$1) changes,(select count(*) from public.ita_snapshots where project_id=$1) versions",[productId]))[0],beforeRestoreNoop);
await svc("update public.ita_tasks set status='paused' where id=$1",[intentReceipt.task_id]);
await assert.rejects(restoreProduct('paused',4,productV2.snapshot_id),/PROJECT_BUSY/);
await svc("update public.ita_tasks set status='running',lease_until=now()+interval '1 hour' where id=$1",[intentReceipt.task_id]);
const runtimeWriter=await productCall('ita_workspace_acquire',[randomUUID(),'verify','product-sb',null],['uuid','text','text','uuid']);
await assert.rejects(restoreProduct('writer',4,productV2.snapshot_id),/RECONCILE/);
await productCall('ita_workspace_finish_operation',[runtimeWriter.token,hash([{path:'src/a.ts',content:'B'}])],['uuid','text']);
await svc("update public.ita_tasks set status='succeeded',lease_until=null where id=$1",[intentReceipt.task_id]);
// A normal Agent change creates a file. Restore may remove it only because the owned snapshot excludes it.
const agentExec=randomUUID(),agentTask=(await svc("insert into public.ita_tasks(project_id,user_id,mode,prompt,plan_id,plan_version,kind,retry_of) values($1,$2,'build','新增辅助文件',$3,1,'resume',$4) returning id",[productId,userId,productPlan,productTask]))[0].id;
productScope=[productId,agentTask,'w',agentExec];
await svc("update public.ita_tasks set status='running',worker_id='w',execution_id=$1,lease_until=now()+interval '1 hour' where id=$2",[agentExec,agentTask]);
const agentFiles=[{path:'src/a.ts',content:'B'},{path:'src/agent-extra.ts',content:'extra'}];
const agentChange=await productCall('ita_workspace_prepare',['agent-extra','agent',4,JSON.stringify([{operation:'write',path:'src/agent-extra.ts',content:'extra'}]),hash(agentFiles)],['text','text','bigint','jsonb','text']);
const agentWriter=await productCall('ita_workspace_acquire',[randomUUID(),'mutation','product-sb',agentChange.id],['uuid','text','text','uuid']);
await productCall('ita_workspace_commit',[agentWriter.token,agentChange.id,JSON.stringify(agentFiles),hash(agentFiles)],['uuid','uuid','jsonb','text']);
const productV5=await publishProduct('product-v5',5,agentFiles);
const restored=await restoreProduct('restore-v2',5,productV2.snapshot_id);
assert.equal((await restoreProduct('restore-v2',5,productV2.snapshot_id)).task_id,restored.task_id);
await assert.rejects(restoreProduct('restore-v2',5,productV1.snapshot_id),/REQUEST_CONFLICT/);
const restoreChange=(await svc('select * from public.ita_changesets where id=$1',[restored.changeset_id]))[0];
assert.equal(restoreChange.actor,'user');assert.equal(restoreChange.origin,'user_apply');
assert.equal(restoreChange.submission_basis.restore_checkpoint_id,productV2.snapshot_id);
assert.equal(restoreChange.submission_basis.checkpoint_id,productV5.snapshot_id);
assert.ok(restoreChange.changes.some(c=>c.path==='src/agent-extra.ts'&&c.operation==='delete'));
assert.ok(restoreChange.changes.some(c=>c.path==='src/note.ts'&&c.operation==='write'));
assert.equal((await svc('select operation,prompt from public.ita_tasks where id=$1',[restored.task_id]))[0].operation,'user_apply');
await assert.rejects(svc("update public.ita_changesets set submission_basis=submission_basis||jsonb_build_object('restore_checkpoint_id',gen_random_uuid()) where id=$1",[restored.changeset_id]),/IMMUTABLE|permission denied/);
await applyProduct(restored,withNote);
const productV6=await publishProduct('restored-v2',6,withNote);
assert.equal(productV6.version_number,6);
assert.equal((await svc('select parent_checkpoint_id from public.ita_snapshots where id=$1',[productV6.snapshot_id]))[0].parent_checkpoint_id,productV5.snapshot_id);
assert.deepEqual((await svc('select files from public.ita_snapshots where id=$1',[productV2.snapshot_id]))[0].files.map(f=>({path:f.path,content:f.content})),withNote);
assert.deepEqual((await svc('select path,content from public.ita_files where project_id=$1 and not deleted order by path',[productId])),withNote);
assert.equal((await restoreProduct('restore-v2',5,productV2.snapshot_id)).task_id,restored.task_id);
await assertForgeTablePrivileges(db);
for(const role of ['anon','service_role'])assert.equal((await svc("select has_function_privilege($1,'public.ita_restore_app_version(uuid,uuid,text,bigint)','EXECUTE') ok",[role]))[0].ok,false);
console.log('PASS historical restore SQL: owned immutable snapshot diff, agent-file delete only through restore, task/writer/unresolved/stale fences, immutable submission, idempotency and request conflict, zero-op, fresh revision/new child version, unchanged historical snapshots and source authority');


await db.exec(readFileSync(new URL('../migrations/0013_active_app_version.sql',import.meta.url),'utf8'));
const legacyNumberedBefore=(await svc('select to_jsonb(s) row from public.ita_snapshots s where id=$1',[productV2.snapshot_id]))[0].row;
const restoredV1=await restoreProduct('select-original-v1',6,productV1.snapshot_id);
await applyProduct(restoredV1,initialFiles);
const technicalRestore=await publishProduct('restore-without-number',7,initialFiles);
assert.equal(technicalRestore.version_number,1);
assert.equal(technicalRestore.app_version_id,productV1.snapshot_id);
const restoreEvent=(await svc("select meta from public.ita_messages where task_id=$1 and role='assistant' order by created_at desc limit 1",[restoredV1.task_id]))[0].meta;
assert.equal(restoreEvent.appVersionId,productV1.snapshot_id);assert.equal(restoreEvent.versionNumber,1);
assert.equal((await svc('select version_number,app_version_id from public.ita_snapshots where id=$1',[technicalRestore.snapshot_id]))[0].version_number,null);
assert.equal((await svc('select active_app_version_id,checkpoint_id from public.ita_projects where id=$1',[productId]))[0].active_app_version_id,productV1.snapshot_id);
assert.equal((await svc('select max(version_number)::int n from public.ita_snapshots where project_id=$1',[productId]))[0].n,6);
assert.equal((await productCall('ita_complete_build_checkpoint',['restore-without-number',7,hash(initialFiles),b,v,productPlan,'Completed edits','https://stable.test/'],['text','bigint','text','text','text','uuid','text','text'])).snapshot_id,technicalRestore.snapshot_id);
await assert.rejects(productCall('ita_complete_build_checkpoint',['restore-without-number',7,hash(initialFiles),b,v,productPlan,'Different summary','https://stable.test/'],['text','bigint','text','text','text','uuid','text','text']),/IDEMPOTENCY_CONFLICT/);
assert.deepEqual((await svc('select to_jsonb(s) row from public.ita_snapshots s where id=$1',[productV2.snapshot_id]))[0].row,legacyNumberedBefore);
for(const role of ['anon','authenticated','service_role']){
 assert.equal((await svc("select has_column_privilege($1,'public.ita_projects','active_app_version_id','UPDATE') ok",[role]))[0].ok,false);
 assert.equal((await svc("select has_column_privilege($1,'public.ita_snapshots','app_version_id','UPDATE') ok",[role]))[0].ok,false);
}
assert.deepEqual(await restoreProduct('same-v1',7,productV1.snapshot_id),{accepted:true,noop:true});
const nextRealEdit=await submitProduct('edit-after-restoring',7,[{path:'src/a.ts',content:'NEXT'}]);
const nextFiles=[{path:'src/a.ts',content:'NEXT'}];await applyProduct(nextRealEdit,nextFiles);
const nextRealVersion=await publishProduct('new-real-version',8,nextFiles);
assert.equal(nextRealVersion.version_number,7);
assert.equal((await svc('select parent_checkpoint_id from public.ita_snapshots where id=$1',[nextRealVersion.snapshot_id]))[0].parent_checkpoint_id,productV1.snapshot_id);
await assert.rejects(svc('update public.ita_snapshots set app_version_id=$1 where id=$2',[productV1.snapshot_id,nextRealVersion.snapshot_id]),/IMMUTABLE|permission denied/);
// A controlled install/source drift must never be presented as the original historical version.
const driftRestore=await restoreProduct('restore-drift',8,productV1.snapshot_id);
await applyProduct(driftRestore,initialFiles);
const driftFiles=[{path:'src/a.ts',content:'not-original'}];
const driftChange=await productCall('ita_workspace_prepare',['source-after-restore','agent',9,JSON.stringify([{operation:'write',path:'src/a.ts',content:'not-original'}]),hash(driftFiles)],['text','text','bigint','jsonb','text']);
const driftWriter=await productCall('ita_workspace_acquire',[randomUUID(),'mutation','product-sb',driftChange.id],['uuid','text','text','uuid']);
await productCall('ita_workspace_commit',[driftWriter.token,driftChange.id,JSON.stringify(driftFiles),hash(driftFiles)],['uuid','uuid','jsonb','text']);
await assert.rejects(publishProduct('drift-not-v1',10,driftFiles),/RESTORE_SOURCE_CHANGED/);
await db.query('delete from public.ita_projects where id=$1',[productId]);
assert.equal((await svc('select count(*)::int n from public.ita_snapshots where project_id=$1',[productId]))[0].n,0);
console.log('PASS restore identity: original App number/current pointer, new technical checkpoint, exact source, immutable history, idempotency, next real edit numbering/parent, drift rejection, authority and cascade');

await db.close();
console.log('PASS Demo SQL: numbered versions/legacy parent/immutable metadata/completion-key repeat/approval separation; User Apply ownership/active task+writer+preview/unresolved/idempotency/stale/input authority; preview revision receipt/cache invalidation (single-connection PGlite, not a dual-connection concurrency proof)');
console.log('PASS workspace SQL: canonical hash, source privilege cutover, RLS, lease/epoch, partial recovery, no-op, stale conflict, evidence reuse, blocker/tool-error, immutable idempotent checkpoint, legacy multi-intent committed/not_applied exit, authority ACLs, third-hash rejection, completion identity, DELETE immutability, cascade (single-connection PGlite; not concurrency proof)');
