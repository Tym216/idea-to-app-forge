import { config } from './config.js';
import { logger } from './logger.js';
import { beforeModelCall, currentExecution, assertExecutionActive } from './execution-control.js';
import { withObservation, mapUsage, captureLlmMessages, captureLlmOutput } from './telemetry.js';

/**
 * 统一的 LLM 客户端。智谱与 DeepSeek 均兼容 OpenAI Chat Completions 协议,
 * 因此共用一套请求/响应处理。
 */
function resolveProvider() {
  if (config.llmProvider === 'zhipu') {
    return { url: `${config.zhipuBaseUrl}/chat/completions`, key: config.zhipuApiKey, model: config.zhipuModel };
  }
  return {
    url: `${config.deepseekBaseUrl}/chat/completions`,
    key: config.deepseekApiKey,
    model: config.deepseekModel,
  };
}

/**
 * 智谱 glm-4-plus 在 response_format=json_object 下会截断字符串中的扩展名
 * (package.json → package.),因此对该组合不发送此参数,仍靠提示词要求 JSON 并由 parseJson 解析。
 */
export function supportsJsonMode(providerName, model) {
  return !(providerName === 'zhipu' && model === 'glm-4-plus');
}

export function buildRequestBody({ providerName, model, messages, temperature, json }) {
  return {
    model,
    messages,
    temperature,
    ...(json && supportsJsonMode(providerName, model) ? { response_format: { type: 'json_object' } } : {}),
  };
}

export const LLM_REQUEST_TIMEOUT_MS = 120000;

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

export async function chat(messages, { temperature = 0.2, json = false, taskId } = {}) {
  await beforeModelCall();
  const provider = resolveProvider();
  if (!provider.key) {
    throw new Error(`LLM API key missing for provider "${config.llmProvider}". 请在 Worker 环境变量中配置。`);
  }

  const body = buildRequestBody({
    providerName: config.llmProvider,
    model: provider.model,
    messages,
    temperature,
    json,
  });

  // 调试开关打开时记录脱敏后的模型输入输出;默认只记录元数据与 usage。
  const traceInput = captureLlmMessages(messages);
  return withObservation(
    'llm.chat',
    {
      model: provider.model,
      ...(traceInput !== undefined ? { input: traceInput } : {}),
      metadata: { provider: config.llmProvider, json, task_id: taskId ?? null },
    },
    'generation',
    async (obs) => {
      const started = performance.now();
      await currentExecution()?.onModelEvent?.({ event: 'started', model: provider.model });
      assertExecutionActive();
      let response;
      try {
        response = await fetch(provider.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${provider.key}` },
          body: JSON.stringify(body),
          signal: AbortSignal.any([AbortSignal.timeout(LLM_REQUEST_TIMEOUT_MS), ...[currentExecution()?.signal].filter(Boolean)]),
        });
      } catch (error) {
        assertExecutionActive();
        const classified = classifyModelFetchError(error, {
          providerName: config.llmProvider, model: provider.model, elapsedMs: Math.max(0, performance.now() - started),
        });
        logger.warn('llm.request_failed', {
          taskId, provider: config.llmProvider, model: provider.model,
          code: classified.code, causeCode: classified.causeCode, ms: Math.max(0, performance.now() - started),
        });
        throw classified;
      }

      if (!response.ok) {
        const text = await response.text();
        const error = new Error(`LLM ${config.llmProvider} ${response.status}: ${text.slice(0, 500)}`);
        error.httpStatus = response.status;
        throw error;
      }

      const payload = await response.json();
      assertExecutionActive();
      const content = payload?.choices?.[0]?.message?.content ?? '';
      const traceOutput = captureLlmOutput(content);
      const ms = Math.max(0, performance.now() - started);
      const { usageDetails, breakdown } = mapUsage(payload?.usage);
      obs.update({
        model: payload?.model || provider.model,
        ...(traceOutput !== undefined ? { output: traceOutput } : {}),
        ...(usageDetails ? { usageDetails } : {}),
        metadata: {
          provider: config.llmProvider,
          requested_model: provider.model,
          response_model: payload?.model ?? null,
          ms,
          status: 'ok',
          finish_reason: payload?.choices?.[0]?.finish_reason ?? null,
          output_chars: content.length,
          ...(breakdown ? { usage_breakdown: breakdown } : {}),
        },
      });
      logger.info('llm.completed', { taskId, provider: config.llmProvider, model: provider.model, ms, chars: content.length });
      await currentExecution()?.onModelEvent?.({ event: 'finished', model: provider.model, ms, chars: content.length, usage: usageDetails });
      return content;
    }
  );
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
