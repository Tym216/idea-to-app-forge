import { logger } from './logger.js';

/**
 * 最小 Langfuse Cloud 观测(OpenTelemetry)。
 * - LANGFUSE_ENABLED !== 'true' 或缺 Key:不加载 SDK,所有包装函数直接透传,行为与原来一致。
 * - 默认只上传元数据与脱敏错误。调试时可显式开启 LANGFUSE_CAPTURE_CONTENT。
 * - SDK 初始化/上报/属性更新的任何异常只记日志,绝不影响业务。
 */
let tracing = null; // @langfuse/tracing 模块(或测试替身)
let sdk = null;

export function telemetryConfig(env = process.env) {
  return {
    enabled: env.LANGFUSE_ENABLED === 'true',
    publicKey: env.LANGFUSE_PUBLIC_KEY || '',
    secretKey: env.LANGFUSE_SECRET_KEY || '',
    baseUrl: env.LANGFUSE_BASE_URL || 'https://cloud.langfuse.com',
  };
}

const SECRET_PATTERNS = [
  [/Bearer\s+[A-Za-z0-9._\-]+/gi, 'Bearer [REDACTED]'],
  [/\b(sk|pk)-[A-Za-z0-9_\-]{8,}/g, '[REDACTED_KEY]'],
  [/eyJhbGciOi[A-Za-z0-9._\-]+/g, '[REDACTED_JWT]'],
  [/\bdtn_[A-Za-z0-9]+/g, '[REDACTED_KEY]'],
  [/[0-9a-f]{32}\.[A-Za-z0-9]{16}/g, '[REDACTED_KEY]'],
  [/(https?:\/\/[^\s?"']+)\?[^\s"']*/g, '$1?[REDACTED_QUERY]'], // 签名预览 URL 等
];

/** 脱敏后截断。 */
export function redact(value, max = 500) {
  let text = String(value ?? '');
  for (const [re, rep] of SECRET_PATTERNS) text = text.replace(re, rep);
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** 仅调试用:记录实际发给模型的消息；逐条脱敏并限制长度。 */
export function captureLlmMessages(messages, env = process.env) {
  if (env.LANGFUSE_CAPTURE_CONTENT !== 'true') return undefined;
  return messages.map((message) => ({
    role: message.role,
    content: redact(typeof message.content === 'string' ? message.content : JSON.stringify(message.content), 120000),
  }));
}

export function captureLlmOutput(content, env = process.env) {
  return env.LANGFUSE_CAPTURE_CONTENT === 'true' ? redact(content, 120000) : undefined;
}

/**
 * OpenAI 兼容 usage → Langfuse usageDetails。
 * input/output/total 只取真实存在的字段(缺失不填 0);
 * 供应商细分(缓存命中/未命中、推理 token)放入 metadata.usage_breakdown,不进入 usageDetails,避免被重复累加进 total。
 */
export function mapUsage(usage) {
  if (!usage || typeof usage !== 'object') return { usageDetails: undefined, breakdown: undefined };
  const num = (v) => (Number.isFinite(v) ? v : undefined);
  const usageDetails = {};
  if (num(usage.prompt_tokens) !== undefined) usageDetails.input = usage.prompt_tokens;
  if (num(usage.completion_tokens) !== undefined) usageDetails.output = usage.completion_tokens;
  if (num(usage.total_tokens) !== undefined) usageDetails.total = usage.total_tokens;
  const breakdown = {};
  const pick = (key, v) => { if (num(v) !== undefined) breakdown[key] = v; };
  pick('prompt_cache_hit_tokens', usage.prompt_cache_hit_tokens);
  pick('prompt_cache_miss_tokens', usage.prompt_cache_miss_tokens);
  pick('cached_tokens', usage.prompt_tokens_details?.cached_tokens);
  pick('reasoning_tokens', usage.completion_tokens_details?.reasoning_tokens);
  return {
    usageDetails: Object.keys(usageDetails).length ? usageDetails : undefined,
    breakdown: Object.keys(breakdown).length ? breakdown : undefined,
  };
}

export function isTelemetryActive() {
  return tracing !== null;
}

/** 在 .env 加载之后调用。失败只记日志并保持关闭。 */
export async function initTelemetry(env = process.env) {
  const cfg = telemetryConfig(env);
  if (!cfg.enabled) return false;
  if (!cfg.publicKey || !cfg.secretKey) {
    logger.warn('telemetry.disabled', { reason: 'LANGFUSE_ENABLED=true 但缺少 LANGFUSE_PUBLIC_KEY / LANGFUSE_SECRET_KEY' });
    return false;
  }
  try {
    const [{ NodeSDK }, { LangfuseSpanProcessor }, tracingModule] = await Promise.all([
      import('@opentelemetry/sdk-node'),
      import('@langfuse/otel'),
      import('@langfuse/tracing'),
    ]);
    sdk = new NodeSDK({
      spanProcessors: [
        new LangfuseSpanProcessor({
          publicKey: cfg.publicKey,
          secretKey: cfg.secretKey,
          baseUrl: cfg.baseUrl,
          // 兜底:导出前再做一次脱敏
          mask: ({ data }) => (typeof data === 'string' ? redact(data, 2000) : data),
        }),
      ],
    });
    sdk.start();
    tracing = tracingModule;
    logger.info('telemetry.started', { baseUrl: cfg.baseUrl });
    return true;
  } catch (error) {
    tracing = null;
    sdk = null;
    logger.warn('telemetry.init_failed', { error: redact(error?.message || error) });
    return false;
  }
}

const noop = { update() {} };
function safeObs(obs) {
  return {
    update(attrs) {
      try { obs.update(attrs); } catch (error) { logger.warn('telemetry.update_failed', { error: redact(error?.message || error) }); }
    },
  };
}

function levelOf(error) {
  return error?.code === 'LEASE_LOST' || error?.code === 'ABORTED' ? 'WARNING' : 'ERROR';
}

/**
 * 以当前活动上下文为父节点创建 observation 并执行 fn(obs)。
 * 抛错时标记 level/statusMessage(脱敏)后原样抛出;observation 由 SDK 在 fn 结束(含异常)时结束。
 * SDK 自身异常时降级为直接执行,fn 保证只执行一次。
 */
export async function withObservation(name, attrs, asType, fn) {
  if (!tracing) return fn(noop);
  let entered = false;
  try {
    return await tracing.startActiveObservation(
      name,
      async (raw) => {
        entered = true;
        const obs = safeObs(raw);
        obs.update(attrs);
        try {
          return await fn(obs);
        } catch (error) {
          obs.update({ level: levelOf(error), statusMessage: redact(`${error?.code ? `${error.code}: ` : ''}${error?.message || error}`) });
          throw error;
        }
      },
      { asType }
    );
  } catch (error) {
    if (entered) throw error;
    logger.warn('telemetry.observation_failed', { name, error: redact(error?.message || error) });
    return fn(noop);
  }
}

/** 每次任务执行一个根 observation(新 trace);sessionId=task_id 关联同一任务的多次执行/恢复。 */
export async function traceTask(task, fn) {
  const metadata = {
    task_id: task.id,
    execution_id: task.execution_id ?? null,
    project_id: task.project_id,
    mode: task.mode,
    kind: task.kind ?? 'new',
    resumes: task.resumes ?? 0,
    attempts: task.attempts ?? null,
  };
  const run = () => withObservation('forge.task', { metadata }, 'agent', async (obs) => {
    const result = await fn();
    obs.update({ metadata: { ...metadata, status: 'succeeded' } });
    return result;
  });
  if (!tracing?.propagateAttributes) return run();
  // 传播键使用 SDK 支持的字母数字形式；任务根节点原有 snake_case 字段保留。
  const propagated = { taskId: String(task.id) };
  if (task.project_id) propagated.projectId = String(task.project_id);
  if (task.execution_id) propagated.executionId = String(task.execution_id);
  return tracing.propagateAttributes({ sessionId: String(task.id), traceName: `forge.${task.mode}`, metadata: propagated }, run);
}

/** 有界 flush/shutdown:最多等待 timeoutMs,超时或失败只记日志。 */
export async function shutdownTelemetry(timeoutMs = 5000) {
  if (!sdk) return;
  const current = sdk;
  sdk = null;
  tracing = null;
  let timer;
  try {
    await Promise.race([
      Promise.resolve().then(() => current.shutdown()),
      new Promise((resolve) => { timer = setTimeout(() => { logger.warn('telemetry.shutdown_timeout', { timeoutMs }); resolve(); }, timeoutMs); }),
    ]);
  } catch (error) {
    logger.warn('telemetry.shutdown_failed', { error: redact(error?.message || error) });
  } finally {
    clearTimeout(timer);
  }
}

/** 仅测试使用:注入替身。 */
export function __setTelemetryForTest({ tracing: t = null, sdk: s = null } = {}) {
  tracing = t;
  sdk = s;
}
