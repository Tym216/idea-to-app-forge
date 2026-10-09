/** Shared full recovery validation. All queries are read-only; source connections are pinned Main READ ONLY. */
import {createHash} from 'node:crypto';
import {operationalConnect} from './ops-db-target.mjs';
import {recoveryIdentity} from './ops-recovery-bundle.mjs';
import {recoveryCatalog,compareRecoveryCatalog} from './ops-recovery-catalog.mjs';
import {DEFAULT_ACL_SQL,defaultACLHash,publicDefaults,sequenceStates} from './ops-default-acl.mjs';
import {verifyFrozen} from './ops-ingress-gate.mjs';
import {fingerprint,sourceManifest} from '../../worker/src/managed-source.js';
const qi=s=>'"'+s.replaceAll('"','""')+'"';
export async function tableDigest(db,schema,table){
 const h=createHash('sha256'),rows=(await db.query(`select to_jsonb(r)::text body from ${qi(schema)}.${qi(table)} r order by to_jsonb(r)::text collate "C"`)).rows;
 for(const r of rows)h.update(r.body+'\n');return {schemaname:schema,tablename:table,count:String(rows.length),data_hash:h.digest('hex')};
}
export async function inventory(db,manifest){await db.query("SET LOCAL TIME ZONE 'UTC'");const rows=[];for(const t of manifest.counts)rows.push(await tableDigest(db,t.schemaname,t.tablename));return rows;}
export function tableDiff(expected,actual){const found=new Map(actual.map(r=>[r.schemaname+'.'+r.tablename,r]));return expected.filter(r=>fingerprint(r)!==fingerprint(found.get(r.schemaname+'.'+r.tablename))).map(r=>({table:r.schemaname+'.'+r.tablename,reason:'count/content hash differs'}));}
export async function mainProof(manifest){
 const {db}=await operationalConnect('main');try{
  await verifyFrozen(db);
  const counts=await inventory(db,manifest),catalog=await recoveryCatalog(db),defaults=(await db.query(DEFAULT_ACL_SQL)).rows,sequences=await sequenceStates(db);
  const issues=[...tableDiff(manifest.counts.filter(t=>t.schemaname==='public'),counts),...compareRecoveryCatalog(manifest.catalog,catalog).mismatches];
  const paused=(await db.query('select status,execution_id,worker_id,lease_until from public.ita_tasks where id=$1',[recoveryIdentity.task_id])).rows[0];
  if(!paused||paused.status!=='paused'||paused.execution_id||paused.worker_id||paused.lease_until)issues.push({reason:'Main paused task isolation changed'});
  if((await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed)issues.push({reason:'Main unexpectedly contains 0006'});
  return {counts,catalog,defaults,sequences,paused,issues,frozen:true};
 }finally{await db.query('ROLLBACK').catch(()=>{});await db.end();}
}
export async function validateRestoredState(db,{manifest,plan,authHistory,mainSequences}){
 const expected=manifest.counts.filter(t=>!(t.schemaname==='auth'&&t.tablename==='schema_migrations'));
 const restored=await inventory(db,{counts:expected}),mismatches=tableDiff(expected,restored),catalog=await recoveryCatalog(db),comparison=compareRecoveryCatalog(manifest.catalog,catalog);mismatches.push(...comparison.mismatches);
 const finalDefaults=(await db.query(DEFAULT_ACL_SQL)).rows;
 const defaultsEqual=defaultACLHash(finalDefaults)===plan.target_default_acl_precondition_hash&&defaultACLHash(publicDefaults(finalDefaults))===defaultACLHash(plan.expected_public_defaults);
 if(!defaultsEqual)mismatches.push({reason:'DEFAULT ACL semantic mismatch (including protected platform/global/other scopes)'});
 const finalSequences=await sequenceStates(db);
 if(fingerprint(finalSequences.map(({namespace,name,last_value,is_called})=>({namespace,name,last_value,is_called})))!==fingerprint([...plan.expected_final_sequences].sort((a,b)=>(a.namespace+'.'+a.name).localeCompare(b.namespace+'.'+b.name))))mismatches.push({reason:'T0 sequence values/set differs'});
 const def=s=>{const {last_value,is_called,...rest}=s;return rest;};
 if(fingerprint(finalSequences.map(def))!==fingerprint(mainSequences.map(def)))mismatches.push({reason:'sequence structure/owner differs'});
 if(fingerprint(authHistory)!==fingerprint(await tableDigest(db,'auth','schema_migrations')))mismatches.push({reason:'target platform Auth migration history changed'});
 if((await db.query("select to_regclass('public.ita_changesets') is not null installed")).rows[0].installed)mismatches.push({reason:'restore unexpectedly contains 0006'});
 const relationships=(await db.query("select t.id task_id,t.status,t.project_id,t.plan_id,p.id matched_project,pl.id matched_plan,(select count(*)::int from public.ita_files f where f.project_id=t.project_id and not f.deleted) files,(select count(*)::int from public.ita_messages m where m.project_id=t.project_id) messages,(select count(*)::int from public.ita_snapshots s where s.project_id=t.project_id) snapshots from public.ita_tasks t join public.ita_projects p on p.id=t.project_id left join public.ita_plans pl on pl.id=t.plan_id where t.status='paused'")).rows;
 const preserved=sourceManifest((await db.query('select path,content from public.ita_files where project_id=$1 and not deleted order by path',[recoveryIdentity.project_id])).rows);
 const paused=relationships.find(t=>t.task_id===recoveryIdentity.task_id);
 if(preserved.files.length!==10||preserved.code_hash!==manifest.paused_db_source.code_hash||preserved.files.some(f=>f.path==='package-lock.json')||!paused||paused.status!=='paused'||paused.project_id!==recoveryIdentity.project_id||!paused.matched_plan||paused.files!==10)mismatches.push({reason:'paused DB 10-file authority/relationships changed'});
 const relationCounts={};
 for(const table of ['ita_tasks','ita_plans','ita_messages','ita_files','ita_snapshots']){
  const row=(await db.query(`select count(*)::int total,count(p.id)::int matched_projects from public.${qi(table)} x left join public.ita_projects p on p.id=x.project_id`)).rows[0];relationCounts[table]=row;if(row.total!==row.matched_projects)mismatches.push({table,reason:'project relationship orphan'});
 }
 const taskPlans=(await db.query('select count(*)::int mismatched from public.ita_tasks t left join public.ita_plans p on p.id=t.plan_id where t.plan_id is not null and (p.id is null or p.project_id<>t.project_id)')).rows[0];
 if(taskPlans.mismatched)mismatches.push({reason:'task/plan project relationship mismatch'});
 return {expected,restored,mismatches,catalog,comparison,finalDefaults,defaultsEqual,finalSequences,relationships,relationCounts,taskPlans,preserved,authHistoryPreserved:fingerprint(authHistory)===fingerprint(await tableDigest(db,'auth','schema_migrations'))};
}
