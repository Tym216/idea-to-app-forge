import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withExecutionControl, beforeModelCall, monitorExecution, guardedSandbox } from '../src/execution-control.js';

process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'test-placeholder';
process.env.LLM_PROVIDER = 'zhipu';
process.env.ZHIPU_API_KEY = 'test-placeholder';
process.env.LANGFUSE_ENABLED = 'false';
const { chat } = await import('../src/llm.js');
const { executionOf, setExecution, stateError, admin, ensureLease } = await import('../src/supabase.js');
const lost = () => Object.assign(new Error('LEASE_LOST'), { code: 'LEASE_LOST' });

test('暂停中断等待中的模型请求，下一次请求在发出前被拒绝', async () => {
  const controller = new AbortController();
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (_url, { signal }) => {
    calls++;
    return new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      controller.abort(lost());
    });
  };
  try {
    await withExecutionControl({ signal: controller.signal, checkLease: async () => {} }, async () => {
      await assert.rejects(chat([{ role: 'user', content: 'test' }]), { code: 'LEASE_LOST' });
      await assert.rejects(chat([]), { code: 'LEASE_LOST' });
    });
    assert.equal(calls, 1);
  } finally { globalThis.fetch = original; }
});

test('同一任务新执行不能改变旧异步链的 execution_id', async () => {
  const c = new AbortController();
  setExecution('t', 'E2');
  await withExecutionControl({ taskId: 't', executionId: 'E1', signal: c.signal }, async () => {
    await Promise.resolve();
    assert.equal(executionOf('t'), 'E1');
    c.abort(lost());
    assert.throws(() => executionOf('t'), { code: 'LEASE_LOST' });
  });
  assert.equal(executionOf('t'), 'E2');
  setExecution('t', null);
});

test('执行许可网络失败时不发模型请求；控制探测串行并终止', async () => {
  const error = stateError('执行许可检查', { message: 'TypeError: fetch failed' });
  const c = new AbortController();
  await withExecutionControl({ signal: c.signal, checkLease: async () => { throw error; } }, async () => {
    await assert.rejects(beforeModelCall(), { code: 'SUPABASE_NETWORK' });
  });
  let calls = 0;
  let stop;
  await new Promise((resolve) => {
    stop = monitorExecution(async () => { calls++; throw error; }, (e) => { assert.equal(e, error); resolve(); }, 1);
  });
  stop();
  assert.equal(calls, 1);
});

test('只读执行许可遇一次短暂网络超时后重试，不把任务误判为失败', async () => {
  const original = admin.rpc;
  let attempts = 0;
  admin.rpc = async () => (++attempts === 1
    ? { data: null, error: { message: 'TimeoutError: The operation was aborted due to timeout' } }
    : { data: true, error: null });
  try { await ensureLease('t', 'E1'); assert.equal(attempts, 2); }
  finally { admin.rpc = original; }
});

test('暂停后沙箱操作返回即中止，不再派发下一条命令', async () => {
  const c = new AbortController();
  let calls = 0;
  const sb = guardedSandbox({ exec: async () => { calls++; c.abort(lost()); return 'done'; } });
  await withExecutionControl({ signal: c.signal }, async () => {
    await assert.rejects(sb.exec(), { code: 'LEASE_LOST' });
    await assert.rejects(sb.exec(), { code: 'LEASE_LOST' });
  });
  assert.equal(calls, 1);
});

test('每次真实模型调用记录开始/返回及用量，不把 prompt 写进活动日志', async () => {
  const original = globalThis.fetch;
  const events = [];
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }) });
  try {
    await withExecutionControl({ signal: new AbortController().signal, checkLease: async () => {}, onModelEvent: async (event) => events.push(event) }, async () => {
      assert.equal(await chat([{ role: 'user', content: 'private-prompt' }]), 'ok');
    });
    assert.deepEqual(events.map((e) => e.event), ['started', 'finished']);
    assert.equal(events[1].chars, 2);
    assert.equal(events[1].usage.input, 10);
    assert.equal(events[1].usage.output, 2);
    assert.ok(!JSON.stringify(events).includes('private-prompt'));
  } finally { globalThis.fetch = original; }
});
