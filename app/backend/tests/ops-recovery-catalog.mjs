/** Reuse the approved structured comparator: no raw function hash or ACL ordering shortcuts. */
import {FUNCTION_SQL,compareFunction,equal,canonicalPolicy,canonicalConstraints} from './baseline-comparator.mjs';
export async function recoveryCatalog(db){
 const functions=(await db.query(FUNCTION_SQL.replace("p.proname like 'ita_%'","p.proname ~ '^ita_'"))).rows;
 const tables=(await db.query(`select c.relname,pg_get_userbyid(c.relowner) owner,c.relrowsecurity,c.relforcerowsecurity,
 (select coalesce(jsonb_agg(jsonb_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,'grantor',pg_get_userbyid(a.grantor),'privilege',a.privilege_type,'grantable',a.is_grantable) order by case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end,a.privilege_type,pg_get_userbyid(a.grantor)),'[]'::jsonb) from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a) acl
 from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r' and c.relname ~ '^ita_' order by 1`)).rows;
 const columns=(await db.query(`select c.relname,a.attname,format_type(a.atttypid,a.atttypmod) type,a.attnotnull,pg_get_expr(d.adbin,d.adrelid) default_expr,a.attidentity,a.attgenerated,
 (select coalesce(jsonb_agg(jsonb_build_object('grantee',case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,'grantor',pg_get_userbyid(x.grantor),'privilege',x.privilege_type,'grantable',x.is_grantable) order by case when x.grantee=0 then 'PUBLIC' else pg_get_userbyid(x.grantee) end,x.privilege_type,pg_get_userbyid(x.grantor)),'[]'::jsonb) from aclexplode(a.attacl) x) acl
 from pg_attribute a join pg_class c on c.oid=a.attrelid join pg_namespace n on n.oid=c.relnamespace left join pg_attrdef d on d.adrelid=c.oid and d.adnum=a.attnum where n.nspname='public' and c.relkind='r' and c.relname ~ '^ita_' and a.attnum>0 and not a.attisdropped order by c.relname,a.attnum`)).rows;
 const policies=(await db.query("select schemaname,tablename,policyname,permissive,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename ~ '^ita_' order by tablename,policyname")).rows.map(canonicalPolicy);
 const constraints=(await db.query("select c.relname,k.conname,k.contype,k.convalidated,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname ~ '^ita_' order by c.relname,k.conname")).rows;
 const triggers=(await db.query("select c.relname,t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) definition from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname ~ '^ita_' and not t.tgisinternal order by 1,2")).rows;
 return {functions,tables,columns,policies,constraints:canonicalConstraints(constraints,columns),triggers};
}
export function compareRecoveryCatalog(expected,actual){
 const mismatches=[],byId=new Map(actual.functions.map(f=>[f.proname+'|'+f.identity_arguments,f])),classifications={cosmetic:0,metadata:0,semantic:0};
 for(const f of expected.functions){const id=f.proname+'|'+f.identity_arguments,c=compareFunction(f,byId.get(id));if(c.classification==='semantic difference')classifications.semantic++;else if(c.classification==='operational metadata difference')classifications.metadata++;else classifications.cosmetic++;if(c.classification!=='cosmetic/rendering only')mismatches.push({function:id,...c});byId.delete(id);}
 for(const id of byId.keys())mismatches.push({function:id,reason:'unexpected restored function'});
 for(const k of ['tables','columns','policies','constraints','triggers'])if(!equal(expected[k],actual[k]))mismatches.push({catalog:k,reason:'structured catalog differs'});
 return {mismatches,classifications};
}
