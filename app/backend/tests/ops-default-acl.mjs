/** Named, schema-scoped DEFAULT ACL semantics; no rendering/OID comparison or blanket revoke. */
import {fingerprint} from '../../worker/src/managed-source.js';
export const DEFAULT_ACL_SQL=`select r.rolname owner_role,coalesce(n.nspname,'<global>') namespace,d.defaclobjtype object_type,case when a.grantee=0 then 'PUBLIC' else g.rolname end grantee,a.privilege_type privilege,a.is_grantable grant_option,gr.rolname grantor from pg_default_acl d join pg_roles r on r.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace cross join lateral aclexplode(d.defaclacl) a left join pg_roles g on g.oid=a.grantee join pg_roles gr on gr.oid=a.grantor order by owner_role,namespace,object_type,grantee,privilege,grant_option,grantor`;
export const canonicalDefaultACL=rows=>[...rows].sort((a,b)=>JSON.stringify([a.owner_role,a.namespace,a.object_type,a.grantee,a.privilege,a.grant_option,a.grantor]).localeCompare(JSON.stringify([b.owner_role,b.namespace,b.object_type,b.grantee,b.privilege,b.grant_option,b.grantor]),'en'));
export const defaultACLHash=rows=>fingerprint(canonicalDefaultACL(rows));
export const publicDefaults=rows=>rows.filter(r=>r.namespace==='public'||r.namespace==='<global>');
const scope=r=>r.owner_role==='postgres'&&r.namespace==='public'&&['S','f','r'].includes(r.object_type);
const allowed={S:['SELECT','UPDATE','USAGE'],f:['EXECUTE'],r:['SELECT','INSERT','UPDATE','DELETE']};
const id=r=>fingerprint(r);const qi=s=>'"'+s.replaceAll('"','""')+'"';
export function exactDefaultAlignment(source,target){
 const wanted=new Set(source.map(id)),current=new Set(target.map(id)),extra=target.filter(r=>!wanted.has(id(r))),missing=source.filter(r=>!current.has(id(r)));
 if(missing.length||extra.length!==24||extra.some(r=>!scope(r)||!['anon','authenticated','service_role'].includes(r.grantee)||!allowed[r.object_type].includes(r.privilege)||r.grant_option||r.grantor!=='postgres'))throw new Error('DEFAULT_ALIGNMENT_OUTSIDE_AUTHORIZATION');
 const groups=new Map();for(const r of extra){const key=[r.object_type,r.grantee].join('|');(groups.get(key)||groups.set(key,[]).get(key)).push(r.privilege);}
 if(groups.size!==9)throw new Error('DEFAULT_ALIGNMENT_UNEXPECTED_DIFF');
 const revoke=[],inverse=[];
 for(const [key,privileges] of [...groups].sort()){const [type,grantee]=key.split('|'),object={S:'SEQUENCES',f:'FUNCTIONS',r:'TABLES'}[type],p=privileges.sort().join(', '),base=`ALTER DEFAULT PRIVILEGES FOR ROLE "postgres" IN SCHEMA "public"`;
  revoke.push(`${base} REVOKE ${p} ON ${object} FROM ${qi(grantee)};`);inverse.push(`${base} GRANT ${p} ON ${object} TO ${qi(grantee)};`);
 }
 return {extra,revoke,inverse};
}
export const protectedDefaults=rows=>rows.filter(r=>!scope(r));
export async function sequenceStates(db){
 const defs=(await db.query("select n.nspname namespace,c.relname name,r.rolname owner_role,format_type(s.seqtypid,null) data_type,s.seqstart::text start,s.seqincrement::text increment,s.seqmin::text min,s.seqmax::text max,s.seqcache::text cache,s.seqcycle cycle from pg_sequence s join pg_class c on c.oid=s.seqrelid join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner where n.nspname in ('public','auth') order by n.nspname,c.relname")).rows;
 const rows=[];for(const d of defs)rows.push({...d,...(await db.query(`select last_value::text last_value,is_called from ${qi(d.namespace)}.${qi(d.name)}`)).rows[0]});return rows;
}
export async function retryResidue(db){
 const objects=(await db.query("select (select count(*)::int from pg_tables where schemaname='public') public_tables,(select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public') public_functions,(select count(*)::int from storage.objects) storage_objects,(select count(*)::int from storage.buckets) storage_buckets")).rows[0];
 const tables=(await db.query("select tablename from pg_tables where schemaname='auth' and tablename<>'schema_migrations' order by tablename")).rows;
 let authRows=0;for(const t of tables)authRows+=Number((await db.query(`select count(*)::text n from auth.${qi(t.tablename)}`)).rows[0].n);
 const sequences=await sequenceStates(db),s=sequences[0];
 if(Object.values(objects).some(n=>n!==0)||authRows!==0||sequences.length!==1||s.namespace!=='auth'||s.name!=='refresh_tokens_id_seq'||s.last_value!=='146'||s.is_called!==true)throw new Error('UNEXPECTED_RETRY_RESIDUE');
 return {objects,auth_data_rows:authRows,sequences,original_pre_first_restore_sequence_state:'UNKNOWN; not fabricated',sequence_reset:false};
}
