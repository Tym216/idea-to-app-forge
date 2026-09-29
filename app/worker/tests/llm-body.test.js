import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readModelResponse, chat } from '../src/llm.js';
import { config } from '../src/config.js';
import { withExecutionControl } from '../src/execution-control.js';

const context = () => ({ providerName: 'openrouter', model: 'test-model', started: performance.now() });

test('成功响应头之后正文超时/断线归类,无效 JSON 不伪报网络故障', async () => {
  await assert.rejects(() => readModelResponse({ ok: true, json: async () => { throw new DOMException('timeout', 'TimeoutError'); } }, context()), (e) => e.code === 'LLM_TIMEOUT');
  await assert.rejects(() => readModelResponse({ ok: true, json: async () => { throw Object.assign(new TypeError('terminated'), { cause: { code: 'ECONNRESET' } }); } }, context()), (e) => e.code === 'LLM_NETWORK' && e.causeCode === 'ECONNRESET');
  await assert.rejects(() => readModelResponse({ ok: true, json: async () => { throw new SyntaxError('broken payload'); } }, context()), (e) => e.code === 'LLM_INVALID_RESPONSE');
  assert.equal(await readModelResponse({ ok: false, text: async () => 'quota error' }, context()), 'quota error');
});

test('正文读取时已暂停/丢失租约,保持控制错误', async () => {
  const controller = new AbortController();
  const stop = Object.assign(new Error('lease lost'), { code: 'LEASE_LOST' });
  controller.abort(stop);
  await assert.rejects(() => withExecutionControl({ signal: controller.signal }, () => readModelResponse({ ok: true, json: async () => { throw new DOMException('aborted', 'AbortError'); } }, context())), (e) => e === stop);
});

test('完整 chat 在正文超时时只请求一次并抛平台字符串错误码', async () => {
  const previous = { ...config };
  const savedFetch = globalThis.fetch;
  let calls = 0;
  try {
    Object.assign(config, { llmProvider: 'openrouter', openrouterApiKey: 'test-key', openrouterModel: 'test-model' });
    globalThis.fetch = async () => {
      calls++;
      return { ok: true, json: async () => { throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); } };
    };
    await assert.rejects(() => chat([]), (e) => e.code === 'LLM_TIMEOUT');
    assert.equal(calls, 1);
  } finally {
    Object.assign(config, previous);
    globalThis.fetch = savedFetch;
  }
});
