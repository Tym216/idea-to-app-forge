import {test} from 'node:test';import assert from 'node:assert/strict';
import {validateRehearsalProof,assertCompatiblePreMigrationGrants,FRESH_REF,REVISED_HASH} from './rehearsal-proof.mjs';
const fixture=()=>{
 const currentHashes=['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0005_preview_recovery.sql','0006_workspace_contract.sql'].map(name=>({name,sha256:name.startsWith('0006')?REVISED_HASH:'fixture'}));
 const obs={
  'cutover-migrate':[{step:'Step 1',migrations:6,replayed_migrations:0,legacy_changesets:0}],
  'cutover-authority':[{step:'Forge table management invariant',tables:14,checks:42,violations:0,actual_truncate_denied_tables:14,sqlstate:'42501'},{step:'Step 2',legal_workspace_rpc:true,deletion_cascade:true,completion_snapshots:1,completion_facts:1}],
  'cutover-concurrency':[{step:'Step 3',deadlocks:0,checkpoint_count:1,completion_fact_count:1}],
  'cutover-concurrency-mutation':[{step:'Step 3 source-mutation supplement',deadlocks:0}],
  'cutover-daytona':[{step:'Step 4',real_browser_runs:2,builds:2,checkpoint_status:'done_with_warnings',runtime_evidence_reused:true},{step:'real core blocker prohibits checkpoint',checkpoint_count:0},{step:'fresh resource cleanup',sandbox_deleted:true,disposable_project_data_deleted:true}],
 };
 return {currentHashes,manifest:{project_ref:FRESH_REF,fresh_public_schema:true,fresh_forge_objects:true,migrations:structuredClone(currentHashes)},records:Object.fromEntries(Object.entries(obs).map(([step,o])=>[step,{status:'PASS',exit_code:0,project_ref:FRESH_REF,migration_sha256:REVISED_HASH,observations:o.map(x=>({...x,status:'PASS',project_ref:FRESH_REF}))}]))};
};
test('only complete fresh same-artifact real rehearsal can cover known pre-migration grants',()=>assert.equal(validateRehearsalProof(fixture()).status,'PASS'));
test('old hash/target, partial/failed rehearsal, non-fresh manifest and ineffective guards cannot authorize compatibility',()=>{
 for(const mutate of [f=>f.records['cutover-daytona'].status='FAIL',f=>f.records['cutover-migrate'].project_ref='dfixexlufeyrdublqcxu',f=>f.records['cutover-authority'].migration_sha256='old',f=>f.manifest.fresh_public_schema=false,f=>f.currentHashes[0].sha256='changed',f=>f.records['cutover-authority'].observations[0].violations=1,f=>delete f.records['cutover-concurrency'],f=>f.records['cutover-daytona'].observations[1].checkpoint_count=1]){const f=fixture();mutate(f);assert.throws(()=>validateRehearsalProof(f));}
});
const compatible=()=>({expectedTables:['ita_files'],effective:[{relname:'ita_files',privilege:'TRUNCATE',effective:true,owner:'postgres',effective_owner_role:false}],grants:[{relname:'ita_files',privilege_type:'TRUNCATE',grantee:'service_role',grantor:'postgres',is_grantable:false}],membership:[{rolname:'service_role',effective_usage:true}],postMigrationInvariant:{tables:2,violations:0}});
test('compatibility keeps observed grants visible and requires simulated migration to eliminate them',()=>assert.deepEqual(assertCompatiblePreMigrationGrants(compatible()),{observed_pre_migration_grants:1,unresolved_unsafe_authority_privileges:0,post_migration_tables:2}));
test('platform label alone cannot allowlist owner/inheritance/unknown-table/remaining privileges',()=>{for(const mutate of [f=>f.effective[0].effective_owner_role=true,f=>f.membership.push({rolname:'other',effective_usage:true}),f=>f.effective[0].relname='ita_unknown',f=>f.grants[0].grantor='other',f=>f.grants[0].is_grantable=true,f=>f.postMigrationInvariant.violations=1]){const f=compatible();mutate(f);assert.throws(()=>assertCompatiblePreMigrationGrants(f));}});
