import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, stat, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { requestDiagnostics, localRequestCapture } from '../src/llm-diagnostics.js';
import { chat } from '../src/llm.js';
import { config } from '../src/config.js';
import { logger } from '../src/logger.js';
import { withExecutionControl } from '../src/execution-control.js';
import { __setTelemetryForTest } from '../src/telemetry.js';
import { createTaskMetrics, withTaskMetrics } from '../src/task-metrics.js';

const ID1 = '11111111-1111-4111-8111-111111111111';
const ID2 = '22222222-2222-4222-8222-222222222222';
const rawReply = JSON.stringify({ id: 'chatcmpl-test', choices: [{ finish_reason: 'stop', message: {
  content: 'PRIVATE_OUTPUT', reasoning_content: 'PRIVATE_REASONING',
} }], usage: { prompt_tokens: 10, completion_tokens: 4, completion_tokens_details: { reasoning_tokens: 2 } } });

async function mockChat(fn) {
  const previous = { ...config }, oldFetch = globalThis.fetch, oldLogger = { ...logger };
  const oldContent = process.env.LANGFUSE_CAPTURE_CONTENT;
  const rows = [], spans = [];
  const dir = await mkdtemp(join(tmpdir(), 'forge-llm-diag-'));
  Object.assign(config, { llmProvider: 'openrouter', llmModel: 'test-model', llmBaseUrl: 'https://test.invalid/v1',
    llmApiKey: 'fake-test-key', llmJsonMode: 'on', llmTimeoutMs: 120000,
    planTemperature: 0.4, buildTemperature: 0.1, planProviderOptionsRaw: '{}', buildProviderOptionsRaw: '{}',
    llmReasoningProfile: 'auto', llmDebugCaptureRequest: false });
  process.env.LANGFUSE_CAPTURE_CONTENT = 'false';
  for (const key of ['info', 'warn', 'error']) logger[key] = (message, attrs) => rows.push({ message, ...attrs });
  __setTelemetryForTest({ tracing: { startActiveObservation: async (_name, fn) => fn({ update: (attrs) => spans.push(attrs) }) } });
  const send = (options = {}) => chat([{ role: 'user', content: 'PRIVATE_REQUIREMENT' }], {
    json: true, purpose: 'build_decision',
    captureFactory: (settings) => localRequestCapture({ ...settings, dir }), ...options,
  });
  try { await fn({ send, rows, spans, dir }); }
  finally {
    Object.assign(config, previous); globalThis.fetch = oldFetch; Object.assign(logger, oldLogger); __setTelemetryForTest();
    if (oldContent === undefined) delete process.env.LANGFUSE_CAPTURE_CONTENT; else process.env.LANGFUSE_CAPTURE_CONTENT = oldContent;
    await rm(dir, { recursive: true, force: true });
  }
}

test('request diagnostics distinguish headers/body stages and whitelist optional metadata', () => {
  let time = 0;
  const d = requestDiagnostics({ requestId: ID1, logicalCallId: ID2, attempt: 1, provider: 'p', model: 'm',
    purpose: 'plan', timeoutMs: 240000, messagesCount: 1, contextChars: { instructions: 2, other: 3 },
    requestBody: '{"messages":"PRIVATE"}', capability: {}, requestedOptions: { thinking: { type: 'enabled', secret: 'PRIVATE' } },
    body: { temperature: 0.2, reasoning: { effort: 'low', secret: 'PRIVATE' } } },
    { now: () => time, wall: () => `wall-${time}` });
  assert.equal(d.snapshot().headers_received, false);
  time = 30; d.headers(new Response('', { status: 200, headers: { 'x-request-id': 'req-provider' } }));
  assert.equal(d.snapshot().request_phase, 'body');
  time = 70; d.bodyCompleted(); d.complete({ choices: [{ finish_reason: 'stop' }] }); d.succeeded();
  const s = d.snapshot();
  assert.equal(s.headers_duration_ms, 30); assert.equal(s.body_duration_ms, 40);
  assert.equal(s.response_body_completed_at, 'wall-70'); assert.equal(s.input_chars, 5);
  assert.equal(s.provider_request_id, 'req-provider'); assert.equal(s.finish_reason, 'stop');
  assert.equal(s.request_phase, 'completed'); assert.doesNotMatch(JSON.stringify(s), /PRIVATE|secret/);
});

