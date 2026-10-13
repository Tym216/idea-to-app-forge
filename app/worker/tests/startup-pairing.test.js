import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {assertKeyProject} from '../../shared/environment.js';

test('actual startup awaits environment guard and read-only pairing/schema gate before every claim/mutation loop',()=>{
 const source=readFileSync(new URL('../src/index.js',import.meta.url),'utf8');
 const main=source.slice(source.indexOf('async function main()'));
 const guard=main.indexOf('const missing = assertRunnable()');
 const gate=main.indexOf('await checkWorkspaceSchema()');
 const loop=main.indexOf('while (!stopping)');
 assert.ok(guard>=0 && gate>guard && loop>gate);
 for(const call of ['const deletion = await processOneDeletion(', 'const recovery = await processOnePreviewRecovery(', "await admin.rpc('ita_purge_audit_log'", 'const task = await claimTask()'])
  assert.ok(main.indexOf(call)>gate,call);
 const clientSource=readFileSync(new URL('../src/supabase.js',import.meta.url),'utf8');
 assert.ok(clientSource.indexOf('JSON.stringify(assertWorkerEnvironment())')<clientSource.indexOf('createClient(config.supabaseUrl, config.supabaseServiceRoleKey'));
 for(const key of ['sb_secret_offline_demo','sb_publishable_offline_demo']) assert.doesNotThrow(()=>assertKeyProject(key,'abcdefghijklmnopqrst'));
 // Opaque key parsing proves nothing about pairing; actual API permission is still required.
});
test('opaque-key SDK preflight uses guarded URL + configured apikey; HTTP/auth failure prevents success; no claim or mutation sent',async()=>{
 const {config}=await import('../src/config.js');
 Object.assign(config,{environmentId:'atoms-demo',expectedSupabaseProjectRef:'abcdefghijklmnopqrst',
  supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co',supabaseServiceRoleKey:'sb_secret_offline_demo',envFileExplicit:true});
 const previous=globalThis.fetch;let rejectKey=true;const calls=[];
 globalThis.fetch=async(input,init)=>{
  const req=new Request(input,init);
  assert.equal(new URL(req.url).origin,config.supabaseUrl);
  assert.equal(req.headers.get('apikey'),'sb_secret_offline_demo');
  calls.push({method:req.method,path:new URL(req.url).pathname});
  if(rejectKey)return new Response(JSON.stringify({message:'Invalid API key'}),{status:401,headers:{'content-type':'application/json'}});
  if(req.method==='HEAD')return new Response(null,{status:200});
  assert.equal(req.method,'POST');assert.equal(new URL(req.url).pathname,'/rest/v1/rpc/ita_workspace_read');
  return new Response(JSON.stringify({code:'P0001',message:'LEASE_LOST'}),{status:400,headers:{'content-type':'application/json'}});
 };
 try {
  const {checkWorkspaceSchema}=await import('../src/supabase.js');
  await assert.rejects(checkWorkspaceSchema(),{code:'SUPABASE_STATE'});
  rejectKey=false;await checkWorkspaceSchema();
  assert.equal(calls.filter(c=>c.method==='POST').length,1);
  assert.ok(calls.every(c=>c.method==='HEAD'||c.path==='/rest/v1/rpc/ita_workspace_read'));
 }finally{globalThis.fetch=previous;}
});
test('public opaque key cannot pass service-only read preflight merely because table metadata is readable',async()=>{
 const {checkWorkspaceSchema}=await import('../src/supabase.js');
 const client={from:()=>({select:()=>({limit:async()=>({error:null})})}),
  rpc:async()=>({error:{code:'42501',message:'permission denied for function ita_workspace_read'}})};
 await assert.rejects(checkWorkspaceSchema(client),{code:'SUPABASE_STATE'});
});
