import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';
process.env.DEEPSEEK_API_KEY = 'sk-testsecretkey1234567890';
process.env.DEEPSEEK_MODEL = "deepseek-chat"; // 固定 mock 模型，不继承开发者 .env
process.env.LLM_PROVIDER = 'deepseek';
process.env.LANGFUSE_CAPTURE_CONTENT = 'false';

const tel = await import('../src/telemetry.js');
const { chat } = await import('../src/llm.js');

/** 替身 tracing:记录 observation 的创建、更新与结束(含异常结束)。 */
function fakeTracing({ throwOnUpdate = false } = {}) {
  const spans = [];
  const propagated = [];
  const stack = [];
  return {
    spans,
    propagated,
    async startActiveObservation(name, fn, { asType }) {
      const span = { name, asType, attrs: [], ended: false, parent: stack.at(-1)?.name ?? null };
      spans.push(span);
      stack.push(span);
      const obs = { update(a) { if (throwOnUpdate) throw new Error('exporter down'); span.attrs.push(a); } };
      try { return await fn(obs); } finally { span.ended = true; stack.pop(); }
    },
    propagateAttributes(attrs, fn) { propagated.push(attrs); return fn(); },
  };
}
const merged = (s) => Object.assign({}, ...s.attrs.map((a) => ({ ...a, metadata: { ...(a.metadata || {}) } })));
const allText = (spans) => JSON.stringify(spans);

function mockFetch(payload, status = 200) {
  globalThis.fetch = async () => ({
    ok: status < 400, status,
    text: async () => 'upstream error Bearer sk-leakleakleakleak',
    json: async () => payload,
  });
}

test('开关关闭:不初始化 SDK,包装直接透传', async () => {
  tel.__setTelemetryForTest();
  assert.equal(await tel.initTelemetry({ LANGFUSE_ENABLED: 'false' }), false);
  assert.equal(await tel.initTelemetry({ LANGFUSE_ENABLED: 'true' }), false); // 缺 Key 也保持关闭
  assert.equal(tel.isTelemetryActive(), false);
  assert.equal(await tel.withObservation('x', {}, 'span', async () => 42), 42);
  assert.equal(await tel.traceTask({ id: 't' }, async () => 'ok'), 'ok');
});

test('usage 映射:input/output/total 取真实值,缺失不填 0,细分独立存放', () => {
  const full = tel.mapUsage({
    prompt_tokens: 100, completion_tokens: 20, total_tokens: 120,
    prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40,
    completion_tokens_details: { reasoning_tokens: 5 },
  });
  assert.deepEqual(full.usageDetails, { input: 100, output: 20, total: 120 });
  assert.deepEqual(full.breakdown, { prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40, reasoning_tokens: 5 });
  const partial = tel.mapUsage({ prompt_tokens: 7 });
  assert.deepEqual(partial.usageDetails, { input: 7 });
  assert.equal(partial.breakdown, undefined);
  assert.deepEqual(tel.mapUsage(undefined), { usageDetails: undefined, breakdown: undefined });
});

test('LLM generation:记录模型/usage/耗时,不上传 prompt 与输出内容', async () => {
  const t = fakeTracing();
  tel.__setTelemetryForTest({ tracing: t });
  mockFetch({ model: 'deepseek-chat-0925', choices: [{ message: { content: 'SECRET_CODE_OUTPUT' }, finish_reason: 'stop' }], usage: { prompt_tokens: 11, completion_tokens: 3 } });
  const out = await tel.traceTask({ id: 'task-1', execution_id: 'E1', project_id: 'p1', mode: 'build' },
    () => chat([{ role: 'user', content: 'PROMPT_SECRET export const App' }], { taskId: 'task-1' }));
  assert.equal(out, 'SECRET_CODE_OUTPUT');
  assert.deepEqual(t.propagated[0], { sessionId: 'task-1', traceName: 'forge.build', metadata: { projectId: 'p1', taskId: 'task-1', executionId: 'E1' } });
  const [root, gen] = t.spans;
  assert.equal(root.name, 'forge.task');
  assert.deepEqual({ ...merged(root).metadata }.execution_id, 'E1');
  assert.equal(gen.asType, 'generation');
  assert.equal(gen.parent, 'forge.task');
  const g = merged(gen);
  assert.equal(g.model, 'deepseek-chat-0925');
  assert.deepEqual(g.usageDetails, { input: 11, output: 3 });
  assert.equal(g.metadata.requested_model, 'deepseek-chat');
  assert.ok(Number.isFinite(g.metadata.ms));
  const text = allText(t.spans);
  assert.ok(!text.includes('PROMPT_SECRET') && !text.includes('SECRET_CODE_OUTPUT') && !text.includes('sk-testsecret'));
});

