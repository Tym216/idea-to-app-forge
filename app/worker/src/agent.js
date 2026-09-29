import { config } from './config.js';
import { applyChanges, reconcileChanges, validateChanges } from './apply-changes.js';
import { recordToolCall, recordOperation } from './task-metrics.js';
import { assertExecutionActive, guardedSandbox, isSupabaseError, rethrowExecutionControl } from './execution-control.js';
import { logger } from './logger.js';
import { chat, parseJson } from './llm.js';
import { getSandboxProvider } from './sandbox/index.js';
import { SCAFFOLD_FILES } from './scaffold.js';
import { loadMemories, renderMemories, extractMemories, upsertMemory } from './memory.js';
import { AgentStopError, BuildProgress, mayModifyCode, verificationAttempts, requireVerificationBudget, MAX_VERIFY_ATTEMPTS } from './build-progress.js';
import { DESIGN_TOKENS_PATH, renderDesignPrompt, renderDesignTokensCss, resolveDesign } from './design.js';
import { checkSandboxDependencies } from './deps-check.js';
import { VERIFY_SPEC, validateChecks, runVerification, classifyResult, formatObservation, composeSummary } from './verify.js';
import { withObservation, redact } from './telemetry.js';
import {
  ACTION_PROMPT, PLAN_PROMPT, applyToolResult, generateStructured, initialStages, markRunning,
  renderAcceptance, renderApprovedPlan, validateAcceptance, validateAction, validatePlan,
} from './planner.js';
import {
  addMessage,
  appendStep,
  getLatestPlanVersion,
  getLatestPlan,
  deleteFile,
  getPlan,
  getProject,
  listFeedback,
  savePlan,
  listFiles,
  listChangeJournals,
  ensureLease,
  saveSnapshot,
  updateProject,
  updateTask,
  upsertFile,
} from './supabase.js';

const defaultDeps = { chat, appendStep, updateTask, updateProject, upsertFile, deleteFile, savePlan, addMessage, getLatestPlanVersion, listFiles, listChangeJournals, checkLease: null };

export const INSTALL_CMD = 'npm install --no-audit --no-fund';
export const BUILD_CMD = `${INSTALL_CMD} && npm run build`;
export const DEV_CMD = 'npm run dev';

const FUSION_SPEC = `
apply_changes（启用时）一次提交已确定的完整文件修改，可接构建：
{"thought":"...","tool":"apply_changes","args":{"changes":[{"operation":"write","path":"src/App.tsx","content":"完整文件内容"}],"after":"build"}}
- 只支持 write；不存在则创建，存在则完整替换。不支持 patch/create/rename/delete。
- changes 按顺序执行，禁止重复路径；总文件数和大小由平台限制。
- after 只允许 none/build（过渡字段）；首项失败后停止其余操作。
- 构建成功后，仅本任务已明确的网页验证流程由 Worker 自动启动并验收。
- 不要把尚需读取结果才能决定的修改强行合并。`;

const TOOLS_SPEC = `可用工具(每次只输出一个 JSON 对象):
{"thought":"...","tool":"read_file","args":{"path":"src/App.tsx","offset":0}}
{"thought":"...","tool":"write_file","args":{"path":"src/App.tsx","content":"完整文件内容"}}
{"thought":"...","tool":"delete_file","args":{"path":"src/Old.tsx"}}
{"thought":"...","tool":"list_files","args":{}}
{"thought":"...","tool":"run_command","args":{"command":"npm install"}}
{"thought":"...","tool":"build","args":{}}
{"thought":"...","tool":"start_dev","args":{}}
${VERIFY_SPEC}
{"thought":"...","tool":"request_plan_revision","args":{"reason":"计划中的验收条件为什么需要调整"}}
{"thought":"...","tool":"finish","args":{"summary":"给用户看的一段中文说明"}}
规则:
- 沙箱只有 npm,不要使用 pnpm 或 yarn。
- read_file 按 offset 分段返回(默认 4000 字符);若提示已截断,继续读取下一段,修改前应看完相关文件。
- write_file 必须给出文件完整内容,不能用省略号或 diff;文件路径必须完整(如 package.json)。
- 脚手架已包含 package.json / vite.config.ts / index.html / src/main.tsx,通常只需修改 src 下的业务文件。
- 新增第三方依赖时,先 write_file 更新 package.json,再 run_command 执行 npm install。
- 源码 import 的第三方包(含 lucide-react 等图标/组件库)必须已在 package.json 声明,否则 build 会被拦截。
- 完成代码编写后必须先 build,构建通过后 start_dev,再 verify,验收通过后才 finish;修改代码后需重新 build 和 verify。
- 如果计划验收本身有误,调用 request_plan_revision 并说明具体冲突;不能自行改动检查。
- 只输出一个 JSON 对象,不要输出任何解释文字或 markdown 围栏。`;

