import {test} from 'node:test';import assert from 'node:assert/strict';
import {fingerprint} from '../../worker/src/managed-source.js';
import {validateDerivedPlan} from './ops-derived-restore-plan.mjs';
const fixture=()=>{
 const recovery={source_ref:'main',target_ref:'restore',recovery_set_id:'T0',recovery_bundle_hash:'bundle',db_manifest_sha256:'manifest'};
 const statements=[];for(const [object,type] of [['SEQUENCES','S'],['FUNCTIONS','f'],['TABLES','r']])for(const grantee of ['postgres','anon','authenticated','service_role'])statements.push({line:statements.length+1,sql:`ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON ${object} TO ${grantee};`,identity:{owner_role:'supabase_admin',namespace:'public',object_type:type,grantee},equivalent:true,restore_role_can_replay:false,classification:'platform-managed baseline',source_semantic_value:[{grantee,privilege:'example'}],target_semantic_value:[{grantee,privilege:'example'}]});
 const app=Array.from({length:6},(_,i)=>`ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT ON TABLES TO role${i};`);
 const originalPost=[...statements.map(s=>s.sql),...app,'-- preserve post-data unchanged',''].join('\n'),filteredPost=[...app,'-- preserve post-data unchanged',''].join('\n');
 const plan={source_ref:'main',target_ref:'restore',original_recovery_set_id:'T0',original_recovery_bundle_hash:'bundle',original_db_manifest_hash:'manifest',files:Object.fromEntries(['alignment.sql','inverse-target-baseline.sql','public-post.filtered.sql','target-default-acl-aligned.json','target-default-acl-before.json'].map(n=>[n,'hash'])),omitted_platform_entries:['SEQUENCES','FUNCTIONS','TABLES'].map(t=>'1; 1 1 DEFAULT ACL public DEFAULT PRIVILEGES FOR '+t+' supabase_admin'),omitted_statements:statements};
 plan.derived_plan_hash=fingerprint(plan);return {plan,args:{recovery,originalPost,filteredPost}};
};
const seal=p=>{delete p.derived_plan_hash;p.derived_plan_hash=fingerprint(p);};
test('derived restore accepts only the 12 exact equivalent platform statements and retains every other byte',()=>{
 const {plan,args}=fixture();assert.equal(validateDerivedPlan(plan,args).status,'PASS');
 assert.throws(()=>validateDerivedPlan(plan,{...args,filteredPost:args.filteredPost.replace('preserve','omit')}),/NOT_EXACT_FILTER/);
 const wrong=structuredClone(plan);wrong.target_ref=wrong.source_ref;seal(wrong);assert.throws(()=>validateDerivedPlan(wrong,args),/IDENTITY_MISMATCH/);
});
test('derived restore cannot broaden omission, fabricate equivalence or substitute execution files',()=>{
 const {plan,args}=fixture();for(const mutate of [p=>{p.omitted_statements[0].identity.owner_role='postgres';},p=>{p.omitted_statements[0].target_semantic_value=[];},p=>{p.files['../public-post.sql']='hash';},p=>{p.omitted_statements.pop();},p=>{p.omitted_platform_entries[0]='skip all DEFAULT ACL';}]){
  const p=structuredClone(plan);mutate(p);seal(p);assert.throws(()=>validateDerivedPlan(p,args));
 }
 const p=structuredClone(plan);p.omitted_statements[0].equivalent=false;assert.throws(()=>validateDerivedPlan(p,args),/HASH_MISMATCH/);
});
