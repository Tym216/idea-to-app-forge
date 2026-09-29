import { test } from 'node:test';
import assert from 'node:assert/strict';
import { beginModelRequest, createTaskMetrics, measureContext, metricsSnapshot, recordOperation, recordToolCall, withTaskMetrics } from '../src/task-metrics.js';

test('context characters partition actual content without overlap; history includes returned code', () => {
  const messages = [{ content: 'abcdefgh' }, { content: '123456' }, { content: 'new-code' }];
  const counts = measureContext(messages, { system: { plan_and_acceptance: 3, instructions: 5 }, user: { memory: 2, initial_code: 3 } });
  assert.equal(Object.values(counts).reduce((a, b) => a + b, 0), 22);
  assert.equal(counts.history, 8);
  assert.equal(counts.other, 1);
});

test('request count includes failed/timeouts; missing token usage is null/incomplete, not zero', async () => {
  const metrics = createTaskMetrics({ id: 't', execution_id: 'E2', resumes: 1, mode: 'build' });
  await withTaskMetrics(metrics, async () => {
    const first = beginModelRequest({ purpose: 'build_decision' });
    const measured = first.finish('succeeded', { input: 10, output: 5 });
    assert.equal(first.finish('succeeded', { input: 100, output: 50 }), measured);
    assert.ok(measured.duration_ms >= 0);
    beginModelRequest({ purpose: 'build_decision' }).finish('failed');
    recordToolCall();
    recordOperation('write_file'); recordOperation('build'); recordOperation('build', true);
    recordOperation('start_dev'); recordOperation('start_dev', true);
    recordOperation('verify'); recordOperation('verify', false);
  });
  const result = metricsSnapshot(metrics, 'failed', { code: 'VERIFY_FAILED' });
  assert.equal(result.model_request_count, 2);
  assert.equal(result.model_failure_count, 1);
  assert.equal(result.input_tokens, 10);
  assert.equal(result.usage_incomplete, true);
  assert.equal(result.operation_count, 4);
  assert.equal(result.tool_call_count, 1);
  assert.equal(result.verify_pass_count, 0);
  assert.equal(result.time_to_verified_ms, null);
  assert.ok(result.time_to_preview_ms >= 0 && result.duration_ms >= 0);
  const missing = createTaskMetrics({ id: 'm' });
  await withTaskMetrics(missing, async () => beginModelRequest({}).finish('failed'));
  assert.equal(missing.input_tokens, null);
  assert.equal(missing.output_tokens, null);
});
