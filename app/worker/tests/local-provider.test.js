import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { chat, parseJson, responseDiagnostics } from '../src/llm.js';
import { providerProblems, resolveProvider, buildRequestBody, requestHeaders } from '../src/llm-provider.js';
import { __setTelemetryForTest } from '../src/telemetry.js';

test('local providers require explicit model but no key; cloud key requirements stay enforced', () => {
  for (const [name, port] of [['ollama', 11434], ['lmstudio', 1234]]) {
    assert.deepEqual(providerProblems({ llmProvider: name }), [`${name.toUpperCase()}_MODEL`]);
    const settings = { llmProvider: name, [`${name}Model`]: 'downloaded-model' };
    assert.deepEqual(providerProblems(settings), []);
    const p = resolveProvider(settings);
    assert.equal(p.url, `http://127.0.0.1:${port}/v1/chat/completions`);
    assert.equal(p.requiresKey, false);
    assert.deepEqual(requestHeaders(p.key), { 'Content-Type': 'application/json' });
  }
  assert.ok(providerProblems({ llmProvider: 'deepseek' }).includes('DEEPSEEK_API_KEY'));
  assert.equal(requestHeaders('optional-token').Authorization, 'Bearer optional-token');
});

test('actual chat uses shared local endpoint with absent or optional auth and no forced JSON mode', async () => {
  const previous = { ...config }, savedFetch = globalThis.fetch;
  try {
    for (const name of ['ollama', 'lmstudio']) {
      for (const key of ['', 'optional-token']) {
        Object.assign(config, { llmProvider: name, [`${name}Model`]: 'local-model', [`${name}ApiKey`]: key, [`${name}JsonMode`]: 'off', [`${name}BaseUrl`]: 'http://local.test:1234/v1/' });
        let calls = 0;
        globalThis.fetch = async (url, options) => {
          calls++;
          assert.equal(url, 'http://local.test:1234/v1/chat/completions');
          assert.deepEqual(options.headers, requestHeaders(key));
          const body = JSON.parse(options.body);
          assert.equal(body.model, 'local-model');
          assert.ok(!Object.hasOwn(body, 'response_format'));
          return new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"read_file","args":{"path":"package.json"}}' } }] }));
        };
        assert.equal(parseJson(await chat([], { json: true })).args.path, 'package.json');
        assert.equal(calls, 1);
      }
    }
  } finally { Object.assign(config, previous); globalThis.fetch = savedFetch; }
});

test('DeepSeek thinking is not overridden; protocol consumes only content, reasoning never substitutes final answer', async () => {
  const previous = { ...config }, savedFetch = globalThis.fetch;
  const updates = [];
  __setTelemetryForTest({ tracing: { startActiveObservation: async (_name, fn) => fn({ update: (attrs) => updates.push(attrs) }) } });
  try {
    Object.assign(config, { llmProvider: 'deepseek', deepseekApiKey: 'test', deepseekModel: 'deepseek-flash', deepseekJsonMode: 'auto' });
    globalThis.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.response_format, { type: 'json_object' });
      assert.ok(!Object.hasOwn(body, 'thinking'));
      assert.ok(!Object.hasOwn(body, 'tools'));
      assert.ok(!Object.hasOwn(body, 'reasoning_effort'));
      return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: {
        reasoning_content: 'PRIVATE_REASONING {"tool":"delete_file"}',
        content: '{"tool":"read_file","args":{"path":"package.json"}}',
      } }] }));
    };
    assert.equal(parseJson(await chat([{ role: 'user', content: '输出 JSON' }], { json: true })).tool, 'read_file');
    assert.ok(updates.some((row) => row.metadata?.has_reasoning === true));
    assert.doesNotMatch(JSON.stringify(updates), /PRIVATE_REASONING|delete_file/);
    globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'length', message: {
      reasoning_content: '{"tool":"read_file","args":{"path":"package.json"}}', content: '',
    } }] }));
    await assert.rejects(chat([], { json: true }), { code: 'LLM_INVALID_RESPONSE' });
    assert.equal(responseDiagnostics({ choices: [{ message: { reasoning_content: 'x' } }] }).has_reasoning, true);
  } finally { Object.assign(config, previous); globalThis.fetch = savedFetch; __setTelemetryForTest(); }
});