/** Plan 模式:生成待审阅的计划版本,不改代码、不启动应用。 */
export async function runPlan(task, context, design, deps = defaultDeps) {
  await deps.updateTask(task.id, { phase: 'planning' });
  const plan = await generateStructured({
    chat: deps.chat, system: PLAN_PROMPT, context, validate: validatePlan, taskId: task.id, code: 'PLAN_INVALID', purpose: 'plan', contextParts: task.contextParts,
  });
  const saved = await deps.savePlan(task, 'plan', { ...plan, designLayout: design?.layout?.type });
  await deps.appendStep(task, { tool: 'plan', phase: 'awaiting_review', observation: `计划 v${saved.version} 已生成,等待你审阅` });
  const text = [
    `计划 v${saved.version} 已生成,请在右侧审阅。`,
    plan.questions.length ? `有 ${plan.questions.length} 个问题需要你确认。` : '信息充分,可直接批准并构建。',
  ].join('');
  await deps.addMessage(task, 'assistant', text, { mode: 'plan', planId: saved.id, planVersion: saved.version });
  return { text, plan: saved };
}

/** 构建上下文:记忆 + 已确认需求 + 现有代码 */
export function previousVerificationFailure(task) {
  const previous = [...(task.steps || [])].reverse().find((step) => step.tool === 'verify' && step.ok === false && step.observation);
  if (!previous) return '';
  return `上次浏览器验收失败（手动重试时优先定位此问题，不要重做整个应用）：\n${String(previous.observation).slice(0, 1800)}\n如果是验收定义错误，调用 request_plan_revision 停止并请求修订计划；不能擅改已批准的断言。`;
}

