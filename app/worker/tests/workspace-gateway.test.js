import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { sourceManifest } from '../src/managed-source.js';
const exec = promisify(execFile);
async function fixture(t) {
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'forge-workspace-'));
 t.after(()=>fs.rm(root,{recursive:true,force:true}));
 const dir=path.join(root,'.forge-workspace'); await fs.mkdir(dir);
 await fs.copyFile(new URL('../src/managed-source.js',import.meta.url),path.join(dir,'managed-source.mjs'));
 await fs.copyFile(new URL('../src/workspace-gateway.mjs',import.meta.url),path.join(dir,'run.mjs'));
 const writer={epoch:1,token:randomUUID()};
 async function run(mode,extras={},w=writer,nonblocking=false) {
  const spec=path.join(dir,randomUUID()+'.json');
  if (extras.files) extras={...extras,target_hash:sourceManifest(extras.files).code_hash};
  await fs.writeFile(spec,JSON.stringify({root,mode,operation_id:randomUUID(),...w,...extras}));
  let stdout=''; try {({stdout}=await exec('flock',[nonblocking?'-n':'-w',...(nonblocking?[]:['2']),path.join(dir,'lock'),'node',path.join(dir,'run.mjs'),spec]));} catch(e) {stdout=e.stdout;}
  const marker='__FORGE_WORKSPACE__',at=stdout.indexOf(marker);
  return at<0?{error:'LOCK_BUSY_OR_NO_RESULT'}:JSON.parse(stdout.slice(at+marker.length));
 }
 await run('activate');
 return {root,dir,writer,run};
}
test('real Linux gateway: partial mutation reconciles recorded target; no live temp files or blind rewrites',async(t)=>{
 const f=await fixture(t),files=[{path:'src/a.ts',content:'A'},{path:'src/b.ts',content:'B'}];
 assert.equal((await f.run('promote',{baseline:[],files,testFailAfter:1})).error,'TEST_PARTIAL');
 assert.equal((await f.run('scan')).manifest.files.length,1);
 const stamp=(await fs.stat(path.join(f.root,'src/a.ts'))).mtimeMs;
 await f.run('retire');
 const next={epoch:2,token:randomUUID()}; await f.run('activate',{},next);
 const result=await f.run('promote',{baseline:[],files},next);
 assert.equal(result.manifest.code_hash,sourceManifest(files).code_hash);
 assert.deepEqual(result.operations.map((c)=>c.path),['src/b.ts']);
 assert.equal((await fs.stat(path.join(f.root,'src/a.ts'))).mtimeMs,stamp);
 assert.equal((await f.run('promote',{baseline:files,files:[]})).error,'WORKSPACE_FENCE_LOST');
 assert.equal((await f.run('activate')).error,'WORKSPACE_FENCE_LOST');
});
test('real gateway: third hash stops without overwrite; deleted files disappear; no-op has zero operations',async(t)=>{
 const f=await fixture(t); const a=[{path:'a.ts',content:'A'}];
 await f.run('promote',{baseline:[],files:a});
 assert.deepEqual((await f.run('promote',{baseline:a,files:a})).operations,[]);
 await fs.writeFile(path.join(f.root,'a.ts'),'external');
 assert.match((await f.run('promote',{baseline:a,files:[{path:'a.ts',content:'B'}]})).error,/CONFLICT/);
 assert.equal(await fs.readFile(path.join(f.root,'a.ts'),'utf8'),'external');
 await fs.writeFile(path.join(f.root,'a.ts'),'A');
 assert.equal((await f.run('promote',{baseline:a,files:[]})).manifest.files.length,0);
});
test('real gateway: complete scan rejects managed symlink/binary; excluded artifacts do not affect hash',async(t)=>{
 const f=await fixture(t);
 const bom=[{path:'bom.ts',content:'\ufeffconst 中 = 1;\r\n'}];
 await f.run('promote',{baseline:[],files:bom});
 assert.equal((await f.run('scan')).manifest.code_hash,sourceManifest(bom).code_hash);
 await f.run('promote',{baseline:bom,files:[]});
 await fs.mkdir(path.join(f.root,'node_modules')); await fs.symlink('/tmp',path.join(f.root,'node_modules/link'));
 assert.equal((await f.run('scan')).manifest.code_hash,sourceManifest([]).code_hash);
 await fs.symlink('/tmp',path.join(f.root,'source-link')); assert.match((await f.run('scan')).error,/SYMLINK/);
 await fs.unlink(path.join(f.root,'source-link')); await fs.writeFile(path.join(f.root,'bad'),Buffer.from([255]));
 assert.ok((await f.run('scan')).error);
});
test('real flock: reconciliation cannot retire while old operation holds stable lock',async(t)=>{
 const f=await fixture(t);
 const child=spawn('flock',[path.join(f.dir,'lock'),'node','-e','process.stdout.write("locked\\n"); setTimeout(()=>{},10000)'], { detached: true });
 t.after(()=>{try {process.kill(-child.pid, 'SIGTERM');}catch {}});
 await new Promise((resolve,reject)=>{child.stdout.once('data',resolve);child.once('error',reject);});
 assert.equal((await f.run('retire',{},f.writer,true)).error,'LOCK_BUSY_OR_NO_RESULT');
 process.kill(-child.pid, 'SIGTERM');
 await new Promise(resolve=>child.once('close',resolve));
});
