import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, retryAfterMs, withProviderRetry } from '../src/provider-retry.js';

const transient = () => Object.assign(new Error('unavailable'), { httpStatus: 503 });
test('central classification distinguishes rate/quota/auth/timeout/transport; numeric codes are safe', () => {
  for (const error of [transient(), { httpStatus: 408 }, { code: 'LLM_NETWORK', causeCode: 'ECONNRESET' }, { httpStatus: 429, retryAfterMs: 1000 }, { httpStatus: 429 }]) {
    assert.equal(classifyProviderError(error).action, 'retry_once');
  }
  for (const error of [{ httpStatus: 429, providerCode: 1113, retryAfterMs: 100 },
    { httpStatus: 429, message: 'insufficient quota' }, { httpStatus: 402 }, { httpStatus: 401 },
    { code: 'LLM_TIMEOUT' }, { code: 'LLM_INVALID_RESPONSE' }, { code: 'LEASE_LOST', httpStatus: 503 }, { code: 23 }]) {
    assert.equal(classifyProviderError(error).action, 'fail');
  }
  assert.equal(retryAfterMs('2'), 2000);
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:59Z')), 1000);
  assert.equal(retryAfterMs('bad'), null);
});

test('only one resend; same deadline signal, bounded jitter and permission check per attempt', async () => {
  const attempts = [], waits = [], checks = [];
  const result = await withProviderRetry(async (context) => {
    attempts.push(context);
    if (context.attempt === 1) throw transient();
    return 'ok';
  }, { beforeAttempt: async (n) => checks.push(n), random: () => 0.5, wait: async (ms) => waits.push(ms) });
  assert.equal(result, 'ok');
  assert.deepEqual(checks, [1, 2]);
  assert.deepEqual(waits, [450]);
  assert.equal(attempts[0].signal, attempts[1].signal);
  let calls = 0;
  await assert.rejects(withProviderRetry(async () => { calls++; throw transient(); }, { wait: async () => {} }));
  assert.equal(calls, 2);
});

test('honour Retry-After, do not wait too long or retry after insufficient remaining time', async () => {
  for (const after of [1500, 9000]) {
    let calls = 0; const waits = [];
    const work = withProviderRetry(async () => { calls++; if (calls === 1) throw Object.assign(transient(), { retryAfterMs: after }); return 'ok'; },
      { wait: async (ms) => waits.push(ms), random: () => 0 });
    if (after === 1500) { assert.equal(await work, 'ok'); assert.deepEqual(waits, [1500]); }
    else { await assert.rejects(work); assert.equal(calls, 1); assert.deepEqual(waits, []); }
  }
  let time = 0, calls = 0;
  await assert.rejects(withProviderRetry(async () => { calls++; time = 119000; throw transient(); }, { now: () => time }));
  assert.equal(calls, 1);
});

test('pause during backoff or lease loss before resend prevents a second request', async () => {
  const controller = new AbortController();
  const paused = Object.assign(new Error('paused'), { code: 'ABORTED' });
  let calls = 0;
  await assert.rejects(withProviderRetry(async () => { calls++; throw transient(); }, {
    signal: controller.signal, wait: async () => controller.abort(paused),
  }), (e) => e === paused);
  assert.equal(calls, 1);
  const lease = Object.assign(new Error('lost'), { code: 'LEASE_LOST' });
  calls = 0;
  await assert.rejects(withProviderRetry(async () => { calls++; throw transient(); }, {
    wait: async () => {}, beforeAttempt: async (attempt) => { if (attempt === 2) throw lease; },
  }), (e) => e === lease);
  assert.equal(calls, 1);
});

test('HTTP 408 gets at most one transparent retry under the same deadline', async () => {
  let calls = 0;
  await assert.rejects(withProviderRetry(async () => {
    calls++;
    throw Object.assign(new Error('request timeout'), { httpStatus: 408 });
  }, { wait: async () => {} }), { httpStatus: 408 });
  assert.equal(calls, 2);
});

test('429 busy gets one physical retry with backoff under one logical call; quota remains terminal',async()=>{
 const attempts=[],waits=[];
 assert.equal(await withProviderRetry(async({attempt})=>{attempts.push(attempt);if(attempt===1)throw {httpStatus:429};return 'plan';},
 {wait:async ms=>waits.push(ms),random:()=>0}),'plan');
 assert.deepEqual(attempts,[1,2]);assert.deepEqual(waits,[1500]);
 assert.equal(classifyProviderError({httpStatus:429,message:'insufficient quota'}).action,'fail');
});
