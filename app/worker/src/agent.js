import { config } from './config.js';
import { assertExecutionActive, guardedSandbox } from './execution-control.js';
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
  saveSnapshot,
  updateProject,
  updateTask,
  upsertFile,
} from './supabase.js';

const defaultDeps = { chat, appendStep, updateTask, updateProject, upsertFile, deleteFile, savePlan, addMessage, getLatestPlanVersion };

export const INSTALL_CMD = 'npm install --no-audit --no-fund';
export const BUILD_CMD = `${INSTALL_CMD} && npm run build`;
export const DEV_CMD = 'npm run dev';

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
    chat: deps.chat, system: PLAN_PROMPT, context, validate: validatePlan, taskId: task.id, code: 'PLAN_INVALID',
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
  const codeDigest = files.length
    ? files
        .map((f) => `--- ${f.path} ---\n${f.content.slice(0, 4000)}`)
        .join('\n\n')
        .slice(0, 60000)
    : '(空项目,尚未生成任何业务代码)';

  return [
    `项目名称: ${project.name}`,
    `项目已确认需求: ${project.description || '(暂无)'}`,
    '',
    renderMemories(memories),
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
    case 'write_file': {
      await sandbox.writeFile(sandboxId, args.path, args.content ?? '');
      await ctx.deps.upsertFile(task, args.path, args.content ?? '');
      progress.invalidate();
      return { observation: `已写入 ${args.path}(${(args.content ?? '').length} 字符)`, ok: true };
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
        observation += '\n\n构建成功,下一步请 start_dev。';
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
export async function runBuild(task, project, sandbox, sandboxId, context, deps = defaultDeps, designPrompt = '', acceptance = []) {
  requireVerificationBudget(task);
  let canonicalAcceptance;
  try { canonicalAcceptance = validateAcceptance(acceptance); }
  catch (error) { throw new AgentStopError('PLAN_REVISION_REQUIRED', `验收检查缺失或无效,请创建新 Plan 并审阅: ${error.message}`); }
  const history = [
    {
      role: 'system',
      content: `你是一个在隔离沙箱中工作的编码代理,用 ReAct 模式逐步完成任务。\n${TOOLS_SPEC}${designPrompt ? `\n\n${designPrompt}` : ''}`,
    },
    { role: 'user', content: context },
  ];
  const progress = new BuildProgress({ maxFixRounds: config.maxFixRounds, fixRounds: task.fix_rounds || 0 });
  const ctx = { task, sandbox, sandboxId, progress, previewUrl: '', deps, acceptance: canonicalAcceptance, verificationResult: null };

  const stages = Array.isArray(task.plan) && task.plan.length && task.plan[0]?.key ? task.plan : initialStages();
  task.plan = stages;

  let invalidResponses = 0;
  while (task.tool_steps < config.maxToolSteps) {
    assertExecutionActive();
    if (task.aborted) throw new AgentStopError('ABORTED', task.aborted);
    task.current_tool = null;
    await ctx.deps.updateTask(task.id, { phase: 'deciding' });
    const raw = await ctx.deps.chat(history, { temperature: 0.1, json: true, taskId: task.id });
    let action;
    try {
      action = parseJson(raw);
      if (!action || typeof action.tool !== 'string' || (action.args != null && (typeof action.args !== 'object' || Array.isArray(action.args)))) {
        throw new Error('工具调用需包含 tool 字符串和 args 对象');
      }
    } catch (error) {
      task.tool_steps += 1;
      invalidResponses += 1;
      await ctx.deps.appendStep(task, {
        tool: 'llm_parse_error', phase: 'format_retry', ok: false,
        observation: `模型输出格式无效(${invalidResponses}/3)，返回 ${raw.length} 字符；${invalidResponses === 3 ? '已停止，避免继续消耗' : '正在请求重新输出工具 JSON'}`,
      });
      if (invalidResponses >= 3) throw new AgentStopError('LLM_FORMAT_STALLED', '模型连续 3 次没有返回合法工具调用');
      history.push({ role: 'user', content: '上一条输出无法解析为工具调用。请只返回一个合法 JSON 对象，包含 tool 和 args；字符串换行必须转义。' });
      continue;
    }
    invalidResponses = 0;
    assertExecutionActive();

    task.tool_steps += 1;
    history.push({ role: 'assistant', content: JSON.stringify(action) });
    const { tool, args = {} } = action;

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
        const r = await runTool(ctx, tool, args);
        obs.update({
          ...(r.ok ? {} : { level: 'WARNING', statusMessage: redact(r.observation, 300) }),
          metadata: { tool, ok: r.ok, ms: Math.max(0, performance.now() - started) },
        });
        return r;
      }));
      if (task.aborted) throw new AgentStopError('ABORTED', task.aborted);
    } catch (error) {
      assertExecutionActive();
      if (error?.code === 'LEASE_LOST' || error?.code?.startsWith('SUPABASE_')) throw error;
      if (error instanceof AgentStopError) {
        applyToolResult(stages, tool, false, error.message.slice(0, 120));
        await ctx.deps.appendStep(task, { tool, phase: 'stopped', event: 'finished', ok: false,
          ms: Math.max(0, performance.now() - started), observation: error.message });
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
    applyToolResult(stages, tool, ok, observation.slice(0, 120));
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

/** 命令超时后先检查进程是否仍在运行,再决定是否重试,避免重复执行。 */
async function runCommand(sandbox, sandboxId, command) {
  const result = await sandbox.exec(sandboxId, command);
  if (!result.timedOut) return result;

  const key = command.split(/\s+/).find((token) => token && !token.startsWith('-')) || command.slice(0, 12);
  const stillRunning = await sandbox.checkProcess(sandboxId, key);
  if (stillRunning) {
    return { ...result, stdout: `命令仍在后台运行(超时但进程存在),未重复执行: ${command}` };
  }
  return sandbox.exec(sandboxId, command);
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
    chat: deps.chat, system: ACTION_PROMPT, context, validate: validateAction, taskId: task.id, code: 'ACTION_INVALID',
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
  const deps = { ...defaultDeps, getPlan, listFeedback };
  await updateTask(task.id, { phase: 'understand' });
  const project = await getProject(task.project_id, task.user_id);
  const files = await listFiles(task.project_id);
  const memories = await loadMemories(task.user_id, task.project_id);
  const context = await buildContext(task, project, files, memories);

  await updateTask(task.id, { phase: 'designing' });
  const { design, source } = await resolveDesign({ task, memories, context, deps: { chat, upsertMemory } });
  await appendStep(task, { tool: 'design', phase: 'understand', observation: `设计方案(${source}): ${design.layout.type} · ${design.style}` });

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
    task, project, sandbox, sandboxId, context, defaultDeps, `${basis.prompt}\n\n${renderDesignPrompt(design)}`, basis.acceptance
  );

  await saveSnapshot(task, `task ${task.id}`);
  await addMessage(task, 'assistant', summary, { previewUrl });
  await updateProject(task.project_id, task.user_id, { status: 'ready', preview_url: previewUrl || project.preview_url }, task.id);
  await extractMemories({ userId: task.user_id, projectId: task.project_id, userPrompt: task.prompt, summary, taskId: task.id });
  return { summary, previewUrl };
}
