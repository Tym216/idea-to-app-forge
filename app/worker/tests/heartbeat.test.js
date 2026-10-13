import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'SECRET_SERVICE_KEY';
process.env.LLM_PROVIDER = 'zhipu';
process.env.ZHIPU_API_KEY = 'test-placeholder';
process.env.LANGFUSE_ENABLED = 'false';
const { admin, heartbeat, setExecution, stateError } = await import('../src/supabase.js');

const task = 'heartbeat-test';
const id = 'fixed-execution';
const far = () => Date.now() + 90000;
const network = { name: 'FetchError', code: '', message: 'TypeError: fetch failed', details: 'Caused by: Error: socket reset (ECONNRESET)' };
async function scenario(responses, { deadline = far(), signal } = {}) {
  const original = admin.rpc;
  const calls = [];
  setExecution(task, id);
  admin.rpc = async (name, args) => {
    assert.equal(name, 'ita_heartbeat_task');
    calls.push(args);
    return responses[Math.min(calls.length - 1, responses.length - 1)];
  };
  try {
    let error;
    try { await heartbeat(task, { executionId: id, confirmedLeaseUntil: deadline, signal }); }
    catch (e) { error = e; }
    for (const c of calls) assert.equal(c.p_execution_id, id);
    return { calls, error };
  } finally { admin.rpc = original; setExecution(task, null); }
}
const ok = { data: true, error: null, status: 200 };
const lost = { data: false, error: null, status: 200 };
const fail = { data: null, error: network, status: 0 };

test('first heartbeat success makes one fixed-identity request', async () => {
  const r = await scenario([ok]); assert.equal(r.calls.length, 1); assert.equal(r.error, undefined);
});
test('transient network then success makes exactly two requests', async () => {
  const r = await scenario([fail, ok]); assert.equal(r.calls.length, 2); assert.equal(r.error, undefined);
});
test('HTTP503 then success retries once', async () => {
  const r = await scenario([{ data: null, error: { message: 'Service unavailable', code: '503' }, status: 503 }, ok]);
  assert.equal(r.calls.length, 2); assert.equal(r.error, undefined);
});
test('two transient failures stop at two requests', async () => {
  const r = await scenario([fail, fail]); assert.equal(r.calls.length, 2); assert.equal(r.error.code, 'SUPABASE_NETWORK');
});
test('near confirmed lease deadline fails closed after one request', async () => {
  const r = await scenario([fail, ok], { deadline: Date.now() + 12500 });
  assert.equal(r.calls.length, 1); assert.equal(r.error.code, 'SUPABASE_NETWORK');
});
test('false renewal and stale execution are never retried', async () => {
  const r = await scenario([lost, ok]); assert.equal(r.calls.length, 1); assert.equal(r.error.code, 'LEASE_LOST');
  setExecution(task, 'retired');
  await assert.rejects(heartbeat(task, { executionId: id, confirmedLeaseUntil: far() }), { code: 'LEASE_LOST' });
  setExecution(task, null);
});
test('401 and 403 are not retried', async () => {
  for (const status of [401,403]) {
    const r = await scenario([{ data:null, error:{message:'auth denied',code:String(status)}, status },ok]);
    assert.equal(r.calls.length,1);assert.equal(r.error.code,'SUPABASE_STATE');
  }
});
test('abort during retry wait prevents a second call', async () => {
  const c = new AbortController();
  const original = admin.rpc;let count = 0;
  setExecution(task,id);
  admin.rpc = async () => { count++; setTimeout(()=>c.abort(Object.assign(new Error('paused'),{code:'TASK_PAUSED'})),20);return fail; };
  try {
    await assert.rejects(heartbeat(task,{executionId:id,confirmedLeaseUntil:far(),signal:c.signal}),{code:'TASK_PAUSED'});
    assert.equal(count,1);
  } finally { admin.rpc=original;setExecution(task,null); }
});
test('timeout then success retries once when lease is safe', async () => {
  const r = await scenario([{data:null,error:{name:'TimeoutError',message:'The operation was aborted due to timeout'},status:0},ok]);
  assert.equal(r.calls.length,2);assert.equal(r.error,undefined);
});
test('error evidence is sanitized and includes safe cause/status', () => {
  const e=stateError('心跳续期',{
    name:'PostgrestError',code:'503',message:'fetch failed SECRET_SERVICE_KEY',
    details:'Caused by: Error: socket reset (ECONNRESET)'
  },{status:503,requestId:'req-123',phase:'fetch'});
  assert.equal(e.evidence.httpStatus,503);assert.equal(e.evidence.requestId,'req-123');
  assert.equal(e.evidence.causeCode,'ECONNRESET');assert.equal(e.evidence.phase,'fetch');
  assert.ok(!JSON.stringify(e).includes('SECRET_SERVICE_KEY'));
  assert.ok(!e.message.includes('SECRET_SERVICE_KEY'));
});
