import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chat } from '../src/llm.js';
import { config } from '../src/config.js';
import { withExecutionControl } from '../src/execution-control.js';
import { createTaskMetrics, withTaskMetrics } from '../src/task-metrics.js';
import { __setTelemetryForTest } from '../src/telemetry.js';

test('chat: one logical turn, two physical generations; identical payload and fresh lease before resend', async () => {
  const previous = { ...config }, savedFetch = globalThis.fetch;
  const metrics = createTaskMetrics({ id: 't' });
  const requests = [], observations = [], events = [];
  let leases = 0;
  try {
    Object.assign(config, { llmProvider: 'openrouter', openrouterApiKey: 'test-key', openrouterModel: 'test-model' });
    __setTelemetryForTest({ tracing: { startActiveObservation: async (name, fn, opts) => {
      const row = { name, type: opts.asType }; observations.push(row);
      return fn({ update: (attrs) => Object.assign(row, attrs) });
    } } });
    globalThis.fetch = async (_url, request) => {
      requests.push(request);
      assert.equal(leases, requests.length);
      return requests.length === 1
        ? new Response('temporary overload', { status: 503 })
        : new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 10, completion_tokens: 2 } }));
    };
    const result = await withTaskMetrics(metrics, () => withExecutionControl({
      signal: new AbortController().signal, checkLease: async () => { leases++; },
      onModelEvent: async (event) => { events.push(event.event); },
    }, () => chat([{ role: 'user', content: 'hello' }])));
    assert.equal(result, 'ok');
    assert.equal(requests.length, 2);
    assert.equal(requests[0].body, requests[1].body);
    assert.equal(requests[0].signal, requests[1].signal);
    assert.equal(metrics.logical_model_turn_count, 1);
    assert.equal(metrics.model_request_count, 2);
    assert.equal(metrics.model_failure_count, 1);
    assert.equal(metrics.input_tokens, 10);
    assert.equal(metrics.output_tokens, 2);
    assert.equal(metrics.usage_incomplete, true);
    assert.deepEqual(events, ['started', 'retrying', 'finished']);
    assert.deepEqual(observations.map((o) => o.type), ['generation', 'generation']);
    assert.deepEqual(observations.map((o) => o.metadata.attempt), [1, 2]);
    assert.equal(observations[0].metadata.logical_call_id, observations[1].metadata.logical_call_id);
    assert.notEqual(observations[0].metadata.request_id, observations[1].metadata.request_id);
    assert.equal(observations[0].metadata.error_classification.reason, 'transient_server');
    assert.equal(observations[1].usageDetails.output, 2);
  } finally {
    Object.assign(config, previous); globalThis.fetch = savedFetch; __setTelemetryForTest();
  }
});

test('chat: quota 429 is not retried even with Retry-After; unusable content is not a transport retry', async () => {
  const previous = { ...config }, savedFetch = globalThis.fetch;
  try {
    Object.assign(config, { llmProvider: 'openrouter', openrouterApiKey: 'test-key', openrouterModel: 'test-model' });
    for (const scenario of [
      { body: { error: { code: '1113', message: '余额不足或无可用资源包' } }, status: 429, code: 'LLM_HTTP' },
      { body: { choices: [{ message: { content: null } }] }, status: 200, code: 'LLM_INVALID_RESPONSE' },
    ]) {
      let calls = 0;
      globalThis.fetch = async () => { calls++; return new Response(JSON.stringify(scenario.body), { status: scenario.status, headers: { 'Retry-After': '0' } }); };
      await assert.rejects(() => chat([]), (e) => e.code === scenario.code);
      assert.equal(calls, 1);
    }
  } finally { Object.assign(config, previous); globalThis.fetch = savedFetch; }
});
