/** Exact platform omission contract; a self-hash alone is not authority to skip SQL. */
import {fingerprint} from '../../worker/src/managed-source.js';
export function validateDerivedPlan(plan,{recovery,originalPost,filteredPost}){
 const {derived_plan_hash,...core}=plan;
 if(fingerprint(core)!==derived_plan_hash)throw new Error('DERIVED_PLAN_HASH_MISMATCH');
 if(plan.source_ref!==recovery.source_ref||plan.target_ref!==recovery.target_ref||plan.source_ref===plan.target_ref||plan.original_recovery_set_id!==recovery.recovery_set_id||plan.original_recovery_bundle_hash!==recovery.recovery_bundle_hash||plan.original_db_manifest_hash!==recovery.db_manifest_sha256)throw new Error('DERIVED_RECOVERY_IDENTITY_MISMATCH');
 const names=['alignment.sql','inverse-target-baseline.sql','public-post.filtered.sql','target-default-acl-aligned.json','target-default-acl-before.json'];
 if(fingerprint(Object.keys(plan.files).sort())!==fingerprint(names.sort()))throw new Error('DERIVED_FILE_SET_MISMATCH');
 if(plan.omitted_platform_entries.length!==3||!['SEQUENCES','FUNCTIONS','TABLES'].every(t=>plan.omitted_platform_entries.filter(s=>s.includes(' DEFAULT ACL public DEFAULT PRIVILEGES FOR '+t+' supabase_admin')).length===1))throw new Error('DERIVED_TOC_ALLOWLIST_MISMATCH');
 const original=originalPost.split('\n'),indices=new Set(),identities=new Set();
 if(plan.omitted_statements.length!==12)throw new Error('DERIVED_OMISSION_COUNT_MISMATCH');
 for(const s of plan.omitted_statements){
  if(s.identity.owner_role!=='supabase_admin'||s.identity.namespace!=='public'||!['S','f','r'].includes(s.identity.object_type)||!s.equivalent||s.restore_role_can_replay||!s.classification.startsWith('platform-managed')||!/^ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON (SEQUENCES|FUNCTIONS|TABLES) TO (postgres|anon|authenticated|service_role);$/.test(s.sql)||original[s.line-1]!==s.sql||indices.has(s.line-1))throw new Error('DERIVED_OMISSION_NOT_EXACT');
  const object={S:'SEQUENCES',f:'FUNCTIONS',r:'TABLES'}[s.identity.object_type];
  if(s.sql!==`ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON ${object} TO ${s.identity.grantee};`||fingerprint(s.source_semantic_value)!==fingerprint(s.target_semantic_value)||identities.has(object+'|'+s.identity.grantee))throw new Error('DERIVED_PLATFORM_SEMANTICS_MISMATCH');
  identities.add(object+'|'+s.identity.grantee);indices.add(s.line-1);
 }
 if(original.filter((s,i)=>!indices.has(i)).join('\n')!==filteredPost||filteredPost.split('\n').filter(s=>s.startsWith('ALTER DEFAULT PRIVILEGES ')).length!==6)throw new Error('DERIVED_SQL_NOT_EXACT_FILTER');
 return {status:'PASS',derived_plan_hash};
}
