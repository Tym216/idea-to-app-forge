import {createHash} from 'node:crypto';
import {types} from 'pg';

export const FUNCTION_SQL = `select p.proname,pg_get_function_identity_arguments(p.oid) identity_arguments,
 pg_get_function_arguments(p.oid) arguments,pg_get_function_result(p.oid) return_type,l.lanname language,
 p.provolatile volatility,p.proisstrict strict,p.prosecdef security_definer,p.proparallel parallel,p.proleakproof leakproof,
 p.prokind kind,p.proretset returns_set,to_json(p.proconfig) proconfig,r.rolname owner,p.prosrc body,
 pg_get_functiondef(p.oid) rendered_definition,
 (select coalesce(json_agg(json_build_object('grantee',case when a.grantee=0 then 'PUBLIC' else gr.rolname end,'grantor',gt.rolname,'grantable',a.is_grantable) order by a.grantee,a.grantor),'[]'::json)
 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a left join pg_roles gr on gr.oid=a.grantee left join pg_roles gt on gt.oid=a.grantor where a.privilege_type='EXECUTE') execute_acl,
 json_build_object('anon',has_function_privilege('anon',p.oid,'EXECUTE'),'authenticated',has_function_privilege('authenticated',p.oid,'EXECUTE'),'service_role',has_function_privilege('service_role',p.oid,'EXECUTE')) effective_execute
 from pg_proc p join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang join pg_roles r on r.oid=p.proowner
 where n.nspname='public' and p.proname like 'ita_%' order by p.proname,identity_arguments`;

const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const equal=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
export const hash=v=>createHash('sha256').update(typeof v==='string'?v:JSON.stringify(stable(v))).digest('hex');

/** Normalize transport EOL only outside quoted SQL literals/identifiers; never delete tokens/whitespace/comments. */
export function canonicalBody(src) {
 const s=String(src);let out='',i=0,state='code',depth=0,tag='';
 while(i<s.length){
  const ch=s[i],next=s[i+1];
  if(state==='quote'||state==='identifier'){
   const delim=state==='quote'?"'":'"';out+=ch;i++;
   if(ch===delim&&s[i]===delim){out+=s[i++];continue;}
   if(ch==='\\'&&state==='quote'&&i<s.length){out+=s[i++];continue;}
   if(ch===delim)state='code';continue;
  }
  if(state==='dollar'){if(s.startsWith(tag,i)){out+=tag;i+=tag.length;state='code';}else{out+=ch;i++;}continue;}
  if(state==='line'){if(ch==='\r'&&next==='\n'){out+='\n';i+=2;state='code';}else{out+=ch;i++;if(ch==='\n')state='code';}continue;}
  if(state==='block'){
   if(ch==='/'&&next==='*'){out+='/*';i+=2;depth++;continue;}
   if(ch==='*'&&next==='/'){out+='*/';i+=2;if(--depth===0)state='code';continue;}
   if(ch==='\r'&&next==='\n'){out+='\n';i+=2;}else{out+=ch;i++;}continue;
  }
  if(ch==="'"){state='quote';out+=ch;i++;continue;}
  if(ch==='"'){state='identifier';out+=ch;i++;continue;}
  if(ch==='-'&&next==='-'){state='line';out+='--';i+=2;continue;}
  if(ch==='/'&&next==='*'){state='block';depth=1;out+='/*';i+=2;continue;}
  if(ch==='$'){const m=/^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));if(m){tag=m[0];out+=tag;i+=tag.length;state='dollar';continue;}}
  if(ch==='\r'&&next==='\n'){out+='\n';i+=2;}else{out+=ch;i++;}
 }
 return out;
}

const semanticFields=['identity_arguments','arguments','return_type','language','volatility','strict','security_definer','parallel','leakproof','kind','returns_set','proconfig'];
const metadataFields=['owner','execute_acl','effective_execute'];
const canonicalACL=v=>[...(v||[])].sort((a,b)=>(JSON.stringify(stable(a))<JSON.stringify(stable(b))?-1:JSON.stringify(stable(a))>JSON.stringify(stable(b))?1:0));
export function compareFunction(expected,actual){
 if(!expected||!actual)return {classification:'semantic difference',changed:['presence']};
 const changes=[];
 for(const key of semanticFields)if(!equal(expected[key],actual[key]))changes.push(key);
 if(canonicalBody(expected.body)!==canonicalBody(actual.body))changes.push('body');
 const metadata=metadataFields.filter(key=>!equal(key==='execute_acl'?canonicalACL(expected[key]):expected[key],key==='execute_acl'?canonicalACL(actual[key]):actual[key]));
 return {classification:changes.length?'semantic difference':metadata.length?'operational metadata difference':'cosmetic/rendering only',changed:changes,metadata_changed:metadata,
  body_equal_after_safe_EOL:canonicalBody(expected.body)===canonicalBody(actual.body),raw_definition_equal:expected.rendered_definition===actual.rendered_definition};
}
export function functionFingerprint(f){
 return hash({...Object.fromEntries([...semanticFields,...metadataFields].map(k=>[k,k==='execute_acl'?canonicalACL(f[k]):f[k]])),body:canonicalBody(f.body)});
}
export function canonicalPolicy(p){return {...p,roles:[...(typeof p.roles==='string'?types.getTypeParser(1009)(p.roles):p.roles)].sort()};}
/** PG versions differ in separate NOT NULL catalog entries; column attnotnull remains mandatory evidence. */
export function canonicalConstraints(constraints,columns){
 if(!Array.isArray(columns)||columns.some(c=>typeof c.attnotnull!=='boolean'))throw new Error('COLUMN_NULLABILITY_EVIDENCE_REQUIRED');
 const derived=c=>c.convalidated!==false&&columns.some(col=>col.relname===c.relname&&col.attnotnull===true&&[col.attname,'"'+col.attname.replaceAll('"','""')+'"'].some(name=>c.definition==='NOT NULL '+name));
 return {constraints:constraints.filter(c=>!derived(c)),not_null:columns.map(c=>({table:c.relname,column:c.attname,not_null:c.attnotnull})).sort((a,b)=>a.table+'|'+a.column<b.table+'|'+b.column?-1:a.table+'|'+a.column>b.table+'|'+b.column?1:0)};
}

/** Whole-body unified diff after the same safe EOL rule; attributes are compared separately. */
export function unifiedBodyDiff(expected,actual,label='function') {
 const left=canonicalBody(expected),right=canonicalBody(actual);
 if(left===right)return '';
 const lines=t=>{const a=t.split('\n');if(t.endsWith('\n'))a.pop();return a;};
 const a=lines(left),b=lines(right);
 const block=(ls,prefix,finalNewline)=>ls.map(l=>prefix+l+'\n').join('')+(finalNewline?'':'\\ No newline at end of file\n');
 return `--- local/${label}\n+++ main/${label}\n@@ -1,${a.length} +1,${b.length} @@\n`+block(a,'-',left.endsWith('\n'))+block(b,'+',right.endsWith('\n'));
}
