import { config, assertRunnable } from './config.js';
import { logger } from './logger.js';
// config.js 已先加载 .env,之后才初始化观测
import { initTelemetry, traceTask, shutdownTelemetry } from './telemetry.js';
import { withExecutionControl, monitorExecution } from './execution-control.js';
// Supabase 客户端在模块导入时创建,需在配置校验通过后再动态加载
let claimTask, heartbeat, updateTask, appendStep, setExecution, ensureLease, executeTask, admin, getSandboxProvider, processOneDeletion, processOnePreviewRecovery;

let stopping = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 错误归类:简短原因 + 下一步操作(原始堆栈另存,前端折叠显示)。 */
export function summarizeError(error, task) {
  const code = error?.code || '';
  const last = task.current_tool;
  const lastInfo = last ? `最后执行 ${last.tool},已耗时 ${Math.round(Math.max(0, performance.now() - last.started) / 1000)} 秒` : '';
  const map = {
    TASK_TIMEOUT: [`任务超时(${Math.round(config.taskTimeoutMs / 60000)} 分钟)。${lastInfo}`, '可「恢复任务」沿用已写代码继续,或缩小需求后「新建任务」'],
    FIX_LIMIT_REACHED: ['构建或浏览器验收已达到修复次数上限', '查看失败步骤后「恢复任务」或补充修复要求'],
    VERIFY_BLOCKED: ['关键功能需要外部服务配置或尚无法验证', '查看验收步骤,补齐配置后恢复任务'],
    VERIFY_TOOL_ERROR: ['浏览器验收环境故障，本轮没有通过验收', '检查验收日志与沙箱环境，修复后恢复任务；已有代码保留'],
    VERIFY_FAILED: ['浏览器验收未通过，已停止自动修复', '查看具体失败条件。尚有一次机会时可手动重试；验收定义有误则修订计划。代码与预览保留'],
    VERIFY_ATTEMPT_LIMIT: ['本任务已用完两次浏览器验收机会', '检查失败条件或修订计划，再明确开始新任务；不会继续自动调用模型'],
    ACCEPTANCE_MISSING: ['缺少本轮验收条件', '重新生成或修订计划后再构建'],
    PLAN_REVISION_REQUIRED: ['已批准的验收定义需要修订', '切换 Plan,描述需要调整的验收条件;审阅新版本后再批准构建。不要恢复旧任务'],
    PLAN_VERSION_STALE: ['任务绑定的计划已被新版本替代', '审阅并批准最新计划后构建。不要恢复旧任务'],
    AGENT_STALLED: ['同一操作反复失败,已停止', '补充更具体的需求后「新建任务」'],
    TOOL_STEP_LIMIT: ['达到最大工具步数仍未完成', '「恢复任务」继续,或拆分需求'],
    PLAN_NOT_APPROVED: ['计划尚未批准', '在计划面板审阅并批准'],
    DESIGN_INVALID: ['设计方案生成失败', '「新建任务」重试'],
    PLAN_INVALID: ['计划生成失败', '「新建任务」重试'],
    LLM_TIMEOUT: [String(error.message), '模型请求超时。检查模型服务状态后可「恢复任务」，已保存的代码会保留'],
    LLM_NETWORK: [String(error.message), '模型网络请求失败。检查 Worker 网络后可「恢复任务」，无需新建沙箱'],
    LLM_FORMAT_STALLED: ['模型连续 3 次返回无效工具调用，已停止', '查看 Langfuse 的模型输出，检查输出长度或模型兼容性后再恢复'],
    SUPABASE_NETWORK: [String(error.message), '数据库连接异常，Worker 已停止继续领取任务。检查网络后重启 Worker，并核对任务状态'],
    SUPABASE_STATE: [String(error.message), '任务状态无法可靠保存，Worker 已停止。检查数据库迁移与权限后重启'],
  };
  const [reason, next] = map[code] || [String(error?.message || error).split('\n')[0].slice(0, 160), '查看原始错误后「新建任务」或「恢复任务」'];
  return { code: code || 'ERROR', reason, next, lastTool: last?.tool || null };
}

