/**
 * Worker 运行期配置。全部来自环境变量,禁止硬编码密钥。
 * 启动时会自动加载 app/worker/.env(若存在)。
 */
import { envFileExplicit } from './env.js';
import { environmentProblems, assertKeyProject } from '../../shared/environment.js';
import { providerProblems } from './llm-provider.js';

// 缺失时不在导入阶段抛错,由 assertRunnable() 统一报告
const required = (name) => process.env[name] || '';

const optional = (name, fallback = '') => process.env[name] || fallback;

export const config = {
  environmentId: required('FORGE_ENVIRONMENT_ID'),
  expectedSupabaseProjectRef: required('EXPECTED_SUPABASE_PROJECT_REF'),
  envFileExplicit,
  workerId: optional('WORKER_ID', `worker-${Math.random().toString(36).slice(2, 10)}`),

  // 服务端秘密配置(仅 Worker 可见,绝不进入前端构建)
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  // LLM:运行进程启动时选择供应商，不做自动模型降级
  llmProvider: optional('LLM_PROVIDER', 'deepseek'),
  llmModel: optional('LLM_MODEL'),
  llmBaseUrl: optional('LLM_BASE_URL'),
  llmApiKey: optional('LLM_API_KEY'),
  llmJsonMode: optional('LLM_JSON_MODE'),
  llmTimeoutMs: Number(optional('LLM_TIMEOUT_MS', '120000')),
  // Keep raw values for strict validation; unset caps preserve legacy requests.
  llmMaxOutputTokens: optional('LLM_MAX_OUTPUT_TOKENS'),
  llmMaxOutputTokensPlan: optional('LLM_MAX_OUTPUT_TOKENS_PLAN'),
  llmMaxOutputTokensMemory: optional('LLM_MAX_OUTPUT_TOKENS_MEMORY'),
  llmRequireOutputCap: optional('LLM_REQUIRE_OUTPUT_CAP'),
  llmOmitTemperature: optional('LLM_OMIT_TEMPERATURE'),
  llmReasoningEffortPlan: optional('LLM_REASONING_EFFORT_PLAN'),
  llmReasoningEffortMemory: optional('LLM_REASONING_EFFORT_MEMORY'),
  llmRequireReasoningPolicy: optional('LLM_REQUIRE_REASONING_POLICY'),
  llmMaxOutputTokensBuild: optional('LLM_MAX_OUTPUT_TOKENS_BUILD'),
  llmReasoningEffortBuild: optional('LLM_REASONING_EFFORT_BUILD'),
  llmMaxOutputTokensDesign: optional('LLM_MAX_OUTPUT_TOKENS_DESIGN'),
  llmReasoningEffortDesign: optional('LLM_REASONING_EFFORT_DESIGN'),
  llmMaxOutputTokensActionPlan: optional('LLM_MAX_OUTPUT_TOKENS_ACTION_PLAN'),
  llmReasoningEffortActionPlan: optional('LLM_REASONING_EFFORT_ACTION_PLAN'),
  llmRequireCostBudget: optional('LLM_REQUIRE_COST_BUDGET'),
  llmCostCurrency: optional('LLM_COST_CURRENCY'),
  llmCostInputPerMillion: optional('LLM_COST_INPUT_PER_MILLION'),
  llmCostOutputPerMillion: optional('LLM_COST_OUTPUT_PER_MILLION'),
  llmMaxTheoreticalCostPerExecution: optional('LLM_MAX_THEORETICAL_COST_PER_EXECUTION'),
  llmCostInputUsdPerMillion: optional('LLM_COST_INPUT_USD_PER_MILLION'),
  llmCostOutputUsdPerMillion: optional('LLM_COST_OUTPUT_USD_PER_MILLION'),
  llmMaxTheoreticalCostUsdPerExecution: optional('LLM_MAX_THEORETICAL_COST_USD_PER_EXECUTION'),
  llmDebugCaptureRequest: optional('LLM_DEBUG_CAPTURE_REQUEST', 'false') === 'true',
  planTemperature: optional('PLAN_TEMPERATURE') === '' ? null : Number(optional('PLAN_TEMPERATURE')),
  buildTemperature: optional('BUILD_TEMPERATURE') === '' ? null : Number(optional('BUILD_TEMPERATURE')),
  planProviderOptionsRaw: optional('PLAN_PROVIDER_OPTIONS'),
  buildProviderOptionsRaw: optional('BUILD_PROVIDER_OPTIONS'),
  planReasoningMode: optional('PLAN_REASONING_MODE', 'off'),
  planReasoningPolicy: optional('PLAN_REASONING_POLICY', 'best_effort'),
  llmReasoningProfile: optional('LLM_REASONING_PROFILE', 'auto'),
  deepseekApiKey: optional('DEEPSEEK_API_KEY'),
  deepseekBaseUrl: optional('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
  deepseekModel: optional('DEEPSEEK_MODEL', 'deepseek-chat'),
  zhipuApiKey: optional('ZHIPU_API_KEY'),
  zhipuBaseUrl: optional('ZHIPU_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4'),
  zhipuModel: optional('ZHIPU_MODEL', 'glm-4-plus'),
  deepseekJsonMode: optional('DEEPSEEK_JSON_MODE', 'auto'),
  zhipuJsonMode: optional('ZHIPU_JSON_MODE', 'auto'),
  openrouterApiKey: optional('OPENROUTER_API_KEY'),
  openrouterBaseUrl: optional('OPENROUTER_BASE_URL', 'https://openrouter.ai/api/v1'),
  openrouterModel: optional('OPENROUTER_MODEL'),
  openrouterJsonMode: optional('OPENROUTER_JSON_MODE', 'off'),
  openrouterUpstream: optional('OPENROUTER_UPSTREAM'),
  geminiApiKey: optional('GEMINI_API_KEY'),
  geminiBaseUrl: optional('GEMINI_BASE_URL', 'https://generativelanguage.googleapis.com/v1beta/openai'),
  geminiModel: optional('GEMINI_MODEL'),
  geminiJsonMode: optional('GEMINI_JSON_MODE', 'off'),
  ollamaApiKey: optional('OLLAMA_API_KEY'),
  ollamaBaseUrl: optional('OLLAMA_BASE_URL', 'http://127.0.0.1:11434/v1'),
  ollamaModel: optional('OLLAMA_MODEL'),
  ollamaJsonMode: optional('OLLAMA_JSON_MODE', 'off'),
  lmstudioApiKey: optional('LMSTUDIO_API_KEY'),
  lmstudioBaseUrl: optional('LMSTUDIO_BASE_URL', 'http://127.0.0.1:1234/v1'),
  lmstudioModel: optional('LMSTUDIO_MODEL'),
  lmstudioJsonMode: optional('LMSTUDIO_JSON_MODE', 'off'),

  aliyunApiKey: optional('ALIYUN_API_KEY'),
  aliyunBaseUrl: optional('ALIYUN_BASE_URL'),
  aliyunModel: optional('ALIYUN_MODEL'),

  // Daytona 执行环境
  daytonaApiKey: optional('DAYTONA_API_KEY'),
  daytonaApiUrl: optional('DAYTONA_API_URL', 'https://app.daytona.io/api'),
  daytonaTarget: optional('DAYTONA_TARGET', 'us'),
  daytonaSnapshot: optional('DAYTONA_SNAPSHOT', ''),
  daytonaAutoStopMinutes: Number(optional('DAYTONA_AUTO_STOP_MINUTES', '120')),

  // 循环预算:总工具步数与错误修复轮数分开配置
  maxToolSteps: Number(optional('MAX_TOOL_STEPS', '40')),
  actionFusionEnabled: optional('ACTION_FUSION_ENABLED', 'false') === 'true',
  fusionMaxFiles: Number(optional('FUSION_MAX_FILES', '8')),
  fusionMaxBytes: Number(optional('FUSION_MAX_BYTES', '131072')),
  metricsCodeVersion: optional('METRICS_CODE_VERSION', 'retry-v1'),
  maxFixRounds: Number(optional('MAX_FIX_ROUNDS', '1')),

  // 任务租约与超时
  // 审计记录保留天数(产品默认 90 天);Worker 每小时清理一次过期记录
  auditRetentionDays: Number(optional('AUDIT_RETENTION_DAYS', '90')),
  leaseSeconds: Number(optional('LEASE_SECONDS', '120')),
  heartbeatMs: Number(optional('HEARTBEAT_MS', '30000')),
  pollIntervalMs: Number(optional('POLL_INTERVAL_MS', '3000')),
  taskTimeoutMs: Number(optional('TASK_TIMEOUT_MS', String(15 * 60 * 1000))),
  commandTimeoutMs: Number(optional('COMMAND_TIMEOUT_MS', String(5 * 60 * 1000))),
};

export function assertRunnable() {
  const problems = environmentProblems({ environmentId: config.environmentId, expectedRef: config.expectedSupabaseProjectRef, supabaseUrl: config.supabaseUrl, explicit: config.envFileExplicit });
  for (const [name, value] of [['FUSION_MAX_FILES', config.fusionMaxFiles], ['FUSION_MAX_BYTES', config.fusionMaxBytes]]) {
    if (!Number.isInteger(value) || value < 1 || value > (name === 'FUSION_MAX_FILES' ? 32 : 1048576)) problems.push(name);
  }
  if (!config.supabaseUrl) problems.push('SUPABASE_URL');
  if (!config.supabaseServiceRoleKey) problems.push('SUPABASE_SERVICE_ROLE_KEY');
  else try { assertKeyProject(config.supabaseServiceRoleKey,config.expectedSupabaseProjectRef); } catch(e) { problems.push(e.message); }
  problems.push(...providerProblems(config));
  if (!config.daytonaApiKey) problems.push('DAYTONA_API_KEY');
  return problems;
}
