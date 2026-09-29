import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

const storage = new AsyncLocalStorage();
const categories = ['instructions', 'plan_and_acceptance', 'memory', 'initial_code', 'history', 'other'];

/** Character attribution only; provider usage is the sole source of token totals. */
export function measureContext(messages, parts = {}) {
  const counts = Object.fromEntries(categories.map((key) => [key, 0]));
  for (const [index, message] of messages.entries()) {
    const size = (typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '')).length;
    const supplied = index === 0 ? parts.system : index === 1 ? parts.user : null;
    let remaining = size;
    if (supplied) {
      for (const key of categories) {
        const amount = Math.min(remaining, Math.max(0, Math.floor(Number(supplied[key]) || 0)));
        counts[key] += amount;
        remaining -= amount;
      }
      counts.other += remaining;
    } else counts[index === 0 ? 'instructions' : index === 1 ? 'other' : 'history'] += remaining;
  }
  return counts;
}

export function createTaskMetrics(task, { fusionEnabled = false, codeVersion = 'unknown' } = {}) {
  return {
    task_id: task.id, execution_id: task.execution_id ?? null, project_id: task.project_id,
    mode: task.mode, kind: task.kind ?? 'new', resumes: task.resumes ?? 0,
    fusion_enabled: fusionEnabled, code_version: codeVersion,
    provider: null, model: null,
    started: performance.now(), logical_model_turn_count: 0, model_request_count: 0, model_success_count: 0, model_failure_count: 0,
    model_duration_ms: 0, input_tokens: null, output_tokens: null, usage_missing_count: 0,
    usage_incomplete: false, tool_call_count: 0, operation_count: 0,
    build_count: 0, build_pass_count: 0, verify_count: 0, verify_pass_count: 0,
    time_to_preview_ms: null, time_to_verified_ms: null,
  };
}

export const withTaskMetrics = (metrics, fn) => storage.run(metrics, fn);
export const currentTaskMetrics = () => storage.getStore();

export function beginModelTurn() {
  const metrics = currentTaskMetrics();
  if (metrics) metrics.logical_model_turn_count++;
  return randomUUID();
}

/** Called immediately before fetch, so lease/config failures are not counted as sent requests. */
export function beginModelRequest({ provider, model, purpose, contextChars }) {
  const metrics = currentTaskMetrics();
  if (metrics) {
    metrics.model_request_count++;
    metrics.provider ??= provider ?? null;
    metrics.model ??= model ?? null;
  }
  const started = performance.now();
  let finished;
  return {
    requestId: randomUUID(), provider, model, purpose, contextChars,
    finish(status, usage) {
      if (finished) return finished;
      finished = { status, duration_ms: Math.round(Math.max(0, performance.now() - started)),
        input_tokens: usage?.input ?? null, output_tokens: usage?.output ?? null };
      if (!metrics) return finished;
      metrics.model_duration_ms += finished.duration_ms;
      metrics[status === 'succeeded' ? 'model_success_count' : 'model_failure_count']++;
      if (!usage || usage.input == null || usage.output == null) {
        metrics.usage_missing_count++;
        metrics.usage_incomplete = true;
      }
      for (const [source, target] of [['input', 'input_tokens'], ['output', 'output_tokens']]) {
        if (Number.isFinite(usage?.[source])) metrics[target] = (metrics[target] ?? 0) + usage[source];
      }
      return finished;
    },
  };
}

export function recordToolCall() { const m = currentTaskMetrics(); if (m) m.tool_call_count++; }
export function recordOperation(tool, result) {
  const m = currentTaskMetrics();
  if (!m) return;
  if (result === undefined) {
    m.operation_count++;
    if (tool === 'build') m.build_count++;
    if (tool === 'verify') m.verify_count++;
    return;
  }
  if (result && tool === 'build') m.build_pass_count++;
  if (result && tool === 'verify') {
    m.verify_pass_count++;
    m.time_to_verified_ms ??= Math.round(Math.max(0, performance.now() - m.started));
  }
  if (result && tool === 'start_dev') m.time_to_preview_ms ??= Math.round(Math.max(0, performance.now() - m.started));
}

export function metricsSnapshot(metrics, status, error) {
  const { started, ...values } = metrics;
  return {
    ...values, model_duration_ms: Math.round(values.model_duration_ms),
    duration_ms: Math.round(Math.max(0, performance.now() - started)), status,
    failure_code: error ? typeof error.code === 'string' ? error.code : 'ERROR' : null,
  };
}
