import { config, assertRunnable } from './config.js';
import { logger } from './logger.js';
import { describeLlm, inspectModelList } from './doctor-llm.js';
// config.js 已先加载 .env,之后才初始化观测
import { initTelemetry, traceTask, shutdownTelemetry } from './telemetry.js';
import { withExecutionControl, monitorExecution, isSupabaseError } from './execution-control.js';
import { createTaskMetrics, metricsSnapshot } from './task-metrics.js';
// Supabase 客户端延迟创建；配置校验与共享环境 guard 必须先通过
let inspectRuntimeWriter, getProject, checkWorkspaceSchema, completedCheckpoint, claimTask, heartbeat, updateTask, appendStep, setExecution, ensureLease, executeTask, admin, getSandboxProvider, processOneDeletion, processOnePreviewRecovery;

let stopping = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 错误归类:简短原因 + 下一步操作(原始堆栈另存,前端折叠显示)。 */
export function summarizeError(error, task) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const last = task.current_tool;
  const lastInfo = last ? `最后执行 ${last.tool},已耗时 ${Math.round(Math.max(0, performance.now() - last.started) / 1000)} 秒` : '';
  const map = {
    USER_APPLY_VALIDATION_FAILED: ['手工修改已确认，但构建/验证未完成；源码保留', '查看错误后重新加载编辑，或恢复原任务继续固定验证；不会自动调用模型修复'],
    WORKSPACE_REVISION_CONFLICT: ['工作区已变化，本次请求依据过期', 'Reload and reapply your edit. 不会自动合并或覆盖新版本'],
    WORKSPACE_BASIS_INVALID: ['稳定版本的检查依据与当前运行环境不兼容', '先核对运行环境与稳定版本；不会调用模型补检查，也未应用新修改'],
    SANDBOX_OWNERSHIP: ['沙箱环境或项目归属不匹配，已拒绝访问', '核对 Demo 标签及独立凭据；不会为旧 Main 沙箱自动补标签'],
    WORKSPACE_PARTIAL: ['部分文件已写入，整组源码尚未确认提交', '保留原沙箱；恢复会先核对基线、目标与旧锁，只接续原请求，不重复覆盖已完成文件'],
    WORKSPACE_RECONCILE_REQUIRED: ['工作区仍有待核对操作，已拒绝新写入或预览恢复', '先核对/恢复原任务；不能用新的 execution 或新沙箱绕过'],
    WORKSPACE_UNCERTAIN: ['工作区操作尚未确认结束，已停止新写入', '保留源码与原沙箱；核对命令/进程及完整 manifest 后再恢复，不能直接重跑'],
    WORKSPACE_CONFLICT: ['沙箱源码与已确认基线或预期结果不一致', '保留冲突内容，核对文件差异；不会自动覆盖'],
    WORKSPACE_LEGACY_QUIESCENCE_REQUIRED: ['旧版写入 journal 尚未确认停止', '先停止旧 Worker 并核对原沙箱的进程、文件与旧 journal；不能绕过 fence'],
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
    CHANGE_UNCERTAIN: ['文件操作结果未确认，已停止后续执行', '恢复前自动核对原沙箱与数据库。若仍有版本冲突或原沙箱不可访问，请人工核对；不要直接重放写入'],
    COMMAND_UNCERTAIN: ['命令超时，结果尚未确认；未自动重跑', '先核对沙箱进程、日志及操作结果，不要直接恢复并重复执行命令'],
    START_FAILED: ['开发服务启动失败，已停止自动推进', '查看启动日志，修复环境后恢复任务；代码保留'],
    TOOL_STEP_LIMIT: ['达到最大工具步数仍未完成', '「恢复任务」继续,或拆分需求'],
    PLAN_NOT_APPROVED: ['计划尚未批准', '在计划面板审阅并批准'],
    DESIGN_INVALID: ['设计方案生成失败', '「新建任务」重试'],
    PLAN_INVALID: ['计划生成失败', '「新建任务」重试'],
    LLM_PROVIDER_BUSY: [task.mode==='plan'?'模型服务暂时繁忙，本轮未产生代码修改。你可以继续重试。':'模型服务暂时繁忙，已保存代码与进度。可以继续重试。', '稍后点击继续重试；已有项目与代码保留'],
    LLM_TIMEOUT: [String(error.message), '模型请求超时。检查模型服务状态后可「恢复任务」，已保存的代码会保留'],
    LLM_NETWORK: [String(error.message), '模型网络请求失败。检查 Worker 网络后可「恢复任务」，无需新建沙箱'],
    LLM_FORMAT_STALLED: ['模型工具调用经一次格式修正仍无效，已停止', '查看 Langfuse 的模型输出，检查输出长度或模型兼容性后再恢复'],
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
  const metrics = createTaskMetrics(task, { fusionEnabled: config.actionFusionEnabled, codeVersion: config.metricsCodeVersion });
  let outcome = 'unconfirmed';
  let outcomeError;

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
  let confirmedLeaseUntil = Date.parse(task.lease_until);
  let beating = false;
  const beat = setInterval(() => {
    if (beating || controller.signal.aborted) return; // never overlap renewal cycles
    beating = true;
    heartbeat(task.id, { executionId: task.execution_id, confirmedLeaseUntil, signal: controller.signal,
      onEvent: (event) => logger.info('heartbeat.' + event.event, { taskId: task.id, ...event }),
    }).then(() => {
      // The RPC confirmed a fresh lease. Keep a conservative local deadline for the next cycle.
      confirmedLeaseUntil = Date.now() + config.leaseSeconds * 1000 - 2000;
    }).catch((error) => {
      if (controller.signal.aborted) return;
      logger.warn('heartbeat.failed', { taskId: task.id, error: String(error), evidence: error.evidence || null });
      abort(error);
    }).finally(() => { beating = false; });
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
  const onModelEvent = async ({ event, model, ms, chars, usage, attempt, delayMs, reason }) => {
    if (event === 'started') modelCall++;
    const tokens = usage ? `；输入 ${usage.input ?? '未返回'} / 输出 ${usage.output ?? '未返回'} tokens` : '';
    if (event === 'retrying') {
      await appendStep(task, { tool: 'llm', event, phase: 'llm_retry',
        observation: reason === 'rate_limit' ? '模型服务繁忙，正在重试…' : '模型请求暂时异常，正在有限重试…',
        result: { attempt, delayMs, reason } });
      return;
    }
    await appendStep(task, { tool: 'llm', event, phase: event === 'started' ? 'llm_request' : 'llm_response', ms,
      observation: event === 'started' ? `第 ${modelCall} 次模型调用：${model}，等待返回`
        : `第 ${modelCall} 次模型返回：${chars} 字符${tokens}` });
  };
  const run = withExecutionControl({ taskId: task.id, executionId: task.execution_id, signal: controller.signal, checkLease, onModelEvent },
    () => traceTask(task, () => executeTask(task), { metrics, reportMetrics: false }));
  run.catch(() => {}); // 超时后旧执行的后续异常只记日志

  try {
    const result = await Promise.race([run, timeout, interrupted]);
    if (!result?.completed) await updateTask(task.id, { status: 'succeeded', phase: ['success_with_warnings', 'inconclusive'].includes(result?.verificationKind) ? 'done_with_warnings' : 'done' });
    outcome = ['success_with_warnings', 'inconclusive'].includes(result?.verificationKind) ? 'succeeded_with_warnings' : 'succeeded';
    logger.info('task.finished', { taskId: task.id, status: 'succeeded', verificationKind: result?.verificationKind, previewUrl: result?.previewUrl });
  } catch (error) {
    if (task.mode === 'build') {
      const saved = await completedCheckpoint(task).catch(() => null);
      if (saved) {
        outcome = saved.verify_evidence?.status === 'passed' ? 'succeeded' : 'succeeded_with_warnings';
        logger.info('task.completion_reconciled', { taskId: task.id, snapshotId: saved.id });
        return;
      }
    }
    outcomeError = error;
    // 完成写回在执行上下文之外，仍由原 execution_id 校验；暂停不得被 failed 覆盖。
    if (!controller.signal.aborted) controller.abort(error);
    // 中止旧执行:循环在下一步检查 aborted;停止心跳让租约自然失效,之后的任何写入都会被数据库拒绝
    task.aborted = error?.code === 'TASK_TIMEOUT' ? '任务已超时' : '任务已失败';
    clearInterval(beat);
    if (isSupabaseError(error)) stopping = true;
    if (error?.code === 'LEASE_LOST') {
      outcome = 'interrupted';
      logger.warn('task.lease_lost', { taskId: task.id, error: String(error.message) });
      return;
    }
    const summary = summarizeError(error, task);
    logger.error('task.finished', { taskId: task.id, status: 'failed', ...summary });
    const patch = makeFailurePatch(error, task, summary);
    await updateTask(task.id, patch).then(() => { outcome = 'failed'; }).catch((e) => {
      outcomeError = e;
      outcome = e?.code === 'LEASE_LOST' ? 'interrupted' : 'unconfirmed';
      if (e?.code !== 'LEASE_LOST') stopping = true;
      logger.warn('task.fail_write_rejected', { taskId: task.id, error: String(e), hint: '请核对数据库任务状态后重启 Worker' });
    });
  } finally {
    stopMonitor();
    clearTimeout(timer);
    clearInterval(beat);
    // 先等旧本地执行退栈，避免继续任务与尚未返回的沙箱操作并行。
    await run.catch(() => {});
    logger.info('task.metrics', { ...metricsSnapshot(metrics, outcome, outcomeError), outcome_scope: 'terminal_write' });
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
  const llmReport = describeLlm(config);
  const modelCheck = await inspectModelList(llmReport.selected);
  if (['auth_error', 'not_listed', 'http_error', 'network_error'].includes(modelCheck.status)) {
    logger.error('worker.llm_preflight_failed', { provider: llmReport.selected.name, model: llmReport.selected.model,
      status: modelCheck.status, httpStatus: modelCheck.httpStatus ?? null, reason: modelCheck.reason ?? null,
      hint: '检查 API Key、模型 ID 与网络后运行 npm run doctor:llm' });
    process.exitCode = 1;
    return;
  }
  if (modelCheck.status === 'unknown') logger.warn('worker.llm_model_unconfirmed', { provider: llmReport.selected.name, model: llmReport.selected.model, reason: modelCheck.reason || '模型列表接口不可用' });
  ({ inspectRuntimeWriter, getProject, checkWorkspaceSchema, completedCheckpoint, claimTask, heartbeat, updateTask, appendStep, setExecution, ensureLease } = await import('./supabase.js'));
  ({ executeTask } = await import('./agent.js'));
  ({ admin } = await import('./supabase.js'));
  ({ getSandboxProvider } = await import('./sandbox/index.js'));
  ({ processOneDeletion } = await import('./deletion.js'));
  ({ processOnePreviewRecovery } = await import('./preview-recovery.js'));
  await initTelemetry().catch(() => false);
  await checkWorkspaceSchema();
  logger.info('worker.started', {
    workerId: config.workerId,
    provider: config.llmProvider,
    fusionEnabled: config.actionFusionEnabled,
    metricsCodeVersion: config.metricsCodeVersion,
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
      const recovery = await processOnePreviewRecovery({ rpc: (fn, a) => admin.rpc(fn, a), getSandbox, getProject, inspectWriter: inspectRuntimeWriter, workerId: config.workerId })
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
