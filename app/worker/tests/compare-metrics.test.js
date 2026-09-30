import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readMetrics, summarizeMetrics } from '../src/compare-metrics.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

test('comparison includes failed/resumed executions, deduplicates logs and preserves unknown costs/tokens', () => {
  const first = { message: 'task.metrics', task_id: 't', execution_id: 'E1', status: 'failed', failure_code: 'LLM_TIMEOUT',
    duration_ms: 120000, model_request_count: 1, input_tokens: null, output_tokens: null, usage_incomplete: true };
  const second = { ...first, execution_id: 'E2', status: 'succeeded', failure_code: null, duration_ms: 20000,
    time_to_preview_ms: 10000, input_tokens: 20, output_tokens: 10, usage_incomplete: false };
  const rows = readMetrics('ignored\n' + [first, first, second].map((row) => JSON.stringify(row)).join('\n'));
  assert.equal(rows.length, 2);
  const summary = summarizeMetrics(rows);
  assert.equal(summary.execution_success_rate, 0.5);
  assert.equal(summary.duration_ms_median_all_executions, 70000);
  assert.equal(summary.model_requests, 2);
  assert.equal(summary.logical_model_turns, null);
  assert.equal(summary.logical_turn_totals_incomplete, true);
  const current = summarizeMetrics([{ ...second, logical_model_turn_count: 1, model_request_count: 2 }]);
  assert.equal(current.logical_model_turns, 1);
  assert.equal(current.model_requests, 2);
  assert.equal(current.logical_turn_totals_incomplete, false);
  assert.equal(summary.token_totals_incomplete, true);
  assert.equal(summary.preview_observed_count, 1);
  assert.deepEqual(summary.failures, { LLM_TIMEOUT: 1 });
  assert.equal(summarizeMetrics([first]).input_tokens_reported, null);
});

test('offline CLI compares synthetic logs with confirmed outcomes and separates provider configurations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-metrics-'));
  try {
    const file = join(dir, 'synthetic.log');
    writeFileSync(file, [
      { task_id: 't', execution_id: 'e', provider: 'p', model: 'm', status: 'succeeded', model_request_count: 6 },
      { task_id: 't', execution_id: 'e', provider: 'p', model: 'm', status: 'unconfirmed', model_request_count: 6 },
      { task_id: 'x', execution_id: 'e2', provider: 'p', model: 'other', status: 'succeeded', model_request_count: 2 },
    ].map((row) => JSON.stringify({ message: 'task.metrics', ...row })).join('\n'));
    const out = execFileSync(process.execPath, [fileURLToPath(new URL('../src/compare-metrics.js', import.meta.url)), file], { encoding: 'utf8' });
    const [report] = JSON.parse(out);
    assert.equal(report.groups.length, 2);
    assert.equal(report.groups[0].execution_success_rate, 0);
    assert.equal(report.groups[0].model_requests, 6);
    assert.deepEqual(report.groups[0].failures, { unconfirmed: 1 });
    assert.equal(report.groups[1].model_requests, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});


test('success with warnings counts as success and remains separately visible in KPI', () => {
  const rows = [
    { status: 'succeeded', failure_code: null },
    { status: 'succeeded_with_warnings', failure_code: null },
    { status: 'failed', failure_code: 'VERIFY_FAILED' },
  ];
  const summary = summarizeMetrics(rows);
  assert.equal(summary.succeeded, 2);
  assert.equal(summary.succeeded_with_warnings, 1);
  assert.equal(summary.execution_success_rate, 2 / 3);
  assert.deepEqual(summary.failures, { VERIFY_FAILED: 1 });
});
