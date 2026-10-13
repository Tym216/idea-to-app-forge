import { costPolicyProblems } from './llm-cost-admission.js';
import { applyOutputCap, outputCapProblems, resolveOutputCap } from './llm-output-cap.js';
import { parseOmitTemperature, resolveTemperatureOmission } from './llm-temperature.js';
import { REASONING_EFFORTS, applyReasoningPolicy, reasoningPolicyProblems, resolveReasoningPolicy } from './llm-reasoning-policy.js';

/** Chat Completions 供应商注册表；不加载 .env，不包含真实密钥。 */
export const PROVIDERS = Object.freeze({
  deepseek: { prefix: 'DEEPSEEK', field: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', jsonMode: 'auto', help: 'https://platform.deepseek.com' },
  zhipu: { prefix: 'ZHIPU', field: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus', jsonMode: 'auto', help: 'https://open.bigmodel.cn' },
  openrouter: { prefix: 'OPENROUTER', field: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', jsonMode: 'off', help: 'https://openrouter.ai/settings/keys' },
  gemini: { prefix: 'GEMINI', field: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', model: '', jsonMode: 'off', help: 'https://aistudio.google.com/apikey' },
  ollama: { prefix: 'OLLAMA', field: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: '', jsonMode: 'off', keyOptional: true, help: '本地 Ollama' },
  lmstudio: { prefix: 'LMSTUDIO', field: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', model: '', jsonMode: 'off', keyOptional: true, help: '本地 LM Studio' },
});

export function resolveProvider(settings) {
  const name = settings.llmProvider;
  const spec = PROVIDERS[name];
  if (!spec) throw new Error(`LLM_PROVIDER 无效，可选 ${Object.keys(PROVIDERS).join(' / ')}`);
  const baseUrl = String(settings.llmBaseUrl || settings[`${spec.field}BaseUrl`] || spec.baseUrl).replace(/\/+$/, '');
  let parsedUrl;
  try { parsedUrl = new URL(baseUrl); } catch { throw new Error('LLM_BASE_URL 无效；请填写 HTTP(S) API 根地址'); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || !parsedUrl.hostname || parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash) throw new Error(`LLM_BASE_URL 必须是无内嵌凭证的 HTTP(S) 地址`);
  const model = String(settings.llmModel || settings[`${spec.field}Model`] || spec.model).trim();
  const jsonMode = settings.llmJsonMode || settings[`${spec.field}JsonMode`] || spec.jsonMode;
  if (!['auto', 'on', 'off'].includes(jsonMode)) throw new Error(`LLM_JSON_MODE 只能填 auto / on / off`);
  return { name, baseUrl, url: `${baseUrl}/chat/completions`, key: settings.llmApiKey || settings[`${spec.field}ApiKey`] || '', model, jsonMode, requiresKey: !spec.keyOptional };
}

export function requestHeaders(key) {
  return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

/** 供启动检查和 doctor 共用；新供应商必须显式填写模型。 */
export function providerProblems(settings) {
  const spec = PROVIDERS[settings.llmProvider];
  if (!spec) return [`LLM_PROVIDER（${Object.keys(PROVIDERS).join(' / ')}）`];
  const missing = [...outputCapProblems(settings), ...reasoningPolicyProblems(settings), ...costPolicyProblems(settings)];
  try { resolveTemperatureOmission(settings); } catch (error) { missing.push(error.message); }
  if (!spec.keyOptional && !(settings.llmApiKey || settings[`${spec.field}ApiKey`])) missing.push(`${spec.prefix}_API_KEY 或 LLM_API_KEY`);
  if (!(settings.llmModel || settings[`${spec.field}Model`] || spec.model)?.trim()) missing.push(`${spec.prefix}_MODEL 或 LLM_MODEL`);
  try { resolveProvider(settings); } catch (error) { missing.push(error.message); }
  if (!Number.isInteger(settings.llmTimeoutMs ?? 120000) || (settings.llmTimeoutMs ?? 120000) < 1000 || (settings.llmTimeoutMs ?? 120000) > 600000) missing.push('LLM_TIMEOUT_MS（1000–600000）');
  for (const [label, value] of [['PLAN_TEMPERATURE', settings.planTemperature], ['BUILD_TEMPERATURE', settings.buildTemperature]]) {
    if (value != null && (!Number.isFinite(value) || value < 0 || value > 2)) missing.push(`${label}（0–2）`);
  }
  for (const [label, value] of [['PLAN_PROVIDER_OPTIONS', settings.planProviderOptionsRaw], ['BUILD_PROVIDER_OPTIONS', settings.buildProviderOptionsRaw]]) {
    try { parseProviderOptions(value, label); } catch (error) { missing.push(error.message); }
  }
  if (!['off', 'low', 'high'].includes(settings.planReasoningMode || 'off')) missing.push('PLAN_REASONING_MODE（off / low / high）');
  if (!['best_effort', 'strict'].includes(settings.planReasoningPolicy || 'best_effort')) missing.push('PLAN_REASONING_POLICY（best_effort / strict）');
  if (!['auto', 'reasoning_effort'].includes(settings.llmReasoningProfile || 'auto')) missing.push('LLM_REASONING_PROFILE（auto / reasoning_effort）');
  return missing;
}

export function supportsJsonMode(providerName, model, mode = 'auto') {
  if (mode === 'off') return false;
  // glm-4.5-air 已复现 response_format 导致文件名损坏，on 也不能强制覆盖。
  if (providerName === 'zhipu' && model === 'glm-4.5-air') return false;
  if (mode === 'on') return true;
  return ['deepseek', 'zhipu'].includes(providerName)
    && !(providerName === 'zhipu' && model === 'glm-4-plus');
}


/** Empty means legacy config; a JSON object (including {}) opts into native stage options. */
export function parseProviderOptions(raw, label = 'PROVIDER_OPTIONS') {
  if (raw == null || raw === '') return null;
  let value;
  try { value = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw new Error(`${label} 必须是合法 JSON 对象`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是 JSON 对象`);
  return value;
}

/** Only mappings already represented in this adapter are forwarded. Unknown optional fields are omitted. */
export function resolveNativeOptions(providerName, model, options) {
  const parameters = {}, warnings = [];
  for (const [key, value] of Object.entries(options)) {
    let supported = false;
    if (providerName === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model)) {
      if (key === 'thinking' && ['enabled', 'disabled'].includes(value?.type)) supported = true;
      if (key === 'reasoning_effort' && ['low', 'high'].includes(value)) supported = true;
    } else if (providerName === 'openrouter') {
      if (key === 'reasoning' && REASONING_EFFORTS.includes(value?.effort)) supported = true;
    } else if (providerName === 'gemini' && /^gemini-(2\.5|3)[.-]/.test(model)) {
      if (key === 'reasoning_effort' && ['none', 'low', 'medium', 'high'].includes(value)) supported = true;
    }
    if (supported) parameters[key] = value;
    else warnings.push(`${providerName}/${model} 尚未确认可选参数 ${key} 的映射；已省略`);
  }
  const omitTemperature = providerName === 'deepseek' && parameters.thinking?.type === 'enabled';
  return { parameters, warnings, omitTemperature, requestedReasoning: 'native', negotiatedReasoning: Object.keys(parameters).length ? 'native' : 'provider_default', effectiveReasoning: 'unconfirmed', downgradeReason: warnings.length ? warnings.join('; ') : null };
}

export function prepareRequest({ providerName, model, messages, temperature, json, jsonMode = 'auto', upstream = '', reasoningMode = 'off', reasoningPolicy = 'best_effort', interactionMode = 'structured_text', reasoningProfile = 'auto', nativeOptions = null, maxOutputTokens = null, requireOutputCap = false, outputCapSource = null, omitTemperature = false, trustedReasoningEffort = null, requireReasoningPolicy = false, reasoningPolicySource = null, reasoningPolicyPurpose = null }) {
  const capability = nativeOptions === null
    ? resolveCapabilities({ providerName, model, reasoningMode, reasoningPolicy, interactionMode, reasoningProfile })
    : resolveNativeOptions(providerName, model, parseProviderOptions(nativeOptions));
  if (!['structured_text', 'json_action'].includes(interactionMode)) throw capabilityError('当前仅支持 structured_text / json_action；native_tools 尚未接入执行循环');
  const body = buildCompatibleBody({ providerName, model, messages, temperature: capability.omitTemperature ? undefined : temperature, json, jsonMode, upstream });
  Object.assign(body, capability.parameters);
  const trustedOmission = parseOmitTemperature(omitTemperature);
  const temperatureOmitted = capability.omitTemperature || trustedOmission;
  const temperatureOmitSource = capability.omitTemperature
    ? (trustedOmission ? 'both' : 'provider_capability')
    : (trustedOmission ? 'trusted_config' : null);
  // Final invariant after native mapping: omission means the property does not exist.
  if (temperatureOmitted) delete body.temperature;
  const outputBudget = applyOutputCap(body, { providerName, maxOutputTokens, requireOutputCap });
  const trustedReasoning = applyReasoningPolicy(body, { providerName, trustedReasoningEffort, requireReasoningPolicy });
  const jsonSent = Object.hasOwn(body, 'response_format');
  const warnings = [...capability.warnings];
  if (trustedReasoningEffort != null) warnings.push('可信 reasoning policy 已覆盖 native options；已发送 effort=' + trustedReasoningEffort + '，上游实际执行仍需验证');
  if (trustedOmission) warnings.push('LLM_OMIT_TEMPERATURE=true；最终请求已省略 temperature');
  if (json && jsonMode !== 'off' && !jsonSent) warnings.push(`${providerName}/${model} 的 JSON mode ${jsonMode} 未生效；仅使用提示词与解析校验`);
  if (capability.omitTemperature && temperature !== undefined && !warnings.some((warning) => warning.includes('temperature'))) warnings.push('该模型推理模式不支持 temperature；已省略');
  return { body, capability: { ...capability, ...outputBudget, ...trustedReasoning, trustedReasoningEffort, requireReasoningPolicy, reasoningPolicySource, reasoningPolicyPurpose, requestedMaxOutputTokens: maxOutputTokens, outputCapSource, requireOutputCap, warnings, requestedJsonMode: jsonMode, effectiveJsonMode: jsonSent ? 'on' : 'off', temperatureOmitted, temperatureOmitSource, requestedTemperature: temperature ?? null, sentTemperature: body.temperature ?? null } };
}

export function buildRequestBody(options) { return prepareRequest(options).body; }

/** Diagnostic callers that do not use chat must still resolve the trusted runtime budget. */
export function buildConfiguredRequestBody(settings, purpose, options) {
  return prepareRequest({ ...options, ...resolveOutputCap(settings, purpose), ...resolveTemperatureOmission(settings), ...resolveReasoningPolicy(settings, purpose) }).body;
}

function buildCompatibleBody({ providerName, model, messages, temperature, json, jsonMode, upstream }) {
  return {
    model, messages,
    // Preserve caller sampling semantics across compatible providers; add explicit capability exceptions only when proven.
    ...(temperature !== undefined ? { temperature } : {}),
    ...(json && supportsJsonMode(providerName, model, jsonMode) ? { response_format: { type: 'json_object' } } : {}),
    ...(providerName === 'openrouter' ? {
      provider: { allow_fallbacks: false, ...(upstream.trim() ? { order: [upstream.trim()] } : {}) },
    } : {}),
  };
}

const capabilityError = (message) => Object.assign(new Error(message), { code: 'LLM_CAPABILITY_UNSUPPORTED' });

/** Model-scoped mappings. Unknown off is explicitly unconfirmed, never reported as disabled. */
export function resolveCapabilities({ providerName, model, reasoningMode = 'off', reasoningPolicy = 'best_effort', interactionMode = 'structured_text', reasoningProfile = 'auto' }) {
  if (!['best_effort', 'strict'].includes(reasoningPolicy)) throw capabilityError('reasoningPolicy 只能是 best_effort / strict');
  if (!['off', 'low', 'high'].includes(reasoningMode)) throw capabilityError('reasoningMode 只能是 off / low / high');
  if (!['structured_text', 'json_action'].includes(interactionMode)) throw capabilityError('当前仅支持 structured_text / json_action；native_tools 尚未接入执行循环');
  if (!['auto', 'reasoning_effort'].includes(reasoningProfile)) throw capabilityError('LLM_REASONING_PROFILE 只能是 auto / reasoning_effort');
  const localProfileSupported = reasoningProfile === 'reasoning_effort' && ['ollama', 'lmstudio'].includes(providerName);
  const enabled = reasoningMode !== 'off';
  let parameters = {}, omitTemperature = false, effectiveReasoning = 'unconfirmed';
  let downgradeReason = null;
  const warnings = [];
  if (reasoningProfile === 'reasoning_effort' && !localProfileSupported) {
    warnings.push('reasoning_effort profile 仅确认适用于本地模型；已忽略此可选偏好');
  }
  if (providerName === 'deepseek' && ['deepseek-flash', 'deepseek-v4-pro'].includes(model)) {
    parameters = { thinking: { type: enabled ? 'enabled' : 'disabled' }, ...(enabled ? { reasoning_effort: reasoningMode } : {}) };
    omitTemperature = enabled;
    effectiveReasoning = reasoningMode;
  } else if (providerName === 'openrouter') {
    parameters = { reasoning: { effort: enabled ? reasoningMode : 'none' } };
    warnings.push('OpenRouter 已发送推理偏好；是否支持及实际生效取决于所选模型/上游，未自动探测能力');
  } else if (providerName === 'gemini' && /^gemini-(2\.5|3)[.-]/.test(model)) {
    if (!enabled && (/^gemini-3[.-]/.test(model) || /^gemini-2\.5-pro(?:-|$)/.test(model))) {
      warnings.push(`${model} 无法确认支持关闭推理；省略 reasoning_effort=none，沿用模型默认行为`);
    } else {
      parameters = { reasoning_effort: enabled ? reasoningMode : 'none' };
      effectiveReasoning = reasoningMode;
    }
  } else if (localProfileSupported) {
    parameters = { reasoning_effort: enabled ? reasoningMode : 'none' };
    warnings.push('本地 reasoning_effort 映射由配置显式启用；请确认模型和服务端支持对应等级');
  } else {
    if (enabled) {
      downgradeReason = `${providerName}/${model} 尚无已确认的推理参数映射`;
      if (reasoningPolicy === 'strict') throw capabilityError(downgradeReason);
      warnings.push(`${downgradeReason}；已降级为 off 请求，不发送推理参数；服务端实际行为未确认`);
    } else {
      warnings.push('该模型没有推理关闭映射，未发送推理参数；沿用服务端行为，不能保证推理关闭');
    }
  }
  if (omitTemperature) warnings.push('当前推理模式不支持 temperature，已省略');
  return { interactionMode, reasoningPolicy, requestedReasoning: reasoningMode, negotiatedReasoning: downgradeReason ? 'off' : reasoningMode, effectiveReasoning, downgradeReason, parameters, omitTemperature, warnings };
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const count = (n) => Number.isFinite(n) && n >= 0 ? n : null;
  return { inputTokens: count(usage.prompt_tokens), outputTokens: count(usage.completion_tokens),
    totalTokens: count(usage.total_tokens), details: usage };
}

const textParts = (value) => typeof value === 'string' ? value : Array.isArray(value)
  ? value.filter((p) => p?.type === 'text' && typeof p.text === 'string').map((p) => p.text).join('') : '';

/** Chat Completions envelope only. Reasoning is never concatenated into executable text. */
export function normalizeResponse(payload) {
  const choice = payload?.choices?.[0];
  const message = choice?.message || {};
  const reasoning = textParts(message.reasoning_content) || textParts(message.reasoning)
    || (Array.isArray(message.reasoning_details) ? message.reasoning_details
      .filter((p) => p?.type === 'reasoning.text' && typeof p.text === 'string').map((p) => p.text).join('') : '');
  return {
    text: textParts(message.content), reasoning: reasoning || null,
    toolCalls: Array.isArray(message.tool_calls) ? message.tool_calls.map((t) => ({
      id: t?.id ?? null, type: t?.type ?? null, name: t?.function?.name ?? null, arguments: t?.function?.arguments ?? null,
    })) : [],
    finishReason: choice?.finish_reason ?? null,
    // Canonical counters plus raw details for telemetry; never invent missing token counts.
    usage: normalizeUsage(payload?.usage),
  };
}

export function validateResponse(response, interactionMode = 'structured_text') {
  if (interactionMode === 'native_tools') {
    if (response.toolCalls.length && response.toolCalls.every((t) => t.type === 'function' && t.id && t.name && typeof t.arguments === 'string')) return;
  } else if (!['structured_text', 'json_action'].includes(interactionMode)) throw capabilityError('未知 interactionMode');
  else if (response.toolCalls.length) throw Object.assign(new Error('文本交互模式收到 native tool_calls，未执行'), { code: 'LLM_INTERACTION_MISMATCH' });
  if (!response.text.trim()) throw Object.assign(new Error('模型未返回最终文本；reasoning 不能代替最终响应'), { code: 'LLM_INVALID_RESPONSE' });
}
