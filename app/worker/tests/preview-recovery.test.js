import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test';
const { recoverExistingPreview, processOnePreviewRecovery } = await import('../src/preview-recovery.js');

function provider(state = 'stopped', readyInitially = false) {
  const calls = [];
  let ready = readyInitially;
  return {
    calls, cache: new Map(),
    configureIdle: async () => {},
    client: { get: async (id) => { calls.push(['get', id]); return { id, state }; }, start: async () => calls.push(['start']) },
    exec: async () => ({ stdout: ready ? '200' : '000' }),
    isPortListening: async () => false,
    startBackground: async (id, cmd) => { calls.push(['dev', id, cmd]); ready = true; },
    previewUrl: async () => 'https://preview.test/',
    create: async () => { throw new Error('must never create'); },
  };
}
test('stopped sandbox: start existing, restart dev, refresh preview without creating sandbox', async () => {
  const p = provider(); const phases = [];
  assert.equal(await recoverExistingPreview(p, 'saved', async (s) => phases.push(s), async () => {}), 'https://preview.test/');
  assert.deepEqual(p.calls.map((c) => c[0]), ['get', 'start', 'dev']);
  assert.equal(p.calls[2][1], 'saved');
  assert.ok(p.calls[2][2].includes('--strictPort'));
  assert.deepEqual(phases, ['checking', 'starting', 'server', 'checking']);
});
test('running healthy server is not restarted', async () => {
  const p = provider('started', true);
  await recoverExistingPreview(p, 'saved', async () => {});
  assert.deepEqual(p.calls.map((c) => c[0]), ['get']);
});
test('missing sandbox fails without recreation', async () => {
  const p = provider(); p.client.get = async () => { throw new Error('404 sandbox missing'); };
  await assert.rejects(recoverExistingPreview(p, 'saved', async () => {}), /404/);
  assert.equal(p.calls.length, 0);
});
test('existing unhealthy server fails rather than replacing its session', async () => {
  const p = provider('started'); p.isPortListening = async () => true;
  await assert.rejects(recoverExistingPreview(p, 'saved', async () => {}), /页面未返回成功/);
  assert.deepEqual(p.calls.map((c) => c[0]), ['get']);
});
test('server readiness wait is bounded', async () => {
  const p = provider('started'); p.startBackground = async () => {}; let waits = 0;
  await assert.rejects(recoverExistingPreview(p, 'saved', async () => {}, async () => { waits++; }), /未就绪/);
  assert.equal(waits, 20);
});
test('queue phases and completion all carry the claimed execution id', async () => {
  const calls = [];
  await processOnePreviewRecovery({ workspaceFactory: () => ({ initialize: async () => {}, runtime: async (_kind, fn) => fn() }), workerId: 'w', getSandbox: () => provider(), rpc: async (fn, args) => {
    calls.push({ fn, args });
    return { data: fn.includes('claim') ? [{ project_id: 'p', sandbox_id: 'saved', execution_id: 'E1' }] : true, error: null };
  } });
  const updates = calls.slice(1);
  assert.ok(updates.every((c) => c.args.p_execution_id === 'E1'));
  assert.equal(updates.at(-1).args.p_phase, 'ready');
});
test('lost lease stops before accessing sandbox', async () => {
  const p = provider();
  const r = await processOnePreviewRecovery({ workspaceFactory: () => ({ initialize: async () => {}, runtime: async (_kind, fn) => fn() }), workerId: 'w', getSandbox: () => p, rpc: async (fn) => ({
    data: fn.includes('claim') ? [{ project_id: 'p', sandbox_id: 'saved', execution_id: 'E1' }] : false, error: null,
  }) });
  // Provider construction has no remote effects; the first permission check blocks get/start.
  assert.equal(p.calls.length, 0);
  assert.equal(r.status, 'stale');
});
test('Daytona failure is persisted as failed with secrets redacted', async () => {
  const p = provider(); p.client.get = async () => { throw new Error('503 Bearer dtn_secretkey123 https://x.test/?token=abc'); };
  const calls = [];
  const result = await processOnePreviewRecovery({ workspaceFactory: () => ({ initialize: async () => {}, runtime: async (_kind, fn) => fn() }), workerId: 'w', getSandbox: () => p, rpc: async (fn, args) => {
    calls.push(args);
    return { data: fn.includes('claim') ? [{ project_id: 'p', sandbox_id: 'saved', execution_id: 'E1' }] : true, error: null };
  } });
  assert.equal(result.status, 'failed');
  assert.equal(calls.at(-1).p_phase, 'failed');
  assert.ok(calls.at(-1).p_error.includes('503'));
  assert.doesNotMatch(calls.at(-1).p_error, /dtn_secret|token=abc/);
});
test('empty queue never touches Daytona', async () => {
  assert.equal(await processOnePreviewRecovery({ workspaceFactory: () => ({ initialize: async () => {}, runtime: async (_kind, fn) => fn() }), workerId: 'w', getSandbox: () => { throw new Error('unexpected'); }, rpc: async () => ({ data: [], error: null }) }), null);
});

