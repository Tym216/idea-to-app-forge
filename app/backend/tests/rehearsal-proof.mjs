/** Local validation evidence, not an authorization to mutate Main. No env/key/connection loading. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const FRESH_REF='vtevambqlnezprpezqyf';
export const REVISED_HASH='5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782';
const steps=['cutover-migrate','cutover-authority','cutover-concurrency','cutover-concurrency-mutation','cutover-daytona'];
const names=['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0005_preview_recovery.sql','0006_workspace_contract.sql'];
const find=(record,step)=>record.observations.find(o=>o.step===step&&o.status==='PASS');
export function validateRehearsalProof({records,manifest,currentHashes}) {
 assert.equal(currentHashes.at(-1).sha256,REVISED_HASH,'Rehearsal does not cover the current revised artifact');
 assert.equal(manifest.project_ref,FRESH_REF);assert.equal(manifest.fresh_public_schema,true);assert.equal(manifest.fresh_forge_objects,true);
 assert.deepEqual(currentHashes.map(h=>h.name),names);assert.deepEqual(manifest.migrations,currentHashes);
 for(const step of steps){const r=records[step];assert.ok(r);assert.equal(r.status,'PASS');assert.equal(r.exit_code,0);assert.equal(r.project_ref,FRESH_REF);assert.equal(r.migration_sha256,REVISED_HASH);assert.ok(r.observations.every(o=>o.status!=='FAIL'&&(!o.project_ref||o.project_ref===FRESH_REF)));}
 const m=find(records['cutover-migrate'],'Step 1');assert.equal(m.migrations,6);assert.equal(m.replayed_migrations,0);assert.equal(m.legacy_changesets,0);
 const invariant=find(records['cutover-authority'],'Forge table management invariant');assert.equal(invariant.tables,14);assert.equal(invariant.checks,42);assert.equal(invariant.violations,0);assert.equal(invariant.actual_truncate_denied_tables,14);assert.equal(invariant.sqlstate,'42501');
 const authority=find(records['cutover-authority'],'Step 2');assert.equal(authority.legal_workspace_rpc,true);assert.equal(authority.deletion_cascade,true);assert.equal(authority.completion_snapshots,1);assert.equal(authority.completion_facts,1);
 const concurrency=find(records['cutover-concurrency'],'Step 3');assert.equal(concurrency.deadlocks,0);assert.equal(concurrency.checkpoint_count,1);assert.equal(concurrency.completion_fact_count,1);
 assert.equal(find(records['cutover-concurrency-mutation'],'Step 3 source-mutation supplement').deadlocks,0);
 const d=find(records['cutover-daytona'],'Step 4');assert.equal(d.real_browser_runs,2);assert.equal(d.builds,2);assert.equal(d.checkpoint_status,'done_with_warnings');assert.equal(d.runtime_evidence_reused,true);
 assert.equal(find(records['cutover-daytona'],'real core blocker prohibits checkpoint').checkpoint_count,0);
 const cleanup=find(records['cutover-daytona'],'fresh resource cleanup');assert.equal(cleanup.sandbox_deleted,true);assert.equal(cleanup.disposable_project_data_deleted,true);
 return {project_ref:FRESH_REF,migration_sha256:REVISED_HASH,steps:5,status:'PASS',fresh:true};
}
export function loadRehearsalProof(root) {
 const base=path.join(root,'app/worker/.cutover/fresh-v2-rehearsal',REVISED_HASH);
 const records=Object.fromEntries(steps.map(s=>[s,JSON.parse(readFileSync(path.join(base,s+'.result.json'),'utf8'))]));
 const manifest=JSON.parse(readFileSync(path.join(root,'app/worker/.cutover/fresh-migration-rehearsal.json'),'utf8'));
 const currentHashes=names.map(name=>({name,sha256:createHash('sha256').update(readFileSync(path.join(root,'app/backend/migrations',name))).digest('hex')}));
 return validateRehearsalProof({records,manifest,currentHashes});
}

/** Grant origin alone never makes it compatible: exact table scope + no inherited/owner powers + post-migration scan. */
export function assertCompatiblePreMigrationGrants({effective,grants,membership,expectedTables,postMigrationInvariant}) {
 assert.deepEqual([...new Set(effective.map(r=>r.relname))].sort(),[...expectedTables].sort(),'Unknown/missing Main Forge table');
 assert.ok(effective.every(r=>r.owner==='postgres'&&!r.effective_owner_role),'Owner/inherited authority cannot be revoked by this migration');
 assert.ok(membership.every(r=>r.rolname==='service_role'||!r.effective_usage),'Unmodeled inherited role powers');
 for(const r of effective.filter(r=>r.effective))assert.ok(grants.some(g=>g.relname===r.relname&&g.privilege_type===r.privilege&&['PUBLIC','anon','authenticated','service_role'].includes(g.grantee)&&g.grantor==='postgres'&&!g.is_grantable),'Unmodeled authority grant');
 assert.ok(grants.every(g=>!['PUBLIC','anon','authenticated','service_role'].includes(g.grantee)||(g.grantor==='postgres'&&!g.is_grantable)),'Unmodeled grant option/origin');
 assert.equal(postMigrationInvariant.violations,0);assert.equal(postMigrationInvariant.tables,expectedTables.length+1);
 return {observed_pre_migration_grants:effective.filter(r=>r.effective).length,unresolved_unsafe_authority_privileges:0,post_migration_tables:postMigrationInvariant.tables};
}
