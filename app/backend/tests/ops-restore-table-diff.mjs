/** Failure evidence only: restore target READ ONLY; no repair/retry. */
import {operationalConnect,operationalRoot} from './ops-db-target.mjs';import {recoveryCatalog} from './ops-recovery-catalog.mjs';import {fingerprint} from '../../worker/src/managed-source.js';import {readFileSync,writeFileSync} from 'node:fs';import path from 'node:path';
const dir=path.join(operationalRoot,'app/worker/.cutover/restore-plans/main-T0-20261008-01-derived-02'),backup=path.join(operationalRoot,'app/worker/.cutover/backups/main-T0-20261008-01');let db;
try{
 const manifest=JSON.parse(readFileSync(path.join(backup,'manifest.json'),'utf8')),target=await operationalConnect('restore');db=target.db;
 const catalog=await recoveryCatalog(db),actual=new Map(catalog.tables.map(t=>[t.relname,t])),diff=[];
 for(const expected of manifest.catalog.tables){const got=actual.get(expected.relname);if(fingerprint(expected)!==fingerprint(got)){
  const ea=new Set(expected.acl.map(fingerprint)),ga=new Set(got.acl.map(fingerprint));
  diff.push({table:expected.relname,expected,actual:got,missing_acl:expected.acl.filter(a=>!ga.has(fingerprint(a))),extra_acl:got.acl.filter(a=>!ea.has(fingerprint(a))),other_fields_equal:fingerprint({...expected,acl:[]})===fingerprint({...got,acl:[]})});
 }}
 writeFileSync(path.join(dir,'table-catalog-diff.json'),JSON.stringify({status:'FAIL',target_ref:target.config.ref,captured_at:new Date().toISOString(),read_only:true,differences:diff},null,2)+'\n',{mode:0o600,flag:'wx'});
 console.log(JSON.stringify({status:'FAIL',tables:diff.map(({table,missing_acl,extra_acl,other_fields_equal})=>({table,missing_acl,extra_acl,other_fields_equal})),repair_attempted:false}));
}catch(e){console.log(JSON.stringify({status:'FAIL',error_type:e.code||e.message}));process.exitCode=1;}finally{if(db){await db.query('ROLLBACK');await db.end();}}
