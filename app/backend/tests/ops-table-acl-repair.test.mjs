import {test} from 'node:test';import assert from 'node:assert/strict';import {PGlite} from '@electric-sql/pglite';
import {recoveryCatalog} from './ops-recovery-catalog.mjs';import {tableACLDelta,tableACLHash,exactTableACLRepair,normalizeTableACL} from './ops-table-acl-repair.mjs';
import {DEFAULT_ACL_SQL,defaultACLHash} from './ops-default-acl.mjs';
async function setup(){const db=new PGlite();await db.exec('create role anon;create role authenticated;create role service_role;');
 for(let i=0;i<13;i++)await db.exec(`create table public.ita_test${i}(id int,value text);alter table public.ita_test${i} enable row level security;create policy own on public.ita_test${i} for select to authenticated using(true);grant select,insert,update,delete on table public.ita_test${i} to service_role;grant select(id) on public.ita_test${i} to authenticated;`);
 const expected=await recoveryCatalog(db);for(const t of expected.tables)await db.exec(`grant MAINTAIN,REFERENCES,TRIGGER,TRUNCATE on table public.${t.relname} to anon,authenticated;`);
 return {db,expected,actual:await recoveryCatalog(db)};
}
test('exact ACL normalization removes 104 actual extras, preserves RLS/column/service-role/default ACL, inverse restores original state',async()=>{
 const {db,expected,actual}=await setup();try{
  const repair=exactTableACLRepair(expected.tables,actual.tables);assert.equal(repair.revoke.length,104);assert.ok(repair.revoke.every(s=>!s.includes('ALL')&&!s.includes('SCHEMA')&&!s.includes('service_role')));
  const defaults=defaultACLHash((await db.query(DEFAULT_ACL_SQL)).rows);await db.exec('BEGIN');const r=await normalizeTableACL(db,expected.tables,repair);assert.equal(r.missing+r.extra,0);await db.exec('COMMIT');
  assert.deepEqual(tableACLDelta(expected.tables,(await recoveryCatalog(db)).tables),{missing:[],extra:[]});assert.equal(defaultACLHash((await db.query(DEFAULT_ACL_SQL)).rows),defaults);
  for(const s of repair.inverse)await db.exec(s);assert.equal(tableACLHash((await recoveryCatalog(db)).tables),tableACLHash(actual.tables));
  assert.equal(tableACLHash([...actual.tables].reverse().map(t=>({...t,acl:[...t.acl].reverse()}))),tableACLHash(actual.tables));
 }finally{await db.close();}
});
test('ACL repair refuses missing grants, service-role/unknown extras, metadata drift and stale precondition',async()=>{
 const {db,expected,actual}=await setup();try{
  const repair=exactTableACLRepair(expected.tables,actual.tables),cases=[a=>{a[0].acl.push({grantee:'service_role',grantor:'postgres',privilege:'TRUNCATE',grantable:false});},a=>{a[0].acl=a[0].acl.filter(r=>r.grantee!=='service_role');},a=>{a[0].owner='anon';},a=>{a[0].acl.find(r=>r.grantee==='anon').grantable=true;},a=>{a.pop();}];
  for(const change of cases){const a=structuredClone(actual.tables);change(a);assert.throws(()=>exactTableACLRepair(expected.tables,a));}
  await db.exec('BEGIN');await assert.rejects(()=>normalizeTableACL(db,expected.tables,{...repair,pre_repair_acl_hash:'stale'}),/PRECONDITION_CHANGED/);await db.exec('ROLLBACK');assert.equal(tableACLHash((await recoveryCatalog(db)).tables),repair.pre_repair_acl_hash);
 }finally{await db.close();}
});
test('failed post-write ACL comparison rolls back every revoke instead of committing a partial repair',async()=>{
 const {db,expected,actual}=await setup();try{
  const repair=exactTableACLRepair(expected.tables,actual.tables);let tableReads=0;
  const gateway={query:async(sql,...args)=>{const result=await db.query(sql,...args);if(sql.startsWith('select c.relname,pg_get_userbyid(c.relowner) owner')&&++tableReads===2){result.rows=structuredClone(result.rows);result.rows[0].acl.push({grantee:'service_role',grantor:'postgres',privilege:'TRUNCATE',grantable:false});}return result;}};
  await db.exec('BEGIN');await assert.rejects(()=>normalizeTableACL(gateway,expected.tables,repair),/TRANSACTION_COMPARE_FAILED/);await db.exec('ROLLBACK');
  assert.equal(tableACLHash((await recoveryCatalog(db)).tables),repair.pre_repair_acl_hash);
 }finally{await db.close();}
});
