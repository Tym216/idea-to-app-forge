/**
 * Worker 运行期配置。全部来自环境变量,禁止硬编码密钥。
 * 启动时会自动加载 app/worker/.env(若存在)。
 */
import './env.js';

// 缺失时不在导入阶段抛错,由 assertRunnable() 统一报告
const required = (name) => process.env[name] || '';

const optional = (name, fallback = '') => process.env[name] || fallback;

export const config = {
  workerId: optional('WORKER_ID', `worker-${Math.random().toString(36).slice(2, 10)}`),

  // 服务端秘密配置(仅 Worker 可见,绝不进入前端构建)
  supabaseUrl: required('SUPABASE_URL'),
  supabaseServiceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY'),

  // LLM:支持智谱与 DeepSeek
  llmProvider: optional('LLM_PROVIDER', 'deepseek'), // 'deepseek' | 'zhipu'
  deepseekApiKey: optional('DEEPSEEK_API_KEY'),
  deepseekBaseUrl: optional('DEEPSEEK_BASE_URL', 'https://api.deepseek.com/v1'),
  deepseekModel: optional('DEEPSEEK_MODEL', 'deepseek-chat'),
  zhipuApiKey: optional('ZHIPU_API_KEY'),
  zhipuBaseUrl: optional('ZHIPU_BASE_URL', 'https://open.bigmodel.cn/api/paas/v4'),
  zhipuModel: optional('ZHIPU_MODEL', 'glm-4-plus'),

  // Daytona 执行环境
  daytonaApiKey: optional('DAYTONA_API_KEY'),
  daytonaApiUrl: optional('DAYTONA_API_URL', 'https://app.daytona.io/api'),
  daytonaTarget: optional('DAYTONA_TARGET', 'us'),
  daytonaSnapshot: optional('DAYTONA_SNAPSHOT', ''),
  daytonaAutoStopMinutes: Number(optional('DAYTONA_AUTO_STOP_MINUTES', '120')),

  // 循环预算:总工具步数与错误修复轮数分开配置
  maxToolSteps: Number(optional('MAX_TOOL_STEPS', '40')),
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
  const problems = [];
  if (!config.supabaseUrl) problems.push('SUPABASE_URL');
  if (!config.supabaseServiceRoleKey) problems.push('SUPABASE_SERVICE_ROLE_KEY');
  if (config.llmProvider === 'deepseek' && !config.deepseekApiKey) problems.push('DEEPSEEK_API_KEY');
  if (config.llmProvider === 'zhipu' && !config.zhipuApiKey) problems.push('ZHIPU_API_KEY');
  if (!config.daytonaApiKey) problems.push('DAYTONA_API_KEY');
  return problems;
}
