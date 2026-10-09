/** Exact object ACL normalization stage. No DEFAULT/function/column/sequence ACL or source DML. */
import {fingerprint} from '../../worker/src/managed-source.js';
import {recoveryCatalog} from './ops-recovery-catalog.mjs';
const qi=s=>'"'+s.replaceAll('"','""')+'"';
const canonical=tables=>[...tables].map(t=>({...t,acl:[...t.acl].sort((a,b)=>fingerprint(a).localeCompare(fingerprint(b)))})).sort((a,b)=>a.relname.localeCompare(b.relname));
export const tableACLHash=tables=>fingerprint(canonical(tables));
export function tableACLDelta(expected,actual){
 const wanted=new Map(expected.map(t=>[t.relname,t])),got=new Map(actual.map(t=>[t.relname,t]));
 if(wanted.size!==expected.length||got.size!==actual.length||wanted.size!==got.size||[...wanted.keys()].some(k=>!got.has(k)))throw new Error('TABLE_IDENTITY_SET_MISMATCH');
 const missing=[],extra=[];
 for(const [name,t] of wanted){const a=got.get(name);
  if(fingerprint({...t,acl:[]})!==fingerprint({...a,acl:[]}))throw new Error('TABLE_NON_ACL_METADATA_MISMATCH');
  const w=new Set(t.acl.map(fingerprint)),g=new Set(a.acl.map(fingerprint));if(w.size!==t.acl.length||g.size!==a.acl.length)throw new Error('DUPLICATE_TABLE_ACL');
  for(const r of t.acl)if(!g.has(fingerprint(r)))missing.push({schema:'public',table:name,...r});
  for(const r of a.acl)if(!w.has(fingerprint(r)))extra.push({schema:'public',table:name,...r});
 }
 const sort=rows=>rows.sort((a,b)=>(a.table+'|'+a.grantee+'|'+a.privilege+'|'+a.grantor+'|'+a.grantable).localeCompare(b.table+'|'+b.grantee+'|'+b.privilege+'|'+b.grantor+'|'+b.grantable));
 return {missing:sort(missing),extra:sort(extra)};
}
export function exactTableACLRepair(expected,actual){
 const diff=tableACLDelta(expected,actual),names=new Set(diff.extra.map(r=>r.table)),roles=['anon','authenticated'],privileges=['MAINTAIN','REFERENCES','TRIGGER','TRUNCATE'];
 if(expected.length!==13||diff.missing.length||diff.extra.length!==104||names.size!==13||expected.some(t=>!/^ita_[a-z0-9_]+$/.test(t.relname)||t.owner!=='postgres')||diff.extra.some(r=>r.schema!=='public'||!roles.includes(r.grantee)||!privileges.includes(r.privilege)||r.grantor!=='postgres'||r.grantable!==false))throw new Error('TABLE_ACL_DIFF_OUTSIDE_AUTHORIZATION');
 for(const name of names)for(const role of roles)for(const privilege of privileges)if(diff.extra.filter(r=>r.table===name&&r.grantee===role&&r.privilege===privilege).length!==1)throw new Error('TABLE_ACL_DIFF_OUTSIDE_AUTHORIZATION');
 const sql=(r,grant)=>`${grant?'GRANT':'REVOKE'} ${r.privilege} ON TABLE ${qi(r.schema)}.${qi(r.table)} ${grant?'TO':'FROM'} ${qi(r.grantee)};`;
 return {source_expected_acl_hash:tableACLHash(expected),pre_repair_acl_hash:tableACLHash(actual),diff,revoke:diff.extra.map(r=>sql(r,false)),inverse:diff.extra.map(r=>sql(r,true))};
}
/** Caller owns target-only transaction. A failed CAS/compare must ROLLBACK, never COMMIT. */
export async function normalizeTableACL(db,expected,repair){
 // Canonical lock ordering plus transaction-scoped locks prevent competing object ACL changes.
 for(const t of [...expected].sort((a,b)=>a.relname.localeCompare(b.relname)))await db.query(`LOCK TABLE "public".${qi(t.relname)} IN ACCESS EXCLUSIVE MODE`);
 const before=await recoveryCatalog(db),live=exactTableACLRepair(expected,before.tables);
 if(fingerprint(live)!==fingerprint(repair))throw new Error('TABLE_ACL_REPAIR_PRECONDITION_CHANGED');
 for(const sql of repair.revoke)await db.query(sql);
 const after=await recoveryCatalog(db),delta=tableACLDelta(expected,after.tables);
 if(delta.missing.length||delta.extra.length||tableACLHash(after.tables)!==repair.source_expected_acl_hash)throw new Error('TABLE_ACL_TRANSACTION_COMPARE_FAILED');
 const withoutTables=c=>{const {tables,...other}=c;return other;};
 if(fingerprint(withoutTables(before))!==fingerprint(withoutTables(after)))throw new Error('TABLE_ACL_REPAIR_CHANGED_OTHER_CATALOG');
 return {before,after,missing:0,extra:0,post_repair_acl_hash:tableACLHash(after.tables)};
}