test('local capture is opt-in; exact bytes, owner-only modes, retention never removes unrelated files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-capture-'));
  try {
    const off = localRequestCapture({ requestId: ID1, dir: join(dir, 'disabled') });
    off.request('private'); await off.finish();
    await assert.rejects(stat(join(dir, 'disabled')), { code: 'ENOENT' });
    const first = localRequestCapture({ enabled: true, requestId: ID1, dir }); first.request('{"x":1}'); await first.finish();
    await writeFile(join(dir, 'keep.txt'), 'user-owned');
    const second = localRequestCapture({ enabled: true, requestId: ID2, dir, maxRequests: 1 });
    second.request('{"temperature":0.1}'); second.response('not valid JSON: exact raw body');
    const paths = await second.finish();
    assert.equal(await readFile(paths.debug_request_path, 'utf8'), '{"temperature":0.1}');
    assert.equal(await readFile(paths.debug_response_path, 'utf8'), 'not valid JSON: exact raw body');
    if (process.platform !== 'win32') assert.equal((await stat(paths.debug_request_path)).mode & 0o777, 0o600);
    assert.equal(await readFile(join(dir, 'keep.txt'), 'utf8'), 'user-owned');
    await assert.rejects(stat(join(dir, `${ID1}.request.json`)), { code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('timeout before headers has fetch stage and correlated IDs; disabled capture writes nothing', async () => mockChat(async ({ send, rows, dir }) => {
  globalThis.fetch = async () => { throw new DOMException('timeout', 'TimeoutError'); };
  await assert.rejects(send(), (e) => e.code === 'LLM_TIMEOUT' && e.requestPhase === 'fetch' && e.headersReceived === false
    && e.message.includes(e.requestId));
  const start = rows.find((r) => r.message === 'model.request_started');
  const end = rows.find((r) => r.message === 'model.request');
  assert.equal(start.request_id, end.request_id); assert.equal(end.headers_received, false);
  assert.equal(end.body_completed, false); assert.equal(end.timeout_ms, 120000);
  assert.ok(end.input_chars > 0); assert.deepEqual(await readdir(dir), []);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_REQUIREMENT|fake-test-key/);
}));

test('timeout while reading body keeps headers/status/provider ID and records body stage', async () => mockChat(async ({ send, rows }) => {
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers({ 'x-request-id': 'upstream-body' }),
    json: async () => { throw new DOMException('body timeout', 'TimeoutError'); } });
  await assert.rejects(send(), (e) => e.code === 'LLM_TIMEOUT' && e.requestPhase === 'body' && e.headersReceived === true);
  const end = rows.find((r) => r.message === 'model.request');
  assert.equal(end.headers_received, true); assert.equal(end.body_completed, false);
  assert.equal(end.http_status, 200); assert.equal(end.provider_request_id, 'upstream-body');
  assert.ok(end.response_headers_at); assert.equal(end.response_body_completed_at, null);
}));

