import {test} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';import {DEFAULT_ACL_SQL,defaultACLHash,publicDefaults,protectedDefaults,exactDefaultAlignment} from './ops-default-acl.mjs';
test('target alignment removes only 24 authorized postgres/public extras; inverse restores complete baseline',async()=>{
 const db=new PGlite();try{await db.exec(`create role anon;create role authenticated;create role service_role;create role supabase_admin;create schema other;
 ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres,anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres,anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON TABLES TO postgres,anon,authenticated,service_role;
 ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON TABLES TO postgres,anon;
 ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA other GRANT SELECT ON TABLES TO anon;`);
 const before=(await db.query(DEFAULT_ACL_SQL)).rows,extra=r=>r.owner_role==='postgres'&&r.namespace==='public'&&['anon','authenticated','service_role'].includes(r.grantee)&&({S:['SELECT','UPDATE','USAGE'],f:['EXECUTE'],r:['SELECT','INSERT','UPDATE','DELETE']}[r.object_type]||[]).includes(r.privilege),desired=publicDefaults(before).filter(r=>!extra(r));
 const a=exactDefaultAlignment(desired,publicDefaults(before));assert.equal(a.extra.length,24);assert.equal(a.revoke.length,9);assert.ok(a.revoke.every(s=>!s.includes('REVOKE ALL')&&s.includes('FOR ROLE "postgres" IN SCHEMA "public"')));
 for(const sql of a.revoke)await db.exec(sql);const after=(await db.query(DEFAULT_ACL_SQL)).rows;assert.equal(defaultACLHash(publicDefaults(after)),defaultACLHash(desired));assert.equal(defaultACLHash(protectedDefaults(after)),defaultACLHash(protectedDefaults(before)));
 for(const sql of a.inverse)await db.exec(sql);assert.equal(defaultACLHash((await db.query(DEFAULT_ACL_SQL)).rows),defaultACLHash(before));
 assert.throws(()=>exactDefaultAlignment(desired,[...publicDefaults(before),{owner_role:'supabase_admin',namespace:'public',object_type:'f',grantee:'authenticated',privilege:'TRIGGER',grant_option:false,grantor:'supabase_admin'}]),/OUTSIDE_AUTHORIZATION/);
 assert.throws(()=>exactDefaultAlignment(desired,publicDefaults(before).map(r=>extra(r)?{...r,grant_option:true}:r)),/OUTSIDE_AUTHORIZATION/);
 }finally{await db.close();}
});
