import { config } from './config.js';
import { requestDiagnostics, localRequestCapture } from './llm-diagnostics.js';
import { beginModelTurn, beginModelRequest, measureContext } from './task-metrics.js';
import { logger } from './logger.js';
import { beforeModelCall, currentExecution, assertExecutionActive } from './execution-control.js';
import { withObservation, mapUsage, captureLlmMessages, captureLlmOutput } from './telemetry.js';
import { resolveProvider, prepareRequest, normalizeResponse, validateResponse, requestHeaders, parseProviderOptions } from './llm-provider.js';
import { withProviderRetry, classifyProviderError, retryAfterMs } from './provider-retry.js';
export { supportsJsonMode, buildRequestBody } from './llm-provider.js';

/**
 * 统一的文本 LLM 客户端。供应商通过 Chat Completions 兼容入口调用,
 * 共用执行许可、超时、响应处理和 Langfuse 观测。
 */
export const LLM_REQUEST_TIMEOUT_MS = 120000;

/** 只保留响应形状和固定状态，不记录原始正文、拒绝内容或推理文本。 */
export function responseDiagnostics(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message;
  const content = message?.content;
  const finish = choice?.finish_reason;
  return {
    finish_reason: ['stop', 'length', 'content_filter', 'tool_calls', 'function_call', 'error'].includes(finish) ? finish : 'unknown',
    choices_count: Array.isArray(payload?.choices) ? payload.choices.length : 0,
    content_type: content === null ? 'null' : Array.isArray(content) ? 'array' : typeof content,
    has_reasoning: !!(message?.reasoning_content || message?.reasoning || message?.reasoning_details?.length),
    has_refusal: !!message?.refusal,
    tool_calls_count: Array.isArray(message?.tool_calls) ? message.tool_calls.length : 0,
    has_upstream_error: !!payload?.error,
  };
}

/** 仅暴露供应商、模型和安全的底层错误码，不把请求地址或密钥带到任务错误。 */
export function classifyModelFetchError(error, { providerName, model, elapsedMs }) {
  const causeCode = typeof error?.cause?.code === 'string' && /^[A-Z_]+$/.test(error.cause.code)
    ? error.cause.code : null;
  const timedOut = ['AbortError', 'TimeoutError'].includes(error?.name)
    || ['UND_ERR_CONNECT_TIMEOUT', 'ETIMEDOUT'].includes(causeCode);
  const code = timedOut ? 'LLM_TIMEOUT' : 'LLM_NETWORK';
  const reason = timedOut ? '请求超时' : '网络请求失败';
  const result = new Error(`调用 ${providerName} 模型 ${model} ${reason}（约 ${Math.round(elapsedMs / 1000)} 秒）`);
  result.code = code;
  result.causeCode = causeCode;
  return result;
}

/** fetch 收到响应头后已返回，但读取正文仍可能超时或断线。 */
export async function readModelResponse(response, context) {
  try {
    let payload;
    if (context.captureRaw) {
      const raw = await response.text();
      context.onBodyCompleted?.();
      context.captureRaw(raw);
      payload = response.ok ? JSON.parse(raw) : raw;
    } else {
      payload = response.ok ? await response.json() : await response.text();
      context.onBodyCompleted?.();
    }
    return payload;
  } catch (error) {
    // 用户暂停/租约失效保持原始控制原因，不能误归为模型网络故障。
    assertExecutionActive();
    if (error instanceof SyntaxError) {
      context.onBodyCompleted?.();
      const result = new Error(`LLM ${context.providerName} 返回的正文不是有效 JSON。`);
      result.code = 'LLM_INVALID_RESPONSE';
      throw result;
    }
    throw classifyModelFetchError(error, { ...context, elapsedMs: Math.max(0, performance.now() - context.started) });
  }
}

export async function chat(messages, options = {}) {
  return (await chatResponse(messages, options)).text;
}