test('capture saves effective payload and raw response locally; tracing sees metadata only', async () => mockChat(async ({ send, rows, spans }) => {
  config.llmDebugCaptureRequest = true;
  let sent;
  globalThis.fetch = async (_url, options) => { sent = options; return new Response(rawReply, { headers: { 'x-request-id': 'upstream-success' } }); };
  assert.equal(await send(), 'PRIVATE_OUTPUT');
  const end = rows.find((r) => r.message === 'model.request');
  assert.equal(await readFile(end.debug_request_path, 'utf8'), sent.body);
  assert.equal(await readFile(end.debug_response_path, 'utf8'), rawReply);
  assert.equal(JSON.parse(sent.body).temperature, 0.1);
  assert.equal(end.effective_temperature, 0.1); assert.equal(end.effective_json_mode, 'on');
  assert.equal(end.body_completed, true); assert.equal(end.finish_reason, 'stop');
  assert.equal(end.usage_breakdown.reasoning_tokens, 2);
  assert.doesNotMatch(await readFile(end.debug_request_path, 'utf8'), /fake-test-key|Authorization/);
  assert.doesNotMatch(JSON.stringify(spans), /PRIVATE_REQUIREMENT|PRIVATE_OUTPUT|PRIVATE_REASONING|debug_request_path/);
  assert.doesNotMatch(JSON.stringify(rows), /PRIVATE_REQUIREMENT|PRIVATE_OUTPUT|PRIVATE_REASONING|fake-test-key/);
}));

test('physical retries retain the same payload hash but distinct request IDs and local evidence', async () => mockChat(async ({ send, rows, dir }) => {
  config.llmDebugCaptureRequest = true;
  let calls = 0;
  globalThis.fetch = async () => ++calls === 1 ? new Response('temporary overload', { status: 503 }) : new Response(rawReply);
  const metrics = createTaskMetrics({ id: 't' });
  assert.equal(await withTaskMetrics(metrics, () => send()), 'PRIVATE_OUTPUT');
  const ends = rows.filter((r) => r.message === 'model.request');
  assert.equal(ends.length, 2); assert.notEqual(ends[0].request_id, ends[1].request_id);
  assert.equal(ends[0].logical_call_id, ends[1].logical_call_id);
  assert.equal(ends[0].request_body_hash, ends[1].request_body_hash);
  assert.equal(await readFile(ends[0].debug_request_path, 'utf8'), await readFile(ends[1].debug_request_path, 'utf8'));
  assert.equal((await readdir(dir)).length, 4);
  assert.equal(metrics.logical_model_turn_count, 1); assert.equal(metrics.model_request_count, 2);
}));

test('capture failure/size limit warn without changing model success; parse errors retain raw evidence', async () => mockChat(async ({ send, rows, dir }) => {
  config.llmDebugCaptureRequest = true;
  const file = join(dir, 'not-a-directory'); await writeFile(file, 'keep');
  globalThis.fetch = async () => new Response(rawReply);
  assert.equal(await send({ captureFactory: (settings) => localRequestCapture({ ...settings, dir: file }) }), 'PRIVATE_OUTPUT');
  assert.ok(rows.some((r) => r.message === 'llm.debug_capture_failed'));
  const notes = [], small = localRequestCapture({ enabled: true, requestId: ID1, dir, maxBytes: 1, warn: (note) => notes.push(note) });
  small.request('too long'); assert.deepEqual(await small.finish(), {}); assert.equal(notes[0].reason, 'size_limit');
  globalThis.fetch = async () => new Response('{broken');
  await assert.rejects(send(), { code: 'LLM_INVALID_RESPONSE' });
  const end = rows.filter((r) => r.message === 'model.request').at(-1);
  assert.equal(end.request_phase, 'protocol'); assert.equal(end.body_completed, true);
  assert.equal(await readFile(end.debug_response_path, 'utf8'), '{broken');
}));

test('pause during raw body read preserves execution-control error instead of provider timeout', async () => mockChat(async ({ send, rows }) => {
  config.llmDebugCaptureRequest = true;
  const controller = new AbortController(), stop = Object.assign(new Error('paused'), { code: 'LEASE_LOST' });
  globalThis.fetch = async () => ({ ok: true, status: 200, headers: new Headers(), text: async () => {
    controller.abort(stop); throw new DOMException('aborted', 'AbortError');
  } });
  await assert.rejects(withExecutionControl({ signal: controller.signal, checkLease: async () => {} }, () => send()), (e) => e === stop);
  assert.equal(rows.find((r) => r.message === 'model.request').failure_code, 'LEASE_LOST');
}));
