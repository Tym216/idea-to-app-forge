import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';
const {checkWorkspaceSchema}=await import('../src/supabase.js');
const {Workspace}=await import('../src/workspace.js');
const {sourceManifest}=await import('../src/managed-source.js');
test('migration preflight only reads schema and refuses missing RPC instead of claiming work',async()=>{
 const calls=[];
 const client={from:(t)=>({select:(_c,opts)=>{assert.equal(opts.head,true);calls.push(t);return {limit:async()=>({error:null})};}}),rpc:async(name)=>{calls.push(name);return {error:{code:'P0001',message:'LEASE_LOST'}};}};
 await checkWorkspaceSchema(client);assert.ok(!calls.some(c=>c.includes('claim')));
 client.rpc=async()=>({error:{code:'PGRST202',message:'Could not find function'}});
 await assert.rejects(checkWorkspaceSchema(client),{code:'SUPABASE_STATE'});
});
test('schema preflight refuses missing immutable submission_basis before runtime can claim User Apply',async()=>{
 let rpcCalls=0;
 const client={from:table=>({select:columns=>({limit:async()=>({
  error:table==='ita_changesets' && columns.includes('submission_basis') ? {code:'42703',message:'column submission_basis does not exist'} : null,
 })})}),rpc:async()=>{rpcCalls++;throw Error('must not reach runtime');}};
 await assert.rejects(checkWorkspaceSchema(client),{code:'SUPABASE_STATE'});
 assert.equal(rpcCalls,0);
});
test('preview initialization cannot absorb/reconcile a paused source mutation',async()=>{
 const manifest=sourceManifest([]);let calls=0;
 const ws=new Workspace({projectId:'p',executionId:'preview',rpc:async(name)=>{calls++;assert.equal(name,'ita_workspace_read');return {data:{files:[],code_hash:manifest.code_hash,revision:0,state:'partial',writer:{kind:'mutation'},pending:[]},error:null};}});
 await assert.rejects(ws.initialize({reconcilePending:false,wake:()=>{throw new Error('must not wake');}}),{code:'WORKSPACE_RECONCILE_REQUIRED'});
 assert.equal(calls,1);
});

test('cached execution basis cannot silently rebase a source write or runtime operation',async()=>{
 const manifest=sourceManifest([]);let calls=0;
 const ws=new Workspace({rpc:async(name)=>{calls++;assert.equal(name,'ita_workspace_read');return {data:{files:[],code_hash:manifest.code_hash,revision:2,state:'confirmed',writer:null,pending:[]},error:null};}});
 ws.state={revision:1};
 await assert.rejects(ws.apply([{operation:'write',path:'a.ts',content:'A'}]),{code:'WORKSPACE_REVISION_CONFLICT'});
 ws.state={revision:1};
 await assert.rejects(ws.runtime('build',()=>{throw new Error('must not execute');}),{code:'WORKSPACE_REVISION_CONFLICT'});
 assert.equal(calls,2);
});

test('install takeover requires a durable returned-command attestation; a timed-out command stays blocked',async()=>{
 const ws=new Workspace({rpc:async()=>{throw new Error('must not reach RPC');}});
 ws.state={writer:{kind:'install',changeset_id:'c'},pending:[{id:'c',origin:'install_drift'}]};
 await assert.rejects(ws.reconcile(),{code:'WORKSPACE_UNCERTAIN'});
});

test('schema preflight refuses missing active App identity before task claims',async()=>{
 const client={from:table=>({select:columns=>({limit:async()=>({error:table==='ita_projects'&&columns.includes('active_app_version_id')?{message:'missing active_app_version_id'}:null})})}),rpc:async()=>{throw Error('must not call RPC after failed catalog read');}};
 await assert.rejects(checkWorkspaceSchema(client),{code:'SUPABASE_STATE'});
});
