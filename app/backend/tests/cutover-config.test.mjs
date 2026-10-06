import {test} from 'node:test';
import assert from 'node:assert/strict';
import {loadCutoverConfig,safeErrorCode} from './cutover-config.mjs';
const ref='a'.repeat(20),primaryRef='b'.repeat(20);
const jwt=(role,r=ref)=>'test.'+Buffer.from(JSON.stringify({ref:r,role,exp:4102444800})).toString('base64url')+'.test';
const primarySource=`SUPABASE_URL=https://${primaryRef}.supabase.co\n`;
const source=(changes={})=>Object.entries({CUTOVER_SUPABASE_URL:`https://${ref}.supabase.co`,CUTOVER_SUPABASE_SERVICE_ROLE_KEY:jwt('service_role'),CUTOVER_SUPABASE_ANON_KEY:jwt('anon'),CUTOVER_DATABASE_URL:`postgresql://postgres.${ref}:test-only@aws-0-test.pooler.supabase.com:5432/postgres?sslmode=require`,...changes}).map(([k,v])=>`${k}=${v}`).join('\n');
test('cutover target is file-only and cannot silently inherit main/process credentials',()=>{
 const prev=process.env.CUTOVER_SUPABASE_URL;process.env.CUTOVER_SUPABASE_URL=`https://${primaryRef}.supabase.co`;
 try{const cfg=loadCutoverConfig({source:source(),primarySource});assert.equal(cfg.projectRef,ref);assert.equal(cfg.databaseRef,ref);}finally{if(prev===undefined)delete process.env.CUTOVER_SUPABASE_URL;else process.env.CUTOVER_SUPABASE_URL=prev;}
});
test('primary project, cross-project keys, wrong public role and duplicate entries stop before any network operation',()=>{
 for(const [src,code] of [
  [source({CUTOVER_SUPABASE_URL:`https://${primaryRef}.supabase.co`}),'PRIMARY_PROJECT_FORBIDDEN'],
  [source({CUTOVER_SUPABASE_ANON_KEY:jwt('anon',primaryRef)}),'PROJECT_REF_MISMATCH'],
  [source({CUTOVER_SUPABASE_ANON_KEY:jwt('service_role')}),'ROLE_MISMATCH'],
  [source()+'\nCUTOVER_SUPABASE_ANON_KEY=duplicate','DUPLICATE_OR_INVALID_ENV_ENTRY'],
  [source({CUTOVER_DATABASE_URL:`postgresql://postgres.${primaryRef}:test-only@aws-0-test.pooler.supabase.com:5432/postgres`}), 'DATABASE_PROJECT_REF_MISMATCH'],
 ])assert.throws(()=>loadCutoverConfig({source:src,primarySource}),{code});
});
test('TLS disabling is rejected; URL cannot silently override the driver SSL mode',()=>{
 const base=`postgresql://postgres:test-only@db.${ref}.supabase.co:5432/postgres`;
 assert.throws(()=>loadCutoverConfig({source:source({CUTOVER_DATABASE_URL:base+'?sslmode=disable'}),primarySource}),{code:'TLS_REQUIRED'});
 assert.equal(new URL(loadCutoverConfig({source:source({CUTOVER_DATABASE_URL:base+'?sslmode=verify-full'}),primarySource}).databaseUrl).searchParams.has('sslmode'),false);
});
test('connection error reporting returns safe categories rather than raw connection strings',()=>{
 assert.equal(safeErrorCode({code:'28P01',message:'private'}),'28P01');assert.equal(safeErrorCode({message:'connection timeout private'}),'CONNECTION_TIMEOUT');
});