async function buildContext(task, project, files, memories) {
  const memoryText = renderMemories(memories);
  const codeDigest = files.length
    ? files
        .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 4000)}`)
        .join('\n\n')
        .slice(0, 60000)
    : '(空项目,尚未生成任何业务代码)';

  task.contextParts = { memory: memoryText.length, initial_code: codeDigest.length };
  return [
    `项目名称: ${project.name}`,
    `项目已确认需求: ${project.description || '(暂无)'}`,
    '',
    memoryText,
    '',
    '当前已有代码:',
    codeDigest,
    '',
    `本轮用户需求:\n${task.prompt}`,
    task.mode === 'build' ? previousVerificationFailure(task) : '',
  ].join('\n');
}

/** 执行单个工具,返回 { observation, ok }。AgentStopError 向上抛出,由循环层终止。 */
async function runTool(ctx, tool, args) {
  const { task, sandbox, sandboxId, progress } = ctx;
  switch (tool) {
    case 'list_files': {
      const paths = await sandbox.listFiles(sandboxId, sandbox.workdir);
      return { observation: paths.join('\n') || '(空)', ok: true };
    }
    case 'read_file': {
      try {
        const content = await sandbox.readFile(sandboxId, args.path);
        const offset = args.offset == null ? 0 : Number(args.offset);
        if (!Number.isInteger(offset) || offset < 0 || offset > content.length) return { observation: 'offset 必须是文件内的非负整数', ok: false };
        const limit = Math.min(4500, Math.max(1, Number(args.limit) || 4000));
        const end = Math.min(content.length, offset + limit);
        const next = end < content.length ? `; 已截断,下一段 offset=${end}` : '; 已到文件结尾';
        return { observation: `${args.path} 总长 ${content.length} 字符,本段 ${offset}-${end}${next}\n${content.slice(offset, end)}`, ok: true };
      } catch (error) {
        const paths = await sandbox.listFiles(sandboxId, sandbox.workdir).catch(() => []);
        return {
          observation: `读取 ${args.path} 失败: ${String(error).slice(0, 500)}\n实际存在的文件:\n${paths.join('\n') || '(无法列出)'}`,
          ok: false,
        };
      }
    }
    case 'write_file':
    case 'apply_changes': {
      if (tool === 'apply_changes' && !ctx.fusionEnabled) return { observation: 'Action Fusion 未启用，请使用单文件工具。', ok: false };
      const input = tool === 'write_file' ? { changes: [{ operation: 'write', path: args.path, content: args.content ?? '' }], after: 'none' } : args;
      const { changes, after } = validateChanges(input, { maxFiles: config.fusionMaxFiles, maxBytes: config.fusionMaxBytes });
      const extra = changes.length - 1 + (after === 'build' ? 1 : 0);
      if (task.tool_steps + extra > config.maxToolSteps) throw new AgentStopError('TOOL_STEP_LIMIT', '预算不足以执行这组修改；尚未写入任何文件');
      let result;
      try { result = await applyChanges({ task, sandbox, sandboxId, changes, deps: ctx.deps,
        invalidate: () => progress.invalidate(),
        beforeWrite: async (index, filePath) => {
          assertExecutionActive();
          if (index > 0) consumeStep(ctx);
          task.current_tool = { tool: 'write_file', path: filePath, started: performance.now() };
          applyToolResult(task.plan, 'write_file', true);
          markRunning(task.plan, 'write_file');
          recordOperation('write_file');
          if (tool === 'apply_changes') await ctx.deps.appendStep(task, { tool: 'write_file', event: 'started', phase: 'write_file', path: filePath, observation: `正在写入 ${filePath}` });
        },
        onWriteSuccess: async (_index, change) => {
          applyToolResult(task.plan, 'write_file', true);
          if (tool === 'apply_changes') await ctx.deps.appendStep(task, { tool: 'write_file', event: 'finished', phase: 'write_file', path: change.path,
            ok: true, ms: Math.round(Math.max(0, performance.now() - task.current_tool.started)), observation: `已写入 ${change.path}（${change.content.length} 字符）` });
        },
      }); } catch (error) {
        if (after === 'build' && error.operations) error.operations.push({ kind: 'build', status: 'not_run' });
        throw error;
      }
      if (after === 'build') {
        let built;
        try { built = await executeOperation(ctx, 'build', {}, true); }
        catch (error) {
          error.operations = [...result.operations, { kind: 'build', status: error.code === 'TOOL_STEP_LIMIT' ? 'not_run' : 'failed' }];
          throw error;
        }
        result.operations.push({ index: changes.length, kind: 'build', status: built.ok ? 'succeeded' : 'failed' });
        if (!built.ok) return { observation: JSON.stringify({ ...result, status: 'partial' }) + '\n' + built.observation, ok: false };
        let validation;
        try { validation = await advanceValidation(ctx); }
        catch (error) { error.operations = [...result.operations, ...(error.operations || [])]; throw error; }
        result.operations.push(...(validation.operations || []));
        if (!validation.ok) return { observation: JSON.stringify({ ...result, status: 'partial' }) + '\n' + validation.observation, ok: false };
        return { observation: JSON.stringify(result) + '\n' + validation.observation, ok: true };
      }
      return { observation: JSON.stringify(result), ok: true };
    }
    case 'delete_file': {
      await sandbox.exec(sandboxId, `rm -f ${JSON.stringify(args.path)}`, { timeoutMs: 20000 });
      await ctx.deps.deleteFile(task, args.path);
      progress.invalidate();
      return { observation: `已删除 ${args.path}`, ok: true };
    }
    case 'run_command': {
      if (mayModifyCode(args.command)) progress.invalidate();
      const result = await runCommand(sandbox, sandboxId, args.command);
      return { observation: formatResult(result), ok: result.exitCode === 0 };
    }
    case 'build': {
      const depsGate = await checkSandboxDependencies(sandbox, sandboxId);
      if (depsGate) return { observation: depsGate, ok: false };
      const result = await runCommand(sandbox, sandboxId, BUILD_CMD);
      let observation = formatResult(result);
      const ok = result.exitCode === 0;
      progress.recordBuild(ok); // 超限时抛 AgentStopError
      task.fix_rounds = progress.fixRounds;
      if (!ok) {
        await ctx.deps.updateTask(task.id, { fix_rounds: task.fix_rounds, phase: 'fixing' });
        observation += `\n\n构建失败,请分析错误并修复(第 ${task.fix_rounds}/${config.maxFixRounds} 轮修复)。`;
      } else {
        observation += '\n\n构建成功。';
      }
      return { observation, ok };
    }
    case 'start_dev': {
      const blocked = progress.canStartDev();
      if (blocked) return { observation: blocked, ok: false };
      await sandbox.exec(sandboxId, 'pkill -f "vite" || true', { timeoutMs: 20000 });
      const { commandId } = await sandbox.startBackground(sandboxId, DEV_CMD);
      let ready = false;
      for (let i = 0; i < 20 && !ready; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        ready = await sandbox.isPortListening(sandboxId, 5173);
      }
      const devLog = (await sandbox.readLogs(sandboxId, { commandId }).catch(() => '')).slice(-1500);
      if (!ready) return { observation: `开发服务器 60 秒内未监听 5173 端口,日志:\n${devLog}`, ok: false };
      const previewUrl = await sandbox.previewUrl(sandboxId, 5173);
      if (!previewUrl) return { observation: '服务已启动但未取得预览地址。', ok: false };
      progress.recordPreview(previewUrl);
      ctx.previewUrl = previewUrl;
      await ctx.deps.updateProject(task.project_id, task.user_id, { preview_url: previewUrl, sandbox_id: sandboxId }, task.id);
      logger.info('preview.written', { taskId: task.id, projectId: task.project_id, sandboxId, previewUrl });
      return { observation: `开发服务器已启动,预览地址: ${previewUrl}`, ok: true };
    }
    case 'verify': {
      const blocked = progress.canVerify();
      if (blocked) return { observation: blocked, ok: false };
      if (Object.keys(args).length) return { observation: 'verify 不接受检查参数;检查由已保存的计划版本固定。请用空 args 重试。', ok: false };
      const checks = ctx.acceptance.filter((a) => a.steps?.length).map(({ id, steps }) => ({ id, steps }));
      const validated = validateChecks(ctx.acceptance, checks);
      requireVerificationBudget(task);
      const attempt = verificationAttempts(task.steps) + 1;
      await ctx.deps.appendStep(task, { tool: 'verify_attempt', phase: 'verify', event: 'started',
        observation: `第 ${attempt}/${MAX_VERIFY_ATTEMPTS} 次浏览器验收；失败后等待用户决定，不自动修复` });
      const raw = await (ctx.deps.verifyApp || runVerification)({ sandbox, sandboxId, checks: validated.checks });
      const result = classifyResult(raw, ctx.acceptance);
      ctx.verificationResult = result;
      progress.recordVerification(result);
      if (result.kind === 'tool_error') throw new AgentStopError('VERIFY_TOOL_ERROR', formatObservation(result, attempt, MAX_VERIFY_ATTEMPTS));
      if (result.kind === 'blocked') throw new AgentStopError('VERIFY_BLOCKED', formatObservation(result, attempt, MAX_VERIFY_ATTEMPTS));
      if (result.kind === 'app_failed') {
        throw new AgentStopError('VERIFY_FAILED', formatObservation(result, attempt, MAX_VERIFY_ATTEMPTS));
      }
      return { observation: formatObservation(result, attempt, MAX_VERIFY_ATTEMPTS), ok: result.kind === 'passed' };
    }
    case 'request_plan_revision': {
      const reason = String(args.reason || '').trim().slice(0, 500);
      if (!reason) return { observation: '请说明计划或验收条件的具体错误。', ok: false };
      throw new AgentStopError('PLAN_REVISION_REQUIRED', reason);
    }
    default:
      return { observation: `未知工具 "${tool}",请使用工具列表中的工具。`, ok: false };
  }
}

/**
 * Build 模式:真实的 ReAct 循环。
 * - 总工具步数上限 config.maxToolSteps
 * - 构建修复轮数上限 config.maxFixRounds(二者分别配置)
 */
export async function runBuild(task, project, sandbox, sandboxId, context, deps = defaultDeps, designPrompt = '', acceptance = [], options = {}) {
  requireVerificationBudget(task);
  let canonicalAcceptance;
  try { canonicalAcceptance = validateAcceptance(acceptance); }
  catch (error) { throw new AgentStopError('PLAN_REVISION_REQUIRED', `验收检查缺失或无效,请创建新 Plan 并审阅: ${error.message}`); }
  const fusionEnabled = options.fusionEnabled ?? config.actionFusionEnabled;
  const runtimePolicy = options.runtimePolicy ?? { workflow: 'manual', afterBuildSuccess: [] };
  const history = [
    {
      role: 'system',
      content: `你是一个在隔离沙箱中工作的编码代理,用 ReAct 模式逐步完成任务。\n${TOOLS_SPEC}${fusionEnabled ? `\n${FUSION_SPEC}` : ''}${designPrompt ? `\n\n${designPrompt}` : ''}`,
    },
    { role: 'user', content: context },
  ];
  const progress = new BuildProgress({ maxFixRounds: config.maxFixRounds, fixRounds: task.fix_rounds || 0 });
  const ctx = { task, sandbox, sandboxId, progress, previewUrl: '',
    deps: { ...deps, checkLease: deps.checkLease || (() => ensureLease(task.id)) },
    acceptance: canonicalAcceptance, verificationResult: null, fusionEnabled, runtimePolicy };


  const stages = Array.isArray(task.plan) && task.plan.length && task.plan[0]?.key ? task.plan : initialStages();
  task.plan = stages;

  let invalidResponses = 0;
  while (task.tool_steps < config.maxToolSteps) {
    assertExecutionActive();
    if (task.aborted) throw new AgentStopError('ABORTED', task.aborted);
    task.current_tool = null;
    await ctx.deps.updateTask(task.id, { phase: 'deciding' });
    const raw = await ctx.deps.chat(history, { temperature: 0.1, json: true, taskId: task.id,
      purpose: 'build_decision', contextParts: {
        system: { plan_and_acceptance: options.planChars || 0, instructions: history[0].content.length - (options.planChars || 0) },
        user: task.contextParts,
      },
    });
    let action;
    let parsed = false;
    try {
      action = parseJson(raw);
      parsed = true;
      if (!action || typeof action.tool !== 'string' || (action.args !== undefined && (!action.args || typeof action.args !== 'object' || Array.isArray(action.args)))) {
        throw new Error('工具调用需包含 tool 字符串和 args 对象');
      }
      const fields = { read_file: ['path'], write_file: ['path', 'content'], delete_file: ['path'],
        run_command: ['command'], list_files: [], build: [], start_dev: [], verify: [], finish: [], request_plan_revision: [], apply_changes: [] };
      if (!Object.hasOwn(fields, action.tool)) throw new Error('工具名称不在可用工具列表中');
      for (const field of fields[action.tool]) {
        if (typeof action.args?.[field] !== 'string' || (field !== 'content' && !action.args[field].trim())) {
          throw new Error(`${action.tool} 缺少必需字符串字段 ${field}`);
        }
      }
      if (action.tool === 'apply_changes') {
        if (!fusionEnabled) throw new Error('apply_changes 未启用');
        validateChanges(action.args, { maxFiles: config.fusionMaxFiles, maxBytes: config.fusionMaxBytes });
      }
    } catch (error) {
      task.tool_steps += 1;
      invalidResponses += 1;
      await ctx.deps.appendStep(task, {
        tool: 'llm_parse_error', phase: 'format_retry', ok: false,
        observation: `模型输出格式无效(${invalidResponses}/2)，返回 ${raw.length} 字符；协议校验：${parsed ? redact(error.message, 300) : '无法解析 JSON（请检查原始 content 是否被截断）'}；${invalidResponses === 2 ? '已停止，避免继续消耗' : '正在请求重新输出工具 JSON'}`,
      });
      if (invalidResponses >= 2) throw new AgentStopError('LLM_FORMAT_STALLED', '模型输出经一次修正仍不是合法工具调用');
      history.push({ role: 'user', content: `上一条工具调用协议无效：${parsed ? error.message : '无法解析 JSON，请检查引号、括号与转义'}。请只返回一个合法 JSON 对象，包含 tool 和 args；字符串换行必须转义。` });
      continue;
    }
    invalidResponses = 0;
    assertExecutionActive();

    task.tool_steps += 1;
    history.push({ role: 'assistant', content: JSON.stringify(action) });
    const { tool, args = {} } = action;
    recordToolCall();

    if (tool === 'finish') {
      const blocked = progress.canFinish();
      if (!blocked) {
        const summary = composeSummary(args.summary || '已完成本轮修改。', ctx.verificationResult);
        await ctx.deps.appendStep(task, { tool, phase: 'finishing', observation: summary });
        return { summary, previewUrl: ctx.previewUrl };
      }
      history.push({ role: 'user', content: `观察结果:\n${blocked}` });
      await ctx.deps.appendStep(task, { tool, phase: tool, observation: blocked });
      progress.recordResult(tool, args, false);
      continue;
    }

    let observation;
    let ok;
    markRunning(stages, tool);
    const started = performance.now();
    task.current_tool = { tool, started };
    const activityPath = ['read_file', 'write_file', 'delete_file'].includes(tool) && typeof args.path === 'string'
      && args.path.length <= 120 && !/[\r\n?]/.test(args.path) ? args.path : undefined;
    await ctx.deps.appendStep(task, { tool, phase: tool, event: 'started', path: activityPath, observation: '' });
    try {
      ({ observation, ok } = await withObservation(`tool.${tool}`, { metadata: { tool } }, 'tool', async (obs) => {
        const r = await executeOperation(ctx, tool, args, false);
        if (tool === 'build' && r.ok) {
          const validation = await advanceValidation(ctx);
          r.observation += '\n' + validation.observation;
          r.ok = validation.ok;
        }
        obs.update({
          ...(r.ok ? {} : { level: 'WARNING', statusMessage: redact(r.observation, 300) }),
          metadata: { tool, ok: r.ok, ms: Math.max(0, performance.now() - started) },
        });
        return r;
      }));
      if (task.aborted) throw new AgentStopError('ABORTED', task.aborted);
    } catch (error) {
      assertExecutionActive();
      if (error?.code === 'LEASE_LOST' || isSupabaseError(error)) throw error;
      if (error instanceof AgentStopError) {
        // Automatic child failure must not relabel successful writes/build as failed.
        if (task.current_tool?.tool === tool || error.code === 'CHANGE_UNCERTAIN') {
          applyToolResult(stages, tool, false, error.message.slice(0, 120));
        }
        await ctx.deps.appendStep(task, { tool, phase: 'stopped', event: 'finished', ok: false,
          ms: Math.max(0, performance.now() - started), observation: error.message, ...(error.operations ? { result: { status: error.code === 'CHANGE_UNCERTAIN' ? 'uncertain' : 'partial', operations: error.operations } } : {}) });
        throw error;
      }
      observation = `工具执行失败: ${String(error).slice(0, 2000)}`;
      ok = false;
      logger.warn('agent.tool.failed', { taskId: task.id, tool, error: String(error) });
    }

    try {
      observation += progress.recordResult(tool, args, ok);
    } catch (error) {
      await ctx.deps.appendStep(task, { tool, phase: 'stopped', observation: error.message });
      throw error;
    }

    logger.info('agent.tool', {
      taskId: task.id,
      step: task.tool_steps,
      tool,
      ok,
      fixRounds: task.fix_rounds,
      observation: observation.slice(0, 160),
    });
    if (!['apply_changes', 'write_file'].includes(tool)) applyToolResult(stages, tool, ok, observation.slice(0, 120));
    await ctx.deps.appendStep(task, {
      tool, phase: !ok && ['build', 'verify'].includes(tool) && task.fix_rounds > 0 ? 'fixing' : tool,
      event: 'finished', path: activityPath,
      ok, ms: Math.max(0, performance.now() - started), observation: observation.slice(0, 1500),
    });
    history.push({ role: 'user', content: `观察结果:\n${observation.slice(0, 6000)}` });

    if (history.length > 24) history.splice(2, history.length - 20);
  }

  throw new AgentStopError('TOOL_STEP_LIMIT', `已达到总工具步数上限 ${config.maxToolSteps},任务未完成。`);
}

export function webValidationPolicy(plan, enabled) {
  const acceptance = plan?.content?.acceptance;
  return enabled && Array.isArray(acceptance) && acceptance.length && acceptance.some((item) => Array.isArray(item.steps) && item.steps.length)
    ? { workflow: 'web_app', planVersion: plan.version, afterBuildSuccess: ['start_dev', 'verify'], verificationSource: 'saved_plan' }
    : { workflow: 'manual', afterBuildSuccess: [] };
}

function consumeStep(ctx) {
  if (ctx.task.tool_steps >= config.maxToolSteps) throw new AgentStopError('TOOL_STEP_LIMIT', '下一项操作前预算已耗尽，已有修改保留');
  ctx.task.tool_steps++;
}

async function executeOperation(ctx, tool, args, automatic) {
  assertExecutionActive();
  await ctx.deps.checkLease();
  if (automatic) consumeStep(ctx);
  if (!['write_file', 'apply_changes'].includes(tool)) recordOperation(tool);
  if (automatic) {
    markRunning(ctx.task.plan, tool);
    ctx.task.current_tool = { tool, started: performance.now() };
    await ctx.deps.appendStep(ctx.task, { tool, phase: tool, event: 'started', automatic: true, observation: '' });
  }
  const started = performance.now();
  try {
    const result = automatic
      ? await withObservation(`tool.${tool}`, { metadata: { tool, automatic: true } }, 'tool', async (obs) => {
          const value = await runTool(ctx, tool, args);
          obs.update({ metadata: { tool, automatic: true, ok: value.ok, ms: Math.round(Math.max(0, performance.now() - started)) } });
          return value;
        })
      : await runTool(ctx, tool, args);
    assertExecutionActive();
    await ctx.deps.checkLease();
    recordOperation(tool, result.ok);
    if (!['write_file', 'apply_changes'].includes(tool)) {
      applyToolResult(ctx.task.plan, tool, result.ok, result.observation.slice(0, 120));
    }
    if (automatic) {
      await ctx.deps.appendStep(ctx.task, { tool, phase: tool, event: 'finished', automatic: true, ok: result.ok,
        ms: Math.round(Math.max(0, performance.now() - started)), observation: result.observation.slice(0, 1500) });
    }
    return result;
  } catch (error) {
    if (automatic) {
      applyToolResult(ctx.task.plan, tool, false, error.message.slice(0, 120));
      try { await ctx.deps.appendStep(ctx.task, { tool, phase: 'stopped', event: 'finished', automatic: true, ok: false,
        ms: Math.round(Math.max(0, performance.now() - started)), observation: error.message.slice(0, 1500) }); } catch {}
    }
    throw error;
  }
}

async function advanceValidation(ctx) {
  if (!ctx.fusionEnabled || ctx.runtimePolicy.workflow !== 'web_app'
    || JSON.stringify(ctx.runtimePolicy.afterBuildSuccess) !== JSON.stringify(['start_dev', 'verify'])) return { ok: true, observation: '', operations: [] };
  let start;
  try {
    start = await executeOperation(ctx, 'start_dev', {}, true);
    if (!start.ok) throw new AgentStopError('START_FAILED', start.observation);
  } catch (error) {
    error.operations = [{ kind: 'start_dev', status: error.code === 'TOOL_STEP_LIMIT' ? 'not_run' : 'failed' }, { kind: 'verify', status: 'not_run' }];
    throw error;
  }
  let checked;
  try { checked = await executeOperation(ctx, 'verify', {}, true); }
  catch (error) {
    error.operations = [{ kind: 'start_dev', status: 'succeeded' }, { kind: 'verify', status: error.code === 'TOOL_STEP_LIMIT' ? 'not_run' : 'failed' }];
    throw error;
  }
  return { ok: checked.ok, observation: start.observation + '\n' + checked.observation,
    operations: [{ kind: 'start_dev', status: 'succeeded' }, { kind: 'verify', status: checked.ok ? 'succeeded' : 'failed' }] };
}

/** A missing process does not prove an operation was unapplied. Never blindly replay. */
export async function runCommand(sandbox, sandboxId, command) {
  const result = await sandbox.exec(sandboxId, command);
  if (!result.timedOut) return result;

  const key = command.split(/\s+/).find((token) => token && !token.startsWith('-')) || command.slice(0, 12);
  let stillRunning = null;
  try { stillRunning = await sandbox.checkProcess(sandboxId, key); } catch (error) { rethrowExecutionControl(error); }
  const detail = stillRunning === true ? '仍观察到相关进程' : stillRunning === false ? '未观察到相关进程，但无法确定命令结果' : '无法读取进程状态';
  throw new AgentStopError('COMMAND_UNCERTAIN', `命令超时；${detail}。已停止且未重新执行，请先核对沙箱日志和操作结果`);
}

function formatResult(result) {
  return [
    `exitCode=${result.exitCode}`,
    result.stdout ? `stdout:\n${result.stdout.slice(-4000)}` : '',
    result.stderr ? `stderr:\n${result.stderr.slice(-4000)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
}

