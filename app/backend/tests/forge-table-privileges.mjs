import assert from 'node:assert/strict';

// Permanent invariant. Future exceptions require a named table/privilege + rationale in this file, never env overrides.
export const FORGE_TABLE_PRIVILEGE_ALLOWLIST=Object.freeze({});
export const FORGE_TABLE_PRIVILEGE_SQL=`select n.nspname schema_name,c.relname table_name,p.privilege,
 has_table_privilege('service_role',c.oid,p.privilege) effective
 from pg_class c join pg_namespace n on n.oid=c.relnamespace
 cross join (select unnest(array['TRUNCATE','TRIGGER','REFERENCES']) privilege) p
 where n.nspname='public' and c.relkind in ('r','p') and c.relname ~ '^ita_'
 order by c.relname,p.privilege`;

export async function assertForgeTablePrivileges(db) {
 for(const [table,privileges] of Object.entries(FORGE_TABLE_PRIVILEGE_ALLOWLIST)) {
   assert.match(table,/^public\.ita_/,'Allowlist must name a Forge table');
   for(const [privilege,reason] of Object.entries(privileges)) {
     assert.ok(['TRUNCATE','TRIGGER','REFERENCES'].includes(privilege),'Unknown management privilege exception');
     assert.ok(typeof reason==='string'&&reason.trim().length>0,'Privilege exception requires an explicit rationale');
   }
 }
 const {rows}=await db.query(FORGE_TABLE_PRIVILEGE_SQL);
 assert.ok(rows.length>0,'No Forge-owned tables found: privilege invariant did not run');
 const violations=rows.filter(r=>r.effective&&!FORGE_TABLE_PRIVILEGE_ALLOWLIST[r.schema_name+'.'+r.table_name]?.[r.privilege]);
 assert.deepEqual(violations,[],'Forge table management privilege bypass: service_role must not have TRUNCATE/TRIGGER/REFERENCES');
 return {tables:new Set(rows.map(r=>r.table_name)).size,checks:rows.length,violations:0};
}