export async function chatResponse(messages, { temperature = 0.2, json = false, taskId, purpose = 'unspecified', contextParts, reasoningMode = 'off', reasoningPolicy = 'best_effort', interactionMode = 'structured_text', captureFactory = localRequestCapture } = {}) {
  await beforeModelCall();
  const provider = resolveProvider(config);
  if (provider.requiresKey && !provider.key) {
    throw new Error(`LLM API key missing for provider "${config.llmProvider}". 请在 Worker 环境变量中配置。`);
  }
  if (!provider.model) throw new Error(`请在 Worker 环境中填写 ${config.llmProvider.toUpperCase()}_MODEL。`);

  const contextChars = measureContext(messages, contextParts);
  const stage = ['plan', 'design'].includes(purpose) ? 'plan'
    : ['build_decision', 'action_plan'].includes(purpose) ? 'build' : null;
  const stageTemperature = stage === 'plan' ? config.planTemperature : stage === 'build' ? config.buildTemperature : null;
  const rawOptions = stage === 'plan' ? config.planProviderOptionsRaw : stage === 'build' ? config.buildProviderOptionsRaw : '';
  const nativeOptions = parseProviderOptions(rawOptions, `${stage?.toUpperCase() || 'LLM'}_PROVIDER_OPTIONS`);
  const { body, capability } = prepareRequest({
    reasoningMode, reasoningPolicy, interactionMode, reasoningProfile: config.llmReasoningProfile, nativeOptions,
    providerName: config.llmProvider,
    model: provider.model,
    messages,
    temperature: stageTemperature ?? temperature,
    json,
    jsonMode: provider.jsonMode,
    upstream: config.openrouterUpstream,
  });

  for (const warning of capability.warnings) logger.warn('llm.capability', { provider: provider.name, model: provider.model, warning });

  // 调试开关打开时记录脱敏后的模型输入输出;默认只记录元数据与 usage。
  const traceInput = captureLlmMessages(messages);
  const requestBody = JSON.stringify(body);
  await currentExecution()?.onModelEvent?.({ event: 'started', model: provider.model });
  assertExecutionActive();
  const logicalCallId = beginModelTurn();
  return withProviderRetry(({ attempt, signal }) => withObservation(
    'llm.chat',
    {
      model: provider.model,
      ...(traceInput !== undefined ? { input: traceInput } : {}),
      metadata: { provider: config.llmProvider, json, task_id: taskId ?? null, purpose, context_chars: contextChars,
        logical_call_id: logicalCallId, attempt, capability },
    },
    'generation',
    async (obs) => {
      const started = performance.now();
      assertExecutionActive();
      const request = beginModelRequest({ provider: config.llmProvider, model: provider.model, purpose, contextChars });
      let status = 'failed';
      let recordedUsage;
      let failureCode;
      let usageBreakdown;
      const diagnostic = requestDiagnostics({ requestId: request.requestId, logicalCallId, attempt,
        provider: provider.name, model: provider.model, purpose, timeoutMs: config.llmTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS,
        messagesCount: messages.length, contextChars, requestBody, capability,
        requestedOptions: nativeOptions, body });
      const capture = captureFactory({ enabled: config.llmDebugCaptureRequest === true, requestId: request.requestId });
      const executionId = currentExecution()?.executionId ?? null;
      try {
      let response;
      logger.info('model.request_started', { task_id: taskId ?? null, execution_id: executionId, ...diagnostic.snapshot() });
      capture.request(requestBody);
      try {
        response = await fetch(provider.url, {
          method: 'POST',
          headers: requestHeaders(provider.key),
          body: requestBody,
          signal,
        });
      } catch (error) {
        assertExecutionActive();
        const classified = classifyModelFetchError(error, {
          providerName: config.llmProvider, model: provider.model, elapsedMs: Math.max(0, performance.now() - started),
        });
        logger.warn('llm.request_failed', {
          taskId, provider: config.llmProvider, model: provider.model,
          code: classified.code, causeCode: classified.causeCode, ms: Math.max(0, performance.now() - started),
          ...diagnostic.snapshot(),
        });
        throw classified;
      }

      diagnostic.headers(response);
      const payload = await readModelResponse(response, { providerName: config.llmProvider, model: provider.model, started,
        onBodyCompleted: () => diagnostic.bodyCompleted(),
        ...(capture.enabled ? { captureRaw: (raw) => capture.response(raw) } : {}) });
      diagnostic.complete(typeof payload === 'object' ? payload : null);
      if (!response.ok) {
        const error = new Error(`LLM ${config.llmProvider} ${response.status}: ${payload.slice(0, 500)}`);
        error.code = 'LLM_HTTP';
        error.httpStatus = response.status;
        error.retryAfterMs = retryAfterMs(response.headers?.get?.('retry-after'));
        try { error.providerCode = JSON.parse(payload)?.error?.code; } catch {}
        throw error;
      }

      assertExecutionActive();
      const normalized = normalizeResponse(payload);
      const content = normalized.text;
      const ms = Math.max(0, performance.now() - started);
      const { usageDetails, breakdown } = mapUsage(normalized.usage?.details);
      recordedUsage = usageDetails;
      usageBreakdown = breakdown;
      try { validateResponse(normalized, interactionMode); } catch (validationError) {
        const details = responseDiagnostics(payload);
        obs.update({
          model: payload?.model || provider.model,
          ...(usageDetails ? { usageDetails } : {}),
          metadata: {
            provider: config.llmProvider, requested_model: provider.model,
            response_model: payload?.model ?? null, ms, status: 'invalid_response',
            ...details,
            ...(breakdown ? { usage_breakdown: breakdown } : {}),
          },
        });
        logger.warn('llm.invalid_response', { taskId, provider: config.llmProvider, model: provider.model, ms, ...details, usage: usageDetails });
        const error = new Error(`LLM ${config.llmProvider} 未返回可用文本（finish_reason=${details.finish_reason}, content=${details.content_type}, reasoning=${details.has_reasoning}）。请查看模型响应记录。`);
        error.code = validationError.code;
        if (validationError.code === 'LLM_INTERACTION_MISMATCH') error.message = validationError.message;
        throw error;
      }
      const traceOutput = captureLlmOutput(content);
      obs.update({
        model: payload?.model || provider.model,
        ...(traceOutput !== undefined ? { output: traceOutput } : {}),
        ...(usageDetails ? { usageDetails } : {}),
        metadata: {
          provider: config.llmProvider,
          requested_model: provider.model,
          response_model: payload?.model ?? null,
          ...(typeof payload?.provider === 'string' ? { upstream_provider: payload.provider } : {}),
          ms,
          status: 'ok',
          has_reasoning: responseDiagnostics(payload).has_reasoning,
          finish_reason: payload?.choices?.[0]?.finish_reason ?? null,
          output_chars: content.length,
          ...(breakdown ? { usage_breakdown: breakdown } : {}),
        },
      });
      logger.info('llm.completed', { taskId, provider: config.llmProvider, model: provider.model, ms, chars: content.length });
      status = 'succeeded';
      diagnostic.succeeded();
      request.finish(status, recordedUsage);
      await currentExecution()?.onModelEvent?.({ event: 'finished', model: provider.model, ms, chars: content.length, usage: usageDetails });
      return normalized;
      } catch (error) {
        failureCode = typeof error?.code === 'string' ? error.code : 'ERROR';
        if (['LLM_TIMEOUT', 'LLM_NETWORK'].includes(failureCode)) {
          const details = diagnostic.snapshot();
          error.requestId = request.requestId;
          error.requestPhase = details.request_phase;
          error.headersReceived = details.headers_received;
          error.message += ` [request_id=${request.requestId}, phase=${details.request_phase}, headers_received=${details.headers_received}]`;
        }
        obs.update({ metadata: { error_classification: classifyProviderError(error) } });
        throw error;
      } finally {
        const measured = request.finish(status, recordedUsage);
        const debugPaths = await capture.finish();
        const diagnostics = diagnostic.snapshot();
        logger.info('model.request', { task_id: taskId ?? null, execution_id: executionId,
          ...diagnostics, ...measured, ...debugPaths,
          ...(usageBreakdown ? { usage_breakdown: usageBreakdown } : {}), failure_code: status === 'failed' ? failureCode : null });
        // Local paths/body capture never enter remote tracing; only safe lifecycle metadata does.
        obs.update({ metadata: { ...diagnostics, request_status: status } });
      }
    }
  ), {
    signal: currentExecution()?.signal,
    timeoutMs: config.llmTimeoutMs ?? LLM_REQUEST_TIMEOUT_MS,
    beforeAttempt: async (attempt) => { if (attempt > 1) await beforeModelCall(); else assertExecutionActive(); },
    onRetry: async (details) => {
      logger.warn('llm.retry_scheduled', { taskId, logical_call_id: logicalCallId, provider: config.llmProvider, model: provider.model, ...details });
      await currentExecution()?.onModelEvent?.({ event: 'retrying', model: provider.model, ...details });
    },
  });
}

/** 从可能带 markdown 围栏的输出中稳健提取 JSON。 */
export function parseJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const text = (fenced ? fenced[1] : raw).trim();
  const start = text.search(/[[{]/);
  if (start < 0) throw new Error(`LLM 输出中没有 JSON: ${text.slice(0, 200)}`);
  const candidate = text.slice(start);
  try {
    return JSON.parse(candidate);
  } catch {
    // 截断到最后一个闭合括号再试一次
    const lastBrace = Math.max(candidate.lastIndexOf('}'), candidate.lastIndexOf(']'));
    return JSON.parse(candidate.slice(0, lastBrace + 1));
  }
}
