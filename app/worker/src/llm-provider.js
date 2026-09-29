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
  const baseUrl = String(settings[`${spec.field}BaseUrl`] || spec.baseUrl).replace(/\/+$/, '');
  const model = String(settings[`${spec.field}Model`] || spec.model).trim();
  const jsonMode = settings[`${spec.field}JsonMode`] || spec.jsonMode;
  if (!['auto', 'on', 'off'].includes(jsonMode)) throw new Error(`${spec.prefix}_JSON_MODE 只能填 auto / on / off`);
  return { name, url: `${baseUrl}/chat/completions`, key: settings[`${spec.field}ApiKey`] || '', model, jsonMode, requiresKey: !spec.keyOptional };
}

export function requestHeaders(key) {
  return { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) };
}

/** 供启动检查和 doctor 共用；新供应商必须显式填写模型。 */
export function providerProblems(settings) {
  const spec = PROVIDERS[settings.llmProvider];
  if (!spec) return [`LLM_PROVIDER（${Object.keys(PROVIDERS).join(' / ')}）`];
  const missing = [];
  if (!spec.keyOptional && !settings[`${spec.field}ApiKey`]) missing.push(`${spec.prefix}_API_KEY`);
  if (!(settings[`${spec.field}Model`] || spec.model)?.trim()) missing.push(`${spec.prefix}_MODEL`);
  try { resolveProvider(settings); } catch { missing.push(`${spec.prefix}_JSON_MODE（auto / on / off）`); }
  return missing;
}

export function supportsJsonMode(providerName, model, mode = 'auto') {
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  // 已复现的兼容问题：glm-4.5-air 的 json_object 模式可能将 package.json 输出为 package.。
  // auto 避开已知问题；显式 on 保留为受控兼容性测试入口。
  return ['deepseek', 'zhipu'].includes(providerName)
    && !(providerName === 'zhipu' && ['glm-4-plus', 'glm-4.5-air'].includes(model));
}

export function buildRequestBody({ providerName, model, messages, temperature, json, jsonMode = 'auto', upstream = '' }) {
  return {
    model, messages,
    // 新供应商不默认传 temperature，避免推理模型不接受该参数。
    ...(['deepseek', 'zhipu'].includes(providerName) && temperature !== undefined ? { temperature } : {}),
    ...(json && supportsJsonMode(providerName, model, jsonMode) ? { response_format: { type: 'json_object' } } : {}),
    ...(providerName === 'openrouter' ? {
      provider: { allow_fallbacks: false, ...(upstream.trim() ? { order: [upstream.trim()] } : {}) },
    } : {}),
  };
}