/** 数据库耗时列是 integer；单调时钟的小数须在状态写回前取整。 */
export function makeFailurePatch(error, task, summary = summarizeError(error, task)) {
  const patch = { status: 'failed', phase: 'error', error: JSON.stringify({ ...summary, raw: String(error?.stack || error).slice(0, 4000) }) };
  if (summary.lastTool) {
    patch.last_tool = summary.lastTool;
    const elapsed = performance.now() - task.current_tool.started;
    patch.last_tool_ms = Number.isFinite(elapsed) ? Math.round(Math.max(0, elapsed)) : 0;
  }
  return patch;
}

async function handleTask(task) {
  logger.info('task.claimed', { taskId: task.id, projectId: task.project_id, mode: task.mode, kind: task.kind });

  setExecution(task.id, task.execution_id);
  const controller = new AbortController();
  let rejectControl;
  const interrupted = new Promise((_, reject) => { rejectControl = reject; });
  const abort = (error) => {
    if (controller.signal.aborted) return;
    task.aborted = error.message;
    controller.abort(error);
    rejectControl(error);
  };
  const checkLease = () => ensureLease(task.id, task.execution_id);
  const stopMonitor = monitorExecution(checkLease, abort);
  const beat = setInterval(() => {
    heartbeat(task.id).catch((error) => {
      logger.warn('heartbeat.failed', { taskId: task.id, error: String(error) });
      abort(error);
    });
  }, config.heartbeatMs);

  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`TASK_TIMEOUT: 任务执行超过 ${config.taskTimeoutMs}ms`);
      error.code = 'TASK_TIMEOUT';
      abort(error);
      reject(error);
    }, config.taskTimeoutMs);
  });
  // 每次执行一个新 trace;超时后旧执行在下一步以 ABORTED 抛出,根 observation 随之以 WARNING 结束
  let modelCall = (task.steps || []).filter((s) => s.tool === 'llm' && s.event === 'started').length;
  const onModelEvent = async ({ event, model, ms, chars, usage }) => {
    if (event === 'started') modelCall++;
    const tokens = usage ? `；输入 ${usage.input ?? '未返回'} / 输出 ${usage.output ?? '未返回'} tokens` : '';
    await appendStep(task, { tool: 'llm', event, phase: event === 'started' ? 'llm_request' : 'llm_response', ms,
      observation: event === 'started' ? `第 ${modelCall} 次模型调用：${model}，等待返回`
        : `第 ${modelCall} 次模型返回：${chars} 字符${tokens}` });
  };
  const run = withExecutionControl({ taskId: task.id, executionId: task.execution_id, signal: controller.signal, checkLease, onModelEvent },
    () => traceTask(task, () => executeTask(task)));
  run.catch(() => {}); // 超时后旧执行的后续异常只记日志

  try {
    const result = await Promise.race([run, timeout, interrupted]);
    await updateTask(task.id, { status: 'succeeded', phase: 'done' });
    logger.info('task.finished', { taskId: task.id, status: 'succeeded', previewUrl: result?.previewUrl });
  } catch (error) {
    // 完成写回在执行上下文之外，仍由原 execution_id 校验；暂停不得被 failed 覆盖。
    if (!controller.signal.aborted) controller.abort(error);
    // 中止旧执行:循环在下一步检查 aborted;停止心跳让租约自然失效,之后的任何写入都会被数据库拒绝
    task.aborted = error?.code === 'TASK_TIMEOUT' ? '任务已超时' : '任务已失败';
    clearInterval(beat);
    if (error?.code?.startsWith('SUPABASE_')) stopping = true;
    if (error?.code === 'LEASE_LOST') {
      logger.warn('task.lease_lost', { taskId: task.id, error: String(error.message) });
      return;
    }
    const summary = summarizeError(error, task);
    logger.error('task.finished', { taskId: task.id, status: 'failed', ...summary });
    const patch = makeFailurePatch(error, task, summary);
    await updateTask(task.id, patch).catch((e) => {
      if (e?.code !== 'LEASE_LOST') stopping = true;
      logger.warn('task.fail_write_rejected', { taskId: task.id, error: String(e), hint: '请核对数据库任务状态后重启 Worker' });
    });
  } finally {
    stopMonitor();
    clearTimeout(timer);
    clearInterval(beat);
    // 先等旧本地执行退栈，避免继续任务与尚未返回的沙箱操作并行。
    await run.catch(() => {});
    setExecution(task.id, null);
  }
}