/** 确保沙箱内存在脚手架与数据库中已有的代码;补写的脚手架同步保存到数据库。 */
export async function hydrateSandbox(task, sandbox, sandboxId, files, deps = defaultDeps) {
  for (const [path, content] of Object.entries(SCAFFOLD_FILES)) {
    if (!files.some((f) => f.path === path)) {
      await sandbox.writeFile(sandboxId, path, content);
      await deps.upsertFile(task, path, content);
    }
  }
  for (const file of files) {
    await sandbox.writeFile(sandboxId, file.path, file.content);
  }
}

/** Build 前确定执行依据:已批准的计划版本 + 反馈;直接 Build 时生成简短行动计划(视为授权)。 */
export async function resolveBuildBasis(task, context, deps) {
  if (task.plan_id) {
    const plan = await deps.getPlan(task.plan_id, task.project_id);
    if (plan.status !== 'approved' && plan.kind !== 'action') {
      throw new AgentStopError('PLAN_NOT_APPROVED', `计划 v${plan.version} 尚未批准,不能构建`);
    }
    if (task.plan_version != null && plan.version !== task.plan_version) {
      throw new AgentStopError('PLAN_VERSION_MISMATCH', `任务绑定 v${task.plan_version},实际读取到 v${plan.version}`);
    }
    const latestVersion = await deps.getLatestPlanVersion?.(task.project_id);
    if (latestVersion > plan.version) {
      throw new AgentStopError('PLAN_VERSION_STALE', `项目已有 v${latestVersion} 计划,不能恢复绑定 v${plan.version} 的旧任务`);
    }
    const feedback = await deps.listFeedback(task.project_id, plan.version);
    const approvedPrompt = renderApprovedPlan(plan, feedback);
    let acceptance;
    try { acceptance = validateAcceptance(plan.content?.acceptance); }
    catch (error) { throw new AgentStopError('PLAN_REVISION_REQUIRED', `计划 v${plan.version} 缺少有效浏览器检查,请新建 Plan 修订并重新批准: ${error.message}`); }
    return { plan, prompt: `${approvedPrompt}\n\n${renderAcceptance(acceptance)}`, acceptance };
  }
  await deps.updateTask(task.id, { phase: 'action_planning' });
  const action = await generateStructured({
    chat: deps.chat, system: ACTION_PROMPT, context, validate: validateAction, taskId: task.id, code: 'ACTION_INVALID', purpose: 'action_plan', contextParts: task.contextParts,
  });
  const plan = await deps.savePlan(task, 'action', action);
  await deps.updateTask(task.id, { plan_id: plan.id, plan_version: plan.version });
  task.plan_id = plan.id;
  task.plan_version = plan.version;
  await deps.appendStep(task, {
    tool: 'plan', phase: 'action_plan',
    observation: `行动计划 v${plan.version}: ${action.steps.join(' → ')}`,
  });
  return { plan, prompt: renderApprovedPlan(plan, []), acceptance: action.acceptance };
}

