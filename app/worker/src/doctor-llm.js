/** Read-only LLM preflight: configuration, request mapping, and optional GET /models. */
import { config } from './config.js';
import { providerProblems, resolveProvider, prepareRequest, parseProviderOptions, requestHeaders } from './llm-provider.js';

export function describeLlm(settings) {
  const problems = providerProblems(settings);
  if (problems.length) return { problems };
  const selected = resolveProvider(settings);
  const stages = {};
  for (const [stage, temperature, rawOptions, reasoningMode, reasoningPolicy] of [
    ['plan', settings.planTemperature ?? 0.3, settings.planProviderOptionsRaw, settings.planReasoningMode || 'off', settings.planReasoningPolicy || 'best_effort'],
    ['build', settings.buildTemperature ?? 0.1, settings.buildProviderOptionsRaw, 'off', 'best_effort'],
  ]) {
    const { body, capability } = prepareRequest({ providerName: selected.name, model: selected.model,
      messages: [], temperature, json: true, jsonMode: selected.jsonMode,
      reasoningMode, reasoningPolicy, reasoningProfile: settings.llmReasoningProfile || 'auto',
      nativeOptions: parseProviderOptions(rawOptions, `${stage.toUpperCase()}_PROVIDER_OPTIONS`),
      interactionMode: stage === 'plan' ? 'structured_text' : 'json_action', upstream: settings.openrouterUpstream || '' });
    stages[stage] = { requestedTemperature: temperature, sentTemperature: body.temperature ?? null,
      requestedJsonMode: selected.jsonMode, effectiveJsonMode: capability.effectiveJsonMode,
      requestedReasoning: capability.requestedReasoning, effectiveReasoning: capability.effectiveReasoning,
      negotiatedReasoning: capability.negotiatedReasoning,
      reasoningStatus: capability.downgradeReason ? 'unsupported' : capability.effectiveReasoning === 'unconfirmed' ? 'unknown' : 'supported',
      jsonStatus: selected.jsonMode === 'on' && !Object.hasOwn(body, 'response_format') ? 'unsupported'
        : Object.hasOwn(body, 'response_format') && selected.name === 'deepseek' ? 'supported' : 'unknown',
      temperatureStatus: body.temperature == null ? 'unsupported' : 'unknown', warnings: capability.warnings };
  }
  return { problems: [], selected, stages };
}

export async function inspectModelList(selected, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetchImpl(`${selected.baseUrl}/models`, { headers: requestHeaders(selected.key), signal: controller.signal });
    if (!response.ok) return { status: [404, 405].includes(response.status) ? 'unknown' : [401, 403].includes(response.status) ? 'auth_error' : 'http_error', httpStatus: response.status };
    const payload = await response.json();
    const list = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload?.models) ? payload.models : Array.isArray(payload) ? payload : null;
    if (!list) return { status: 'unknown', reason: '模型列表响应格式未识别' };
    const ids = list.map((item) => typeof item === 'string' ? item : item?.id ?? item?.name).filter((item) => typeof item === 'string');
    if (!ids.length) return { status: 'unknown', reason: '模型列表为空或没有可识别 ID' };
    return { status: ids.includes(selected.model) ? 'valid' : 'not_listed', suggestions: ids.includes(selected.model) ? [] : ids.slice(0, 8) };
  } catch (error) { return { status: 'network_error', reason: error?.name === 'AbortError' ? '模型列表查询超时' : '无法连接模型 API' }; }
  finally { clearTimeout(timer); }
}

async function main() {
  console.log('Forge LLM 配置检查（仅 GET /models，不发生成请求）');
  const report = describeLlm(config);
  if (report.problems.length) {
    report.problems.forEach((problem) => console.log(`❌ ${problem}`));
    process.exitCode = 1;
    return;
  }
  console.log(`provider: ${report.selected.name}; model: ${report.selected.model}; base URL: ${report.selected.baseUrl}`);
  for (const [stage, value] of Object.entries(report.stages)) {
    console.log(`${stage}: temperature ${value.requestedTemperature} → ${value.sentTemperature ?? 'provider default'} (${value.temperatureStatus}); JSON ${value.requestedJsonMode} → ${value.effectiveJsonMode} (${value.jsonStatus}); reasoning ${value.requestedReasoning} → ${value.negotiatedReasoning} (${value.reasoningStatus})`);
    value.warnings.forEach((warning) => console.log(`  ⚠ ${warning}`));
  }
  const models = await inspectModelList(report.selected);
  console.log(`connection/model list: ${models.status}${models.httpStatus ? ` (HTTP ${models.httpStatus})` : ''}${models.reason ? ` — ${models.reason}` : ''}`);
  if (models.suggestions?.length) console.log(`可选模型示例: ${models.suggestions.join(', ')}`);
  if (['auth_error', 'not_listed', 'http_error', 'network_error'].includes(models.status)) process.exitCode = 1;
  if (models.status === 'unknown') console.log('⚠ 当前无法确认模型是否存在；可显式运行 npm run smoke:llm 验证实际请求（可能产生费用）');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  main().catch((error) => { console.error(`❌ LLM 检查失败: ${error.message}`); process.exitCode = 1; });
}
