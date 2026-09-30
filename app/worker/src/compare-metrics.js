import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** Offline log reader: no .env, account access, model requests or uploads. */
export function readMetrics(text) {
  const executions = new Map();
  for (const line of text.split(/\r?\n/)) {
    let row;
    try { row = JSON.parse(line); } catch { continue; }
    if (row.message !== 'task.metrics') continue;
    executions.set(`${row.task_id}:${row.execution_id}`, row);
  }
  return [...executions.values()];
}

const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

export function summarizeMetrics(rows) {
  const successful = (row) => ['succeeded', 'succeeded_with_warnings'].includes(row.status);
  const failures = {};
  const totals = { model_requests: 0, logical_model_turns: null, input_tokens_reported: null, output_tokens_reported: null };
  for (const row of rows) {
    totals.model_requests += row.model_request_count || 0;
    if (Number.isFinite(row.logical_model_turn_count)) totals.logical_model_turns = (totals.logical_model_turns ?? 0) + row.logical_model_turn_count;
    for (const [source, target] of [['input_tokens', 'input_tokens_reported'], ['output_tokens', 'output_tokens_reported']]) {
      if (Number.isFinite(row[source])) totals[target] = (totals[target] ?? 0) + row[source];
    }
    if (!successful(row)) failures[row.failure_code || row.status] = (failures[row.failure_code || row.status] || 0) + 1;
  }
  return {
    executions: rows.length,
    succeeded: rows.filter(successful).length,
    succeeded_with_warnings: rows.filter((row) => row.status === 'succeeded_with_warnings').length,
    execution_success_rate: rows.length ? rows.filter(successful).length / rows.length : null,
    ...totals,
    logical_turn_totals_incomplete: rows.some((row) => !Number.isFinite(row.logical_model_turn_count)),
    token_totals_incomplete: rows.some((row) => row.usage_incomplete),
    duration_ms_median_all_executions: median(rows.map((row) => row.duration_ms)),
    model_duration_ms_median: median(rows.map((row) => row.model_duration_ms)),
    build_count: rows.reduce((sum, row) => sum + (row.build_count || 0), 0),
    build_pass_count: rows.reduce((sum, row) => sum + (row.build_pass_count || 0), 0),
    verify_count: rows.reduce((sum, row) => sum + (row.verify_count || 0), 0),
    verify_pass_count: rows.reduce((sum, row) => sum + (row.verify_pass_count || 0), 0),
    time_to_preview_ms_median_observed: median(rows.map((row) => row.time_to_preview_ms)),
    preview_observed_count: rows.filter((row) => Number.isFinite(row.time_to_preview_ms)).length,
    verified_observed_count: rows.filter((row) => Number.isFinite(row.time_to_verified_ms)).length,
    failures,
  };
}

export function compareLogs(files) {
  return files.map((file) => {
    const rows = readMetrics(readFileSync(file, 'utf8'));
    const groups = new Map();
    for (const row of rows) {
      const key = JSON.stringify({ provider: row.provider, model: row.model, mode: row.mode,
        fusion_enabled: row.fusion_enabled, code_version: row.code_version });
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }
    return { file, groups: [...groups].map(([key, values]) => ({ configuration: JSON.parse(key), ...summarizeMetrics(values) })) };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.length < 3) { process.stderr.write('Usage: npm run metrics:compare -- baseline.log fusion.log\n'); process.exitCode = 1; }
  else process.stdout.write(JSON.stringify(compareLogs(process.argv.slice(2)), null, 2) + '\n');
}
