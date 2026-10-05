import { createHash } from 'node:crypto';
import { mkdir, writeFile, readdir, stat, unlink } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { logger } from './logger.js';

export const DEBUG_CAPTURE_DIR = fileURLToPath(new URL('../.forge-debug/llm/', import.meta.url));
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const CAPTURE_NAME = /^([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.(request|response)\.json$/i;
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,160}$/.test(value) ? value : null;

/** Optional API options may contain arbitrary values: metadata exposes only known enum fields. */
export function summarizeProviderOptions(options = {}) {
  const summary = {};
  if (['enabled', 'disabled'].includes(options?.thinking?.type)) summary.thinking = { type: options.thinking.type };
  if (['none', 'off', 'low', 'medium', 'high'].includes(options?.reasoning_effort)) summary.reasoning_effort = options.reasoning_effort;
  if (['none', 'low', 'medium', 'high'].includes(options?.reasoning?.effort)) summary.reasoning = { effort: options.reasoning.effort };
  return summary;
}

/** Headers vs complete-body timing; no first-chunk claim and no prompt/response text. */
export function requestDiagnostics({ requestId, logicalCallId, attempt, provider, model, purpose, timeoutMs,
  messagesCount, contextChars, requestBody, capability, requestedOptions, body },
  { now = () => performance.now(), wall = () => new Date().toISOString() } = {}) {
  const start = now();
  const values = {
    request_id: requestId, logical_call_id: logicalCallId, attempt, provider, model, purpose,
    timeout_ms: timeoutMs, messages_count: messagesCount,
    input_chars: Object.values(contextChars).reduce((sum, n) => sum + n, 0), context_chars: contextChars,
    request_body_hash: createHash('sha256').update(requestBody).digest('hex'),
    requested_temperature: capability.requestedTemperature, effective_temperature: capability.sentTemperature,
    requested_json_mode: capability.requestedJsonMode, effective_json_mode: capability.effectiveJsonMode,
    requested_reasoning: capability.requestedReasoning, effective_reasoning: capability.effectiveReasoning,
    requested_provider_options: summarizeProviderOptions(requestedOptions), effective_provider_options: summarizeProviderOptions(body),
    request_started_at: wall(), response_headers_at: null, response_body_completed_at: null,
    headers_received: false, body_completed: false, headers_duration_ms: null, body_duration_ms: null,
    http_status: null, provider_request_id: null, finish_reason: null, request_phase: 'fetch',
  };
  let headersTime;
  return {
    snapshot: () => ({ ...values }),
    headers(response) {
      headersTime = now();
      values.headers_received = true;
      values.response_headers_at = wall();
      values.headers_duration_ms = Math.round(Math.max(0, headersTime - start));
      values.http_status = Number.isInteger(response.status) ? response.status : null;
      values.provider_request_id = safeId(response.headers?.get?.('x-request-id')) || safeId(response.headers?.get?.('request-id'));
      values.request_phase = 'body';
    },
    bodyCompleted() {
      if (values.body_completed) return;
      values.body_completed = true;
      values.response_body_completed_at = wall();
      values.body_duration_ms = Math.round(Math.max(0, now() - (headersTime ?? start)));
      values.request_phase = 'protocol';
    },
    complete(payload) {
      const finish = payload?.choices?.[0]?.finish_reason;
      values.finish_reason = ['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'error'].includes(finish) ? finish : null;
      values.provider_request_id ||= safeId(payload?.id);
    },
    succeeded() { values.request_phase = 'completed'; },
  };
}

/** Exact effective JSON body/raw response, local only. Never receives authentication headers or configuration API keys. */
export function localRequestCapture({ enabled = false, requestId, dir = DEBUG_CAPTURE_DIR,
  maxBytes = 2 * 1024 * 1024, maxRequests = 100, warn = (meta) => logger.warn('llm.debug_capture_failed', meta) }) {
  const paths = {};
  const jobs = [];
  const note = (kind, reason) => { try { warn({ request_id: requestId, kind, reason }); } catch {} };
  const save = (kind, raw) => {
    if (!enabled) return;
    const job = (async () => {
      if (!UUID.test(requestId)) { note(kind, 'invalid_request_id'); return; }
      if (typeof raw !== 'string') { note(kind, 'invalid_body'); return; }
      if (Buffer.byteLength(raw, 'utf8') > maxBytes) { note(kind, 'size_limit'); return; }
      try {
        await mkdir(dir, { recursive: true, mode: 0o700 });
        const path = join(dir, `${requestId}.${kind}.json`);
        await writeFile(path, raw, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        paths[`debug_${kind}_path`] = path;
      } catch (error) { note(kind, safeId(error?.code) || 'write_failed'); }
    })();
    jobs.push(job);
  };
  return {
    enabled,
    request: (raw) => save('request', raw),
    response: (raw) => save('response', raw),
    async finish() {
      await Promise.all(jobs);
      if (enabled && Object.keys(paths).length) {
        try {
          // Bound only our own UUID capture pairs; preserve unrelated files and the current request.
          const entries = await readdir(dir);
          const groups = new Map();
          for (const name of entries) {
            const match = name.match(CAPTURE_NAME);
            if (!match) continue;
            const info = await stat(join(dir, name));
            const group = groups.get(match[1]) || { id: match[1], time: 0, names: [] };
            group.time = Math.max(group.time, info.mtimeMs); group.names.push(name); groups.set(group.id, group);
          }
          const old = [...groups.values()].filter((g) => g.id !== requestId).sort((a, b) => b.time - a.time);
          for (const group of old.slice(Math.max(0, maxRequests - 1))) {
            for (const name of group.names) await unlink(join(dir, name));
          }
        } catch (error) { note('retention', safeId(error?.code) || 'cleanup_failed'); }
      }
      return { ...paths };
    },
  };
}