async function main() {
  const missing = assertRunnable();
  if (missing.length) {
    logger.error('worker.missing_config', {
      missing,
      hint: '请在 app/worker/.env 填写后执行 npm run doctor 自检,再 npm start。',
    });
    process.exitCode = 1;
    return;
  }
  ({ claimTask, heartbeat, updateTask, appendStep, setExecution, ensureLease } = await import('./supabase.js'));
  ({ executeTask } = await import('./agent.js'));
  ({ admin } = await import('./supabase.js'));
  ({ getSandboxProvider } = await import('./sandbox/index.js'));
  ({ processOneDeletion } = await import('./deletion.js'));
  ({ processOnePreviewRecovery } = await import('./preview-recovery.js'));
  await initTelemetry().catch(() => false);
  logger.info('worker.started', {
    workerId: config.workerId,
    provider: config.llmProvider,
    maxToolSteps: config.maxToolSteps,
    maxFixRounds: config.maxFixRounds,
  });

  let idlePolls = 0;
  let lastPurge = 0;
  let sandboxProvider;
  const getSandbox = () => (sandboxProvider ||= getSandboxProvider('daytona'));
  while (!stopping) {
    try {
      // 删除优先:先处理待删除项目(沙箱清理 + 数据删除),再领取生成任务
      const deletion = await processOneDeletion({ rpc: (fn, a) => admin.rpc(fn, a), getSandbox, workerId: config.workerId })
        .catch((error) => { logger.warn('deletion.loop_error', { error: String(error) }); return null; });
      if (deletion) continue;
      const recovery = await processOnePreviewRecovery({ rpc: (fn, a) => admin.rpc(fn, a), getSandbox, workerId: config.workerId })
        .catch((error) => { logger.warn('preview.recovery_loop_error', { error: String(error) }); return null; });
      if (recovery) continue;
      if (Date.now() - lastPurge > 3600000) {
        lastPurge = Date.now();
        const { data, error } = await admin.rpc('ita_purge_audit_log', { p_retention_days: config.auditRetentionDays });
        if (error) logger.warn('audit.purge_failed', { error: error.message });
        else logger.info('audit.purged', { removed: data, retentionDays: config.auditRetentionDays });
      }
      const task = await claimTask();
      if (!task) {
        // 每约 30 秒打印一次轮询心跳,避免刷屏
        if (idlePolls % Math.max(1, Math.round(30000 / config.pollIntervalMs)) === 0) {
          logger.info('worker.polling', { workerId: config.workerId, idlePolls });
        }
        idlePolls += 1;
        await sleep(config.pollIntervalMs);
        continue;
      }
      idlePolls = 0;
      await handleTask(task);
    } catch (error) {
      logger.error('worker.loop_error', { error: String(error) });
      await sleep(config.pollIntervalMs);
    }
  }
  logger.info('worker.stopped', { workerId: config.workerId });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    logger.info('worker.stopping', { signal });
    stopping = true;
    const hardExit = setTimeout(() => process.exit(0), 7000);
    shutdownTelemetry(5000).finally(() => { clearTimeout(hardExit); process.exit(0); });
  });
}

if (process.env.FORGE_NO_MAIN !== '1') main().catch((error) => {
  logger.error('worker.fatal', { error: String(error?.stack || error) });
  process.exit(1);
});
