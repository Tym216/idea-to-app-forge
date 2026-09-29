import { setTimeout as delay } from 'node:timers/promises';

export function retryAfterMs(value, now = Date.now()) {
  if (value == null || String(value).trim() === '') return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds * 1000 : null;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}

/** Central policy boundary. Adding fallback later must happen here, not in Agent tools. */
export function classifyProviderError(error) {
  const fail = (reason) => ({ action: 'fail', reason });
  const retry = (reason) => ({ action: 'retry_once', reason });
  if (['ABORTED', 'LEASE_LOST', 'TASK_TIMEOUT', 'TASK_PAUSED', 'TASK_CANCELLED'].includes(error?.code)) return fail('execution_control');
  const status = error?.httpStatus;
  const code = String(error?.providerCode ?? '').toLowerCase();
  const message = String(error?.message ?? '').toLowerCase();
  if (status === 402 || ['1113', 'insufficient_quota', 'credit_balance_too_low'].includes(code)
    || /余额不足|无可用资源包|insufficient.{0,25}(balance|credit|quota)|quota.{0,15}exceeded|credit.{0,15}(exhausted|depleted)/i.test(message)) return fail('quota');
  if ([400, 401, 403, 404, 422].includes(status)) return fail('configuration_or_auth');
  if (error?.code === 'LLM_TIMEOUT') return fail('timeout');
  if (status === 429) {
    return error.retryAfterMs != null || /rate.?limit|too many requests|限流|请求频率/i.test(message)
      ? retry('rate_limit') : fail('unknown_429');
  }
  if ([500, 502, 503, 504].includes(status)) return retry('transient_server');
  if (error?.code === 'LLM_NETWORK' && ['ECONNRESET', 'EAI_AGAIN', 'ECONNREFUSED', 'UND_ERR_SOCKET', 'EPIPE'].includes(error.causeCode)) return retry('transient_connection');
  return fail('non_transient_or_unknown');
}

/** Frozen logical request, <=2 physical attempts, one shared deadline, no model fallback. */
export async function withProviderRetry(send, {
  signal, timeoutMs = 120000, beforeAttempt = async () => {}, onRetry = async () => {},
  now = () => performance.now(), random = Math.random,
  wait = async (ms, activeSignal) => {
    try { await delay(ms, undefined, { signal: activeSignal }); }
    catch (error) { activeSignal.throwIfAborted(); throw error; }
  },
} = {}) {
  const deadline = now() + timeoutMs;
  const activeSignal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...[signal].filter(Boolean)]);
  const checkActive = () => {
    signal?.throwIfAborted();
    if (activeSignal.aborted || now() >= deadline) {
      throw Object.assign(new Error('模型请求时间预算已耗尽，未继续重发'), { code: 'LLM_TIMEOUT' });
    }
  };
  for (let attempt = 1; attempt <= 2; attempt++) {
    checkActive();
    await beforeAttempt(attempt);
    checkActive();
    try { return await send({ attempt, signal: activeSignal }); }
    catch (error) {
      // Preserve the provider's classified timeout unless the caller cancelled.
      signal?.throwIfAborted();
      const decision = classifyProviderError(error);
      if (attempt === 2 || decision.action !== 'retry_once' || activeSignal.aborted) throw error;
      const ms = Math.max(error.retryAfterMs ?? 0, 300 + Math.floor(Math.max(0, Math.min(1, random())) * 300));
      // Honour Retry-After, but do not wait indefinitely or start with an exhausted budget.
      if (ms > 5000 || deadline - now() <= ms + 1000) throw error;
      await onRetry({ attempt: attempt + 1, delayMs: ms, reason: decision.reason });
      try { await wait(ms, activeSignal); }
      catch (waitError) { checkActive(); throw waitError; }
    }
  }
}