test('调试开关开启时 Langfuse 收到脱敏后的真实模型输入输出', async () => {
  const t = fakeTracing();
  tel.__setTelemetryForTest({ tracing: t });
  process.env.LANGFUSE_CAPTURE_CONTENT = 'true';
  try {
    mockFetch({ choices: [{ message: { content: '结果 Bearer sk-secret12345678' } }], usage: { prompt_tokens: 3, completion_tokens: 4 } });
    await chat([{ role: 'user', content: '检查 src/App.tsx?token=abc' }]);
    const generation = merged(t.spans[0]);
    assert.deepEqual(generation.input, [{ role: 'user', content: '检查 src/App.tsx?token=abc' }]);
    assert.match(generation.output, /结果 Bearer \[REDACTED\]/);
    assert.doesNotMatch(allText(t.spans), /sk-secret12345678/);
  } finally {
    process.env.LANGFUSE_CAPTURE_CONTENT = 'false';
    tel.__setTelemetryForTest();
  }
});

test('异常结束:LLM 报错标 ERROR 且脱敏;LEASE_LOST/ABORTED 标 WARNING;observation 均结束', async () => {
  const t = fakeTracing();
  tel.__setTelemetryForTest({ tracing: t });
  mockFetch({}, 500);
  await assert.rejects(tel.traceTask({ id: 't2', mode: 'build' }, () => chat([{ role: 'user', content: 'x' }])), /500/);
  assert.ok(t.spans.every((s) => s.ended));
  const g = merged(t.spans[1]);
  assert.equal(g.level, 'ERROR');
  assert.ok(g.statusMessage.includes('Bearer [REDACTED]') && !g.statusMessage.includes('sk-leak'));

  for (const code of ['LEASE_LOST', 'ABORTED']) {
    const t2 = fakeTracing();
    tel.__setTelemetryForTest({ tracing: t2 });
    const err = Object.assign(new Error(code), { code });
    await assert.rejects(tel.withObservation('tool.build', {}, 'tool', async () => { throw err; }), (e) => e === err);
    assert.equal(merged(t2.spans[0]).level, 'WARNING');
    assert.ok(t2.spans[0].ended);
  }
});

test('上报失败不影响业务:update 抛错、SDK 入口抛错时结果不变且只执行一次', async () => {
  tel.__setTelemetryForTest({ tracing: fakeTracing({ throwOnUpdate: true }) });
  assert.equal(await tel.withObservation('x', { metadata: {} }, 'span', async (o) => { o.update({}); return 'done'; }), 'done');
  let calls = 0;
  tel.__setTelemetryForTest({ tracing: { async startActiveObservation() { throw new Error('processor crashed'); } } });
  assert.equal(await tel.withObservation('x', {}, 'span', async () => { calls += 1; return 'ok'; }), 'ok');
  assert.equal(calls, 1);
  tel.__setTelemetryForTest();
});

test('脱敏:密钥、JWT、签名 URL 查询串被移除并截断', () => {
  const s = tel.redact('key sk-abcdefghijk1234 jwt eyJhbGciOiJIUzI1NiJ9.x https://p.daytona.io/app?token=abc dtn_abcdef123', 500);
  assert.ok(!/sk-abc|eyJhbGciOiJIUzI1|token=abc|dtn_abc/.test(s));
  assert.equal(tel.redact('a'.repeat(900), 100).length, 101);
});

test('shutdown 有时限:SDK shutdown 永不返回时最多等待 timeoutMs', async () => {
  tel.__setTelemetryForTest({ tracing: fakeTracing(), sdk: { shutdown: () => new Promise(() => {}) } });
  const started = performance.now();
  await tel.shutdownTelemetry(200);
  const ms = performance.now() - started;
  assert.ok(ms >= 190 && ms < 1500, `ms=${ms}`);
  assert.equal(tel.isTelemetryActive(), false);
  tel.__setTelemetryForTest({ sdk: { shutdown: async () => { throw new Error('flush failed'); } } });
  await tel.shutdownTelemetry(200); // 不抛出
});
