/** Main is strictly read-only. Formal migrations run only in local PGlite. No restore/cutover environment fallback. */
import {readFileSync,writeFileSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {PGlite} from '@electric-sql/pglite';
import {connectOperational} from './ops-ingress-gate.mjs';
import {FUNCTION_SQL,compareFunction,functionFingerprint,canonicalPolicy,canonicalConstraints,equal,unifiedBodyDiff,hash} from './baseline-comparator.mjs';
const root=fileURLToPath(new URL('../../../',import.meta.url));
const dir=path.join(root,'app/worker/.cutover/main-baseline-reconciliation-2026-10-08');
const report=o=>console.log(JSON.stringify(o));let db,local;
try {
 ({db}=await connectOperational('main',{ackMain:true}));await db.query('BEGIN TRANSACTION READ ONLY');
 local=new PGlite();
 await local.exec(`create schema auth;create table auth.users(id uuid primary key,email text);
 create function auth.uid() returns uuid language sql stable as $$select (nullif(current_setting('request.jwt.claims',true),'')::jsonb->>'sub')::uuid$$;
 create role anon nologin;create role authenticated nologin;create role service_role nologin bypassrls;
 grant usage on schema auth to anon,authenticated,service_role;grant select on auth.users to anon,authenticated,service_role;
 grant execute on function auth.uid() to anon,authenticated,service_role;`);
 for(const f of ['0001_init.sql','0002_plan_review.sql','0003_deletion_retention.sql','0004_task_pause.sql','0005_preview_recovery.sql'])await local.exec(readFileSync(path.join(root,'app/backend/migrations',f),'utf8'));
 const actual=(await db.query(FUNCTION_SQL)).rows,expected=(await local.query(FUNCTION_SQL)).rows;
 const key=f=>f.proname+'('+f.identity_arguments+')';const a=new Map(actual.map(f=>[key(f),f])),b=new Map(expected.map(f=>[key(f),f]));
 const functions=[...new Set([...a.keys(),...b.keys()])].sort().map(id=>({id,...compareFunction(b.get(id),a.get(id)),actual_fingerprint:a.has(id)?functionFingerprint(a.get(id)):null,expected_fingerprint:b.has(id)?functionFingerprint(b.get(id)):null}));
 const effectiveSQL=`select c.relname,p.privilege,has_table_privilege('service_role',c.oid,p.privilege) effective,
 r.rolname owner,pg_has_role('service_role',c.relowner,'USAGE') effective_owner_role
 from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_roles r on r.oid=c.relowner
 cross join (select unnest(array['TRUNCATE','TRIGGER','REFERENCES']) privilege) p
 where n.nspname='public' and c.relkind='r' and c.relname like 'ita_%' order by c.relname,p.privilege`;
 const effective=(await db.query(effectiveSQL)).rows,expectedEffective=(await local.query(effectiveSQL)).rows;
 const grants=(await db.query(`select c.relname,g.privilege_type,case when g.grantee=0 then 'PUBLIC' else gr.rolname end grantee,gt.rolname grantor,g.is_grantable
 from pg_class c join pg_namespace n on n.oid=c.relnamespace cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) g
 left join pg_roles gr on gr.oid=g.grantee left join pg_roles gt on gt.oid=g.grantor
 where n.nspname='public' and c.relname like 'ita_%' and g.privilege_type in ('TRUNCATE','TRIGGER','REFERENCES') order by c.relname,grantee,g.privilege_type`)).rows;
 const defaults=(await db.query(`select r.rolname creator,coalesce(n.nspname,'GLOBAL') schema_name,d.defaclobjtype object_type,
 case when g.grantee=0 then 'PUBLIC' else gr.rolname end grantee,gt.rolname grantor,g.privilege_type,g.is_grantable
 from pg_default_acl d join pg_roles r on r.oid=d.defaclrole left join pg_namespace n on n.oid=d.defaclnamespace
 cross join lateral aclexplode(d.defaclacl) g left join pg_roles gr on gr.oid=g.grantee left join pg_roles gt on gt.oid=g.grantor
 where d.defaclobjtype='r' and (d.defaclnamespace=0 or n.nspname='public') and g.privilege_type in ('TRUNCATE','TRIGGER','REFERENCES') order by creator,schema_name,grantee,g.privilege_type`)).rows;
 const membership=(await db.query(`with recursive ancestors as (
 select oid,rolname,rolinherit,0 depth from pg_roles where rolname='service_role'
 union all select p.oid,p.rolname,p.rolinherit,a.depth+1 from ancestors a join pg_auth_members m on m.member=a.oid join pg_roles p on p.oid=m.roleid where a.depth<8)
 select distinct rolname,rolinherit,depth,pg_has_role('service_role',oid,'USAGE') effective_usage from ancestors order by depth,rolname`)).rows;
 const columnsSQL=`select c.relname,a.attname,a.attnotnull from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where n.nspname='public' and c.relkind='r' and c.relname like 'ita_%' and a.attnum>0 and not a.attisdropped order by c.relname,a.attname`;
 const constraintsSQL=`select c.relname,k.conname,k.contype,k.convalidated,k.condeferrable,k.condeferred,pg_get_constraintdef(k.oid) definition from pg_constraint k join pg_class c on c.oid=k.conrelid join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname like 'ita_%' order by c.relname,k.conname`;
 const policySQL=`select tablename,policyname,roles,cmd,qual,with_check from pg_policies where schemaname='public' and tablename like 'ita_%' order by tablename,policyname`;
 const columns=(await db.query(columnsSQL)).rows,wantColumns=(await local.query(columnsSQL)).rows;
 const constraints=(await db.query(constraintsSQL)).rows,wantConstraints=(await local.query(constraintsSQL)).rows;
 const policies=(await db.query(policySQL)).rows,wantPolicies=(await local.query(policySQL)).rows;
 const canonical={columns_match:equal(columns,wantColumns),constraints_match:equal(canonicalConstraints(constraints,columns),canonicalConstraints(wantConstraints,wantColumns)),policies_match:equal(policies.map(canonicalPolicy),wantPolicies.map(canonicalPolicy))};
 const identity=(await db.query("select current_database() database,pg_backend_pid() pid,current_setting('transaction_read_only') read_only,current_setting('server_version') server_version")).rows[0];
 const localVersion=(await local.query("select current_setting('server_version') version")).rows[0].version;
 if(identity.read_only!=='on')throw new Error('READ_ONLY_REQUIRED');
 await db.query('ROLLBACK');
 mkdirSync(dir,{recursive:true,mode:0o700});
 for(const f of functions)if(f.changed.includes('body')&&a.has(f.id)&&b.has(f.id))writeFileSync(path.join(dir,hash(f.id)+'.body.diff'),unifiedBodyDiff(b.get(f.id).body,a.get(f.id).body,f.id),{mode:0o600});
 writeFileSync(path.join(dir,'evidence.json'),JSON.stringify({project_ref:'vfzyimhapttcdxeabvur',identity,tls_verified:true,localVersion,functions,actual,expected,effective,expectedEffective,grants,defaults,membership,canonical},null,2),{mode:0o600});
 report({step:'function structured baseline',status:functions.some(f=>f.classification!=='cosmetic/rendering only')?'FAIL':'PASS',counts:Object.fromEntries(['cosmetic/rendering only','operational metadata difference','semantic difference'].map(c=>[c,functions.filter(f=>f.classification===c).length])),items:functions.map(({id,classification,changed,metadata_changed,body_equal_after_safe_EOL})=>({id,classification,changed,metadata_changed,body_equal_after_safe_EOL}))});
 report({step:'canonical constraints/policies',...canonical,main_pg:identity.server_version,local_pg:localVersion});
 report({step:'service-role effective privileges',tables:[...new Set(effective.map(r=>r.relname))].map(name=>({table:name,privileges:effective.filter(r=>r.relname===name),direct_grants:grants.filter(r=>r.relname===name&&r.grantee==='service_role')})),current_defaults:defaults.filter(r=>r.grantee==='service_role'),membership,origin_limit:'catalog proves current direct grants/default ACL, not historical grant provenance'});
 const authority=new Set(['ita_projects','ita_files','ita_snapshots','ita_changesets','ita_tasks','ita_plans','ita_plan_feedback']);
 const unsafe=effective.filter(p=>authority.has(p.relname)&&p.effective);
 const failed=functions.some(f=>f.classification!=='cosmetic/rendering only')||Object.values(canonical).some(v=>!v)||unsafe.length>0;
 report({step:'main baseline reconciliation',status:failed?'FAIL':'PASS',unsafe_authority_privileges:unsafe.map(p=>({table:p.relname,privilege:p.privilege})),record:'app/worker/.cutover/main-baseline-reconciliation-2026-10-08/evidence.json',main_modified:false,reason:unsafe.length?'unneeded authority privileges remain; no platform allowlist':'structured comparison'});
 if(failed)process.exitCode=1;
}catch(e){report({status:'FAIL',error_type:typeof e.code==='string'?e.code:'RECONCILIATION_ERROR'});process.exitCode=1;}
finally{if(db){await db.query('ROLLBACK').catch(()=>{});await db.end();}if(local)await local.close();}