test('healthy saved proxy origin is reused without signing/resolving or restarting the runtime', async()=>{
 const p=provider('started',true);
 p.previewUrl=async()=>{throw Error('must not sign again');};
 const saved='https://stable-preview.test/';
 assert.equal(await recoverExistingPreview(p,'saved',async()=>{},async()=>{},{
  existingUrl:saved,probeUrl:async url=>{assert.equal(url,saved);return true;},
 }),saved);
 assert.deepEqual(p.calls.map(c=>c[0]),['get']);
});
test('cold recovery still preserves the saved proxy origin when that URL becomes healthy',async()=>{
 const p=provider('stopped');
 p.previewUrl=async()=>{throw Error('must not replace working origin');};
 const saved='https://stable-preview.test/';
 assert.equal(await recoverExistingPreview(p,'saved',async()=>{},async()=>{},{
  existingUrl:saved,probeUrl:async()=>true,
 }),saved);
 assert.deepEqual(p.calls.map(c=>c[0]),['get','start','dev']);
});
test('a genuinely expired/unhealthy saved proxy URL alone permits resolving a replacement',async()=>{
 const p=provider('started',true);let resolved=0;
 p.previewUrl=async()=>{resolved++;return 'https://replacement.test/';};
 assert.equal(await recoverExistingPreview(p,'saved',async()=>{},async()=>{},{
  existingUrl:'https://expired.test/',probeUrl:async()=>false,
 }),'https://replacement.test/');
 assert.equal(resolved,1);
 assert.deepEqual(p.calls.map(c=>c[0]),['get']);
});
test('project owner/sandbox drift stops recovery before any provider side effect',async()=>{
 const p=provider('started',true);
 const r=await processOnePreviewRecovery({workerId:'w',getProject:async()=>({id:'p',user_id:'wrong',sandbox_id:'saved'}),
  getSandbox:()=>p,rpc:async fn=>({data:fn.includes('claim')?[{project_id:'p',user_id:'u',sandbox_id:'saved',execution_id:'e'}]:true})});
 assert.equal(r.status,'failed');assert.equal(p.calls.length,0);
});

test('inconclusive network/CORS observation does not replace a saved working origin',async()=>{
 const p=provider('started',true);p.previewUrl=async()=>{throw Error('blind re-sign forbidden');};
 assert.equal(await recoverExistingPreview(p,'saved',async()=>{},async()=>{},{
  existingUrl:'https://stable-preview.test/',probeUrl:async()=>null,
 }),'https://stable-preview.test/');
});


test('unfinished first Build does not repeatedly start preview or replace its retained writer',async()=>{
 const p=provider();const updates=[];
 const result=await processOnePreviewRecovery({workerId:'w',getSandbox:()=>p,
  getProject:async()=>({id:'p',user_id:'u',sandbox_id:'saved',preview_url:null,checkpoint_id:null}),
  workspaceFactory:()=>({state:{writer:{kind:'preview'},build:null},read:async()=>{},reconcileRuntime:()=>assert.fail('do not churn the sandbox'),initialize:()=>assert.fail('no materialization'),runtime:()=>assert.fail('no new writer')}),
  rpc:async(fn,args)=>{updates.push(args);return {data:fn.includes('claim')?[{project_id:'p',user_id:'u',sandbox_id:'saved',execution_id:'e'}]:true};}});
 assert.equal(result.status,'failed');assert.deepEqual(p.calls,[]);
 assert.match(updates.at(-1).p_error,/尚未完成首次构建/);
});