export async function executeTask(task) {
  if (task.mode === 'build') requireVerificationBudget(task);
  const deps = { ...defaultDeps, getPlan, listFeedback, checkLease: () => ensureLease(task.id) };
  // Reconcile against the ORIGINAL sandbox before hydration or spending more model tokens.
  if (task.mode === 'build') {
    await updateTask(task.id, { phase: 'reconciling' });
    await reconcileChanges({ task, sandbox: guardedSandbox(getSandboxProvider('daytona')), deps });
  }
  await updateTask(task.id, { phase: 'understand' });
  const project = await getProject(task.project_id, task.user_id);
  const files = await listFiles(task.project_id);
  const memories = await loadMemories(task.user_id, task.project_id);
  const context = await buildContext(task, project, files, memories);

  await updateTask(task.id, { phase: 'designing' });
  const { design, source, warnings = [] } = await resolveDesign({ task, memories, context, deps: { chat, upsertMemory } });
  await appendStep(task, { tool: 'design', phase: 'understand', warnings,
    observation: `设计方案(${source}): ${design.layout.type} · ${design.style}${warnings.length ? '\n提示：' + warnings.join('；') : ''}` });

  if (task.mode === 'plan') {
    const previousPlan = task.plan_id
      ? await getPlan(task.plan_id, task.project_id)
      : await getLatestPlan(task.project_id);
    const planContext = previousPlan
      ? `${context}\n\n${renderApprovedPlan(previousPlan, await listFeedback(task.project_id, previousPlan.version)).replace('已批准的计划', '上一版计划(根据用户新要求修改)')}`
      : context;
    const { text } = await runPlan(task, planContext, design, deps);
    await extractMemories({ userId: task.user_id, projectId: task.project_id, userPrompt: task.prompt, summary: text, taskId: task.id });
    return { summary: text };
  }

  const basis = await resolveBuildBasis(task, context, deps);

  await updateTask(task.id, { phase: 'sandbox' });
  const sandbox = guardedSandbox(getSandboxProvider('daytona'));
  const { sandboxId, alive } = await sandbox.ensure(project.sandbox_id, { projectId: task.project_id, userId: task.user_id });
  await updateProject(task.project_id, task.user_id, { sandbox_id: sandboxId, status: 'running' }, task.id);
  if (!alive) {
    await appendStep(task, { tool: 'sandbox', phase: 'sandbox', observation: '沙箱不存在或已回收,正在从数据库快照恢复代码。' });
  }
  await hydrateSandbox(task, sandbox, sandboxId, files);
  const tokensCss = renderDesignTokensCss(design);
  await sandbox.writeFile(sandboxId, DESIGN_TOKENS_PATH, tokensCss);
  await upsertFile(task, DESIGN_TOKENS_PATH, tokensCss);

  await updateTask(task.id, { phase: 'react' });
  const { summary, previewUrl } = await runBuild(
    task, project, sandbox, sandboxId, context, deps, `${basis.prompt}\n\n${renderDesignPrompt(design)}`, basis.acceptance,
    { planChars: basis.prompt.length, runtimePolicy: webValidationPolicy(basis.plan, config.actionFusionEnabled) }
  );

  await saveSnapshot(task, `task ${task.id}`);
  await addMessage(task, 'assistant', summary, { previewUrl });
  await updateProject(task.project_id, task.user_id, { status: 'ready', preview_url: previewUrl || project.preview_url }, task.id);
  await extractMemories({ userId: task.user_id, projectId: task.project_id, userPrompt: task.prompt, summary, taskId: task.id });
  return { summary, previewUrl };
}
