import { verificationContinuationCandidate, assertVerificationContinuationBasis } from './verification-continuation.js';
import { renderPersistenceHelper, PERSISTENCE_GUIDANCE } from './app-persistence.js';
import { assertUserApplyExecution, executeUserApply, userApplyBasis } from './user-apply.js';
import { validateRuntimeScript } from './workspace-policy.js';
import { config } from './config.js';
import { Workspace, shellQuote } from './workspace.js';
import { sourceManifest, buildFingerprint, verifyFingerprint, sha256, sourceError, normalizeSourcePath, isManagedPath } from './managed-source.js';
import { validateChanges } from './apply-changes.js';
import { recordToolCall, recordOperation } from './task-metrics.js';
import { assertExecutionActive, guardedSandbox, isSupabaseError, rethrowExecutionControl } from './execution-control.js';
import { logger } from './logger.js';
import { chat, parseJson } from './llm.js';
import { getSandboxProvider } from './sandbox/index.js';
import { SCAFFOLD_FILES } from './scaffold.js';
import { loadMemories, renderMemories, extractMemories, upsertMemory } from './memory.js';
import { AgentStopError, BuildProgress, mayModifyCode, verificationAttempts, requireVerificationBudget, requireNewRevisionForVerification, MAX_VERIFY_ATTEMPTS } from './build-progress.js';
import { DESIGN_TOKENS_PATH, renderDesignPrompt, renderDesignTokensCss, resolveDesign, wantsDesignChange } from './design.js';
import { checkSandboxDependencies } from './deps-check.js';
import { VERIFY_SPEC, RUNNER_SOURCE, PLAYWRIGHT_VERSION, validateChecks, runVerification, classifyResult, formatObservation, composeSummary } from './verify.js';
import { withObservation, redact } from './telemetry.js';
import {
  ACTION_PROMPT, PLAN_PROMPT, applyToolResult, generateStructured, initialStages, markRunning,
  renderAcceptance, renderApprovedPlan, validateAcceptance, validateAction, validatePlan,
} from './planner.js';
import {
  admin,
  getRequestedChangeSet,
  addMessage,
  appendStep,
  getLatestPlanVersion,
  getLatestPlan,
  getPlan,
  getProject,
  listFeedback,
  savePlan,
  listFiles,
  ensureLease,
  updateProject,
  updateTask,
} from './supabase.js';

const defaultDeps = { chat, appendStep, updateTask, updateProject, savePlan, addMessage, getLatestPlanVersion, listFiles, checkLease: null };

export const INSTALL_CMD = 'npm install --no-audit --no-fund --ignore-scripts --package-lock=true';
export const BUILD_CMD = `${INSTALL_CMD} && npm run build`;
export const DEV_CMD = 'npm run --ignore-scripts dev';

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
- 沙箱只有 npm；run_command 首版仅允许 npm install，源码改动必须使用文件工具；不要执行任意 shell 改写或 detached writer。
- read_file 按 offset 分段返回(默认 4000 字符);若提示已截断,继续读取下一段,修改前应看完相关文件。
- write_file 必须给出文件完整内容,不能用省略号或 diff;文件路径必须完整(如 package.json)。
- 脚手架已包含 package.json / vite.config.ts / index.html / src/main.tsx,通常只需修改 src 下的业务文件。
- 新增第三方依赖时,先 write_file 更新 package.json,再 run_command 执行 npm install。
- 源码 import 的第三方包(含 lucide-react 等图标/组件库)必须已在 package.json 声明,否则 build 会被拦截。
- 完成代码编写后必须先 build,构建通过后 start_dev,再 verify;明确 blocker 阻止完成，其余未通过项必须如实列为警告或证据不足，不得宣称已验证。修改代码后需重新 build 和 verify。
- 如果计划验收本身有误,调用 request_plan_revision 并说明具体冲突;不能自行改动检查。
- 只输出一个 JSON 对象,不要输出任何解释文字或 markdown 围栏。`;

/** Plan 模式:生成待审阅的计划版本,不改代码、不启动应用。 */
export async function runPlan(task, context, design, deps = defaultDeps) {
  await deps.updateTask(task.id, { phase: 'planning' });
  const plan = await generateStructured({
    chat: deps.chat, system: PLAN_PROMPT, context, validate: validatePlan, taskId: task.id, code: 'PLAN_INVALID', purpose: 'plan', reasoningMode: config.planReasoningMode, reasoningPolicy: config.planReasoningPolicy, contextParts: task.contextParts,
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

export function genericProjectContext(_project, _task) { return { profile: 'generic', instructions: [] }; }

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
    ...genericProjectContext(project, task).instructions,
    PERSISTENCE_GUIDANCE,
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
  if (ctx.workspace) await ctx.workspace.assertCurrent(ctx.contextRevision);
  switch (tool) {
    case 'list_files': {
      const paths = ctx.workspace ? ctx.workspace.manifest.files.map((f) => f.path) : await sandbox.listFiles(sandboxId, sandbox.workdir);
      return { observation: paths.join('\n') || '(空)', ok: true };
    }
    case 'read_file': {
      try {
        const filePath = normalizeSourcePath(args.path);
        if (!isManagedPath(filePath)) throw sourceError('SOURCE_PATH', '不能读取私密或运行目录');
        const content = await sandbox.readFile(sandboxId, filePath);
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
      // Reserve all deterministic child actions before the first file write.
      const extra = changes.length - 1 + (after === 'build' ? 1 + automaticValidationSteps(ctx) : 0);
      if (task.tool_steps + extra > config.maxToolSteps) throw new AgentStopError('TOOL_STEP_LIMIT', '预算不足以执行这组修改；尚未写入任何文件');
      let result;
      try { result = await (ctx.workspace
        ? (params) => ctx.workspace.apply(changes, { ...params, baseRevision: ctx.contextRevision })
        : ctx.deps.applyChangesFixture)({ task, sandbox, sandboxId, changes, deps: ctx.deps,
        invalidate: () => progress.invalidate(),
        beforeWrite: async (index, filePath) => {
          assertExecutionActive();
          if (index > 0) consumeStep(ctx);
          task.current_tool = { tool: 'write_file', path: filePath, started: performance.now() };
          ctx.lastWriteChanged = false;
          // A started write is not a successful write; mark done only after journal resolution.
          markRunning(task.plan, 'write_file');
          recordOperation('write_file');
          if (tool === 'apply_changes') await ctx.deps.appendStep(task, { tool: 'write_file', event: 'started', phase: 'write_file', path: filePath, observation: `正在写入 ${filePath}` });
        },
        onWriteSuccess: async (_index, change, codeChanged) => {
          ctx.lastWriteChanged = codeChanged;
          applyToolResult(task.plan, 'write_file', true);
          if (tool === 'apply_changes') await ctx.deps.appendStep(task, { tool: 'write_file', event: 'finished', phase: 'write_file', path: change.path,
            ok: true, code_changed: codeChanged, ms: Math.round(Math.max(0, performance.now() - task.current_tool.started)), observation: `已写入 ${change.path}（${change.content.length} 字符）` });
        },
      }); } catch (error) {
        if (after === 'build' && error.operations) error.operations.push({ kind: 'build', status: 'not_run' });
        throw error;
      }
      if (ctx.workspace) ctx.contextRevision = ctx.workspace.state.revision;
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
      if (ctx.workspace) {
        const r = await ctx.workspace.apply([{ operation: 'delete', path: args.path }], { baseRevision: ctx.contextRevision });
        ctx.lastDeleteChanged = r.changed;
        if (r.changed) progress.invalidate();
        ctx.contextRevision = ctx.workspace.state.revision;
        return { observation: `已确认删除 ${args.path}`, ok: true };
      }
      const existing = await sandbox.listFiles(sandboxId, sandbox.workdir);
      ctx.lastDeleteChanged = existing.includes(args.path);
      await ctx.deps.deleteFile(task, args.path);
      progress.invalidate();
      return { observation: `已删除 ${args.path}`, ok: true };
    }
    case 'run_command': {
      if (ctx.workspace) {
        if (!/^npm (?:install|i)(?: --no-audit)?(?: --no-fund)?(?: --ignore-scripts)?$/.test(args.command.trim())) return { observation: '当前只允许受控 npm install；源码改动请使用 write_file/apply_changes/delete_file。任意 shell 改写暂未开放。', ok: false };
        const rev = ctx.workspace.state.revision;
        const r = await ctx.workspace.runtime('install', () => runCommand(sandbox, sandboxId, INSTALL_CMD), { adoptLockfile: true });
        if (ctx.workspace.state.revision !== rev) progress.invalidate();
        ctx.contextRevision = ctx.workspace.state.revision;
        return { observation: formatResult(r), ok: r.exitCode === 0 };
      }
      if (mayModifyCode(args.command)) progress.invalidate();
      const result = await runCommand(sandbox, sandboxId, args.command);
      return { observation: formatResult(result), ok: result.exitCode === 0 };
    }
    case 'build': {
      // A known start+verify pipeline must fit before spending a build side effect.
      if (task.tool_steps + automaticValidationSteps(ctx) > config.maxToolSteps) {
        throw new AgentStopError('TOOL_STEP_LIMIT', '预算不足以完成构建后的启动与验收；尚未执行构建');
      }
      if (ctx.workspace && ctx.workspace.valid('build', ctx.buildBasis) && ctx.workspace.state.build.status === 'passed') {
        progress.recordBuild(true);
        return { observation: '复用当前源码和构建依据的已成功证据，未重新构建。', ok: true, reused: true };
      }
      const depsGate = await checkSandboxDependencies(sandbox, sandboxId);
      if (depsGate) return { observation: depsGate, ok: false };
      let result;
      if (ctx.workspace) {
        const installed = await ctx.workspace.runtime('install', () => runCommand(sandbox, sandboxId, INSTALL_CMD), { adoptLockfile: true });
        ctx.contextRevision = ctx.workspace.state.revision;
        if (installed.exitCode !== 0) return { observation: formatResult(installed), ok: false };
        validateRuntimeScript(ctx.workspace.manifest, 'build');
        result = await ctx.workspace.runtime('build', () => runCommand(sandbox, sandboxId, 'npm run --ignore-scripts build'));
        await ctx.workspace.evidence('build', ctx.buildBasis, result.exitCode === 0 ? 'passed' : 'failed', { exitCode: result.exitCode });
      } else result = await runCommand(sandbox, sandboxId, BUILD_CMD);
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
      if (ctx.workspace) {
        validateRuntimeScript(ctx.workspace.manifest, 'dev');
        const installed = await sandbox.exec(sandboxId, 'test -x node_modules/.bin/vite', { timeoutMs: 20000 });
        if (installed.timedOut) throw sourceError('WORKSPACE_ENVIRONMENT', '无法确认预览依赖状态，未启动');
        if (installed.exitCode !== 0) {
          const revision = ctx.workspace.state.revision;
          const command = ctx.workspace.manifest.files.some((f) => f.path === 'package-lock.json')
            ? 'npm ci --no-audit --no-fund --ignore-scripts' : INSTALL_CMD;
          const r = await ctx.workspace.runtime('install', () => runCommand(sandbox, sandboxId, command), { adoptLockfile: true });
          ctx.contextRevision = ctx.workspace.state.revision;
          if (r.exitCode !== 0) return { observation: formatResult(r), ok: false };
          if (revision !== ctx.contextRevision) {
            progress.invalidate();
            return { observation: '预览依赖恢复产生了真实 lockfile 变化，请先构建当前 revision。', ok: false };
          }
        }
      }
      const start = async () => {
      let commandId;
      let ready = await sandbox.isPortListening(sandboxId, 5173);
      if (ready) {
        const http = await sandbox.exec(sandboxId, 'curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:5173/', { timeoutMs: 10000 });
        if (http.timedOut) throw sourceError('WORKSPACE_UNCERTAIN', '预览健康检查未确认结束');
        if (!/^2\d\d$/.test(http.stdout.trim())) return { observation: '预览进程已运行，但 HTTP 不可用；保留进程与源码，未盲目重启。', ok: false };
      } else ({ commandId } = await sandbox.startBackground(sandboxId, DEV_CMD));
      for (let i = 0; i < 20 && !ready; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000));
        ready = await sandbox.isPortListening(sandboxId, 5173);
      }
      const devLog = commandId ? (await sandbox.readLogs(sandboxId, { commandId }).catch(() => '')).slice(-1500) : '';
      if (!ready) return { observation: `开发服务器 60 秒内未监听 5173 端口,日志:\n${devLog}`, ok: false };
      const previewUrl = await sandbox.previewUrl(sandboxId, 5173);
      if (!previewUrl) return { observation: '服务已启动但未取得预览地址。', ok: false };
      progress.recordPreview(previewUrl);
      ctx.previewUrl = previewUrl;
      await ctx.deps.updateProject(task.project_id, task.user_id, { preview_url: previewUrl, sandbox_id: sandboxId }, task.id);
      logger.info('preview.written', { taskId: task.id, projectId: task.project_id, sandboxId, previewUrl });
      return { observation: `开发服务器已启动,预览地址: ${previewUrl}`, ok: true };
      };
      const r = ctx.workspace ? await ctx.workspace.runtime('start', start) : await start();
      if (ctx.workspace?.valid('verify', ctx.verifyBasis) && ctx.workspace.state.verify.result) {
        ctx.verificationResult = ctx.workspace.state.verify.result;
        progress.recordVerification(ctx.verificationResult);
      }
      return r;
    }
    case 'verify': {
      const blocked = progress.canVerify();
      if (blocked) return { observation: blocked, ok: false };
      if (Object.keys(args).length) return { observation: 'verify 不接受检查参数;检查由已保存的计划版本固定。请用空 args 重试。', ok: false };
      const checks = ctx.acceptance.filter((a) => a.steps?.length).map(({ id, steps }) => ({ id, steps }));
      const validated = validateChecks(ctx.acceptance, checks);
      if (ctx.workspace?.valid('verify', ctx.verifyBasis)) {
        const previous = ctx.workspace.state.verify;
        if (['passed', 'success_with_warnings', 'inconclusive'].includes(previous.status)) {
          ctx.verificationResult = previous.result; progress.recordVerification(previous.result);
          return { observation: '复用当前 revision/验收依据的浏览器结论，未重新验收。', ok: true, reused: true };
        }
        throw new AgentStopError('VERIFY_REVISION_UNCHANGED', '当前源码和验收依据已有失败结论；请先实际修复源码或修订计划，不重复 verify。');
      }
      requireVerificationBudget(task);
      if (!ctx.workspace) requireNewRevisionForVerification(task);
      const attempt = verificationAttempts(task.steps) + 1;
      await ctx.deps.appendStep(task, { tool: 'verify_attempt', phase: 'verify', event: 'started',
        observation: `第 ${attempt}/${MAX_VERIFY_ATTEMPTS} 次浏览器验收；失败后等待用户决定，不自动修复` });
      const verify = () => (ctx.deps.verifyApp || runVerification)({ sandbox, sandboxId, checks: validated.checks });
      const raw = ctx.workspace ? await ctx.workspace.runtime('verify', verify) : await verify();
      const result = classifyResult(raw, ctx.acceptance);
      if (ctx.workspace) await ctx.workspace.evidence('verify', ctx.verifyBasis, result.kind, result);
      ctx.verificationResult = result;
      progress.recordVerification(result);
      await ctx.deps.appendStep(task, { tool: 'verify_report', phase: 'verify',
        observation: `验收结论: ${result.kind}`, result: { kind: result.kind,
          items: result.items.map((i) => ({ id: i.id, status: i.status, reason: i.reason,
            stepResults: i.status === 'verified' ? [] : i.stepResults })) } });
      if (result.kind === 'tool_error') throw new AgentStopError('VERIFY_TOOL_ERROR', formatObservation(result, attempt, MAX_VERIFY_ATTEMPTS));
      // Missing external configuration or ambiguous assertions remain unverified in the report.
      if (result.kind === 'blocker') {
        throw new AgentStopError('VERIFY_FAILED', formatObservation(result, attempt, MAX_VERIFY_ATTEMPTS));
      }
      return { observation: formatObservation(result, attempt, MAX_VERIFY_ATTEMPTS), ok: true };
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
  if (deps === defaultDeps && !options.workspace) throw sourceError('WORKSPACE_REQUIRED', '生产 Build 必须使用统一 workspace service');
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
    acceptance: canonicalAcceptance, verificationResult: null, fusionEnabled, runtimePolicy, workspace: options.workspace,
    contextRevision: options.workspace?.state.revision, buildBasis: options.buildBasis, verifyBasis: options.verifyBasis };
  if (ctx.workspace?.valid('build', ctx.buildBasis) && ctx.workspace.state.build.status === 'passed') progress.recordBuild(true);


  const stages = Array.isArray(task.plan) && task.plan.length && task.plan[0]?.key ? task.plan : initialStages();
  task.plan = stages;

  let invalidResponses = 0;
  while (task.tool_steps < config.maxToolSteps) {
    assertExecutionActive();
    if (task.aborted) throw new AgentStopError('ABORTED', task.aborted);
    if (ctx.workspace) await ctx.workspace.assertCurrent(ctx.contextRevision);
    task.current_tool = null;
    await ctx.deps.updateTask(task.id, { phase: 'deciding' });
    const raw = await ctx.deps.chat(history, { temperature: 0.1, json: true, reasoningMode: 'off', interactionMode: 'json_action', taskId: task.id,
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
        if (ctx.workspace) {
          await ctx.workspace.assertCurrent(ctx.contextRevision);
          await ctx.workspace.runtime('checkpoint', async () => ({}));
        }
        return { summary, previewUrl: ctx.previewUrl, verificationKind: ctx.verificationResult?.kind };
      }
      history.push({ role: 'user', content: `观察结果:\n${blocked}` });
      await ctx.deps.appendStep(task, { tool, phase: tool, observation: blocked });
      progress.recordResult(tool, args, false);
      continue;
    }

    let observation;
    let ok;
    let parentSucceeded = false;
    markRunning(stages, tool);
    const started = performance.now();
    task.current_tool = { tool, started };
    const activityPath = ['read_file', 'write_file', 'delete_file'].includes(tool) && typeof args.path === 'string'
      && args.path.length <= 120 && !/[\r\n?]/.test(args.path) ? args.path : undefined;
    await ctx.deps.appendStep(task, { tool, phase: tool, event: 'started', path: activityPath, observation: '' });
    try {
      ({ observation, ok } = await withObservation(`tool.${tool}`, { metadata: { tool } }, 'tool', async (obs) => {
        const r = await executeOperation(ctx, tool, args, false);
        parentSucceeded = r.ok;
        if (tool === 'build' && r.ok) {
          const validation = await advanceValidation(ctx);
          r.observation += '\n' + validation.observation;
          // Child validation is separately recorded; it cannot rewrite the successful build fact.
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
      if (error?.code === 'LEASE_LOST' || isSupabaseError(error) || /^(WORKSPACE|SOURCE|CHECKPOINT)_/.test(error?.code || '')) throw error;
      if (error instanceof AgentStopError) {
        // Automatic child failure must not relabel successful writes/build as failed.
        if (!parentSucceeded && (task.current_tool?.tool === tool || error.code === 'CHANGE_UNCERTAIN')) {
          applyToolResult(stages, tool, false, error.message.slice(0, 120));
        }
        // A child verification failure stops the workflow, but the completed parent build remains successful.
        await ctx.deps.appendStep(task, { tool, phase: parentSucceeded ? tool : 'stopped', event: 'finished', ok: parentSucceeded,
          ms: Math.max(0, performance.now() - started), observation: parentSucceeded ? '构建成功；后续校验停止：' + error.message : error.message,
          ...(error.operations ? { result: { status: error.code === 'CHANGE_UNCERTAIN' ? 'uncertain' : 'partial', operations: error.operations } } : {}) });
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

    // executeOperation already records this verify outcome; do not double count it.
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
      ...(tool === 'write_file' ? { code_changed: ctx.lastWriteChanged === true } : {}),
      ...(tool === 'delete_file' ? { code_changed: ctx.lastDeleteChanged === true } : {}),
      ...(tool === 'run_command' ? { modifies_code: mayModifyCode(args.command) } : {}),
      ok, ms: Math.max(0, performance.now() - started), observation: observation.slice(0, 1500),
    });
    history.push({ role: 'user', content: `观察结果:\n${observation.slice(0, 6000)}` });
    if (ctx.verificationResult && ['success_with_warnings', 'inconclusive'].includes(ctx.verificationResult.kind)) {
      const summary = composeSummary('已生成可预览版本，部分验收尚未通过或证据不足。', ctx.verificationResult);
      await ctx.deps.appendStep(task, { tool: 'finish', phase: 'finishing', observation: summary });
      return { summary, previewUrl: ctx.previewUrl, verificationKind: ctx.verificationResult.kind };
    }

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
  const reuse = tool === 'build' && ctx.workspace?.valid('build', ctx.buildBasis) && ctx.workspace.state.build.status === 'passed'
    || tool === 'verify' && ctx.workspace?.valid('verify', ctx.verifyBasis) && ['passed','success_with_warnings','inconclusive'].includes(ctx.workspace.state.verify.status);
  if (!reuse && !['write_file', 'apply_changes'].includes(tool)) recordOperation(tool);
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
    if (!result.reused) recordOperation(tool, tool === 'verify' ? ctx.verificationResult?.kind === 'passed' : result.ok);
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

function automaticValidationSteps(ctx) {
  return ctx.fusionEnabled && ctx.runtimePolicy.workflow === 'web_app'
    && JSON.stringify(ctx.runtimePolicy.afterBuildSuccess) === JSON.stringify(['start_dev', 'verify']) ? 2 : 0;
}

async function advanceValidation(ctx) {
  if (!automaticValidationSteps(ctx)) return { ok: true, observation: '', operations: [] };
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

/** Scaffold is a logical mutation; hydration itself only materializes an existing revision. */
export async function hydrateSandbox(workspace) {
  const changes = Object.entries(SCAFFOLD_FILES).filter(([path]) => !workspace.manifest.files.some((f) => f.path === path))
    .map(([path, content]) => ({ operation: 'write', path, content }));
  if (changes.length) await workspace.apply(changes, { origin: 'scaffold' });
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
  const deps = { ...defaultDeps, getPlan, listFeedback, checkLease: () => ensureLease(task.id) };
  let workspace, sandbox, sandboxId;
  if (task.mode === 'build') {
    await updateTask(task.id, { phase: 'reconciling' });
    const existing = await getProject(task.project_id, task.user_id);
    sandbox = guardedSandbox(getSandboxProvider('daytona'));
    workspace = new Workspace({ rpc: admin.rpc.bind(admin), projectId: task.project_id, taskId: task.id, workerId: config.workerId, executionId: task.execution_id, sandbox, sandboxId: existing.sandbox_id });
    await workspace.read();
    if (task.operation === 'user_apply') assertUserApplyExecution(task, await getRequestedChangeSet(task), workspace.state);
    if (workspace.state.writer) {
      if (workspace.state.writer.kind === 'legacy') throw sourceError('WORKSPACE_LEGACY_QUIESCENCE_REQUIRED', '旧 journal 尚未确认停止；保留原沙箱并人工核对');
      if (!existing.sandbox_id || existing.sandbox_id !== workspace.state.writer.sandbox_id) throw sourceError('WORKSPACE_UNCERTAIN', '待核对操作的原沙箱与项目绑定不一致');
      await sandbox.ensure(existing.sandbox_id, { projectId: task.project_id, userId: task.user_id, allowRecreate: false });
      await workspace.reconcile();
    }
    const ensured = await sandbox.ensure(existing.sandbox_id, { projectId: task.project_id, userId: task.user_id });
    sandboxId = ensured.sandboxId;
    workspace.sandboxId = sandboxId;
    workspace.gateway.id = sandboxId;
    await updateProject(task.project_id, task.user_id, { sandbox_id: sandboxId, status: 'running' }, task.id);
    await workspace.initialize({ newSandbox: !ensured.alive });
    if (task.operation === 'user_apply') task.context_workspace_revision = workspace.state.revision;
  }
  // Validation-only resume reuses existing lease/workspace/tool/completion contracts; no model path.
  if (verificationContinuationCandidate(task, workspace)) {
    const plan = await getPlan(task.plan_id, task.project_id);
    const acceptance = validateAcceptance(plan.content.acceptance);
    const buildBasis = buildFingerprint(await buildRuntimeBasis(sandbox, sandboxId));
    assertVerificationContinuationBasis(task, workspace, plan, acceptance, buildBasis);
    const verifyBasis = verifyFingerprint(acceptance, { runnerHash: sha256(RUNNER_SOURCE), playwrightVersion: PLAYWRIGHT_VERSION, buildBasis });
    const result = await runDeterministicValidation(task, sandbox, sandboxId, workspace,
      { plan, acceptance, buildBasis, verifyBasis }, deps,
      { summary: '继续固定验收，源码未修改。', stageNote: '继续已构建应用的固定验收；无模型调用' });
    await workspace.runtime('checkpoint', async () => ({}));
    if (buildFingerprint(await buildRuntimeBasis(sandbox, sandboxId)) !== buildBasis)
      throw sourceError('WORKSPACE_EVIDENCE_STALE', '固定验收续接期间构建环境发生变化');
    const checkpoint = await workspace.call('ita_complete_build_checkpoint', {
      p_key: task.id + ':checkpoint', p_revision: workspace.state.revision, p_hash: workspace.manifest.code_hash,
      p_build_basis: buildBasis, p_verify_basis: verifyBasis, p_basis_id: plan.id,
      p_summary: result.summary, p_preview_url: result.previewUrl,
    });
    return { ...result, completed: checkpoint.completed };
  }
  if (task.operation === 'user_apply') {
    const project = await getProject(task.project_id, task.user_id);
    return executeUserApply({ task, workspace, loadChange: () => getRequestedChangeSet(task),
      onApply: async (change) => {
        task.tool_steps += change.changes.length;
        recordToolCall('user_apply');
        for (const file of change.changes) recordOperation('write_file',true);
        await appendStep(task, {tool:'user_apply',phase:'edit',event:'finished',ok:true,observation:'已确认应用：'+change.changes.map(c=>c.path).join(', ')});
      },
      validateBasis: async (change) => {
        if (task.tool_steps + (change.status === 'committed' ? 0 : change.changes.length) + 3 > config.maxToolSteps) throw new AgentStopError('TOOL_STEP_LIMIT','预算不足以应用修改并完成固定验证；尚未改源码');
        const frozen = userApplyBasis(change);
        const plan = await getPlan(task.plan_id, task.project_id);
        if (plan.id !== frozen.basis_id || plan.version !== task.plan_version) throw sourceError('WORKSPACE_BASIS_INVALID', 'Fixed regression basis changed');
        const acceptance = validateAcceptance(plan.content.acceptance);
        const buildBasis = buildFingerprint(await buildRuntimeBasis(sandbox, sandboxId));
        const verifyBasis = verifyFingerprint(acceptance, { runnerHash: sha256(RUNNER_SOURCE), playwrightVersion: PLAYWRIGHT_VERSION, buildBasis });
        if (buildBasis !== frozen.build_basis || verifyBasis !== frozen.verify_basis)
          throw sourceError('WORKSPACE_BASIS_INVALID', 'Stable validation basis is not compatible with this runtime; Apply stopped');
        return { plan, acceptance, buildBasis, verifyBasis };
      },
      validateAndComplete: async (basis) => {
        const result = await runDeterministicValidation(task, sandbox, sandboxId, workspace, basis, deps);
        await workspace.runtime('checkpoint', async () => ({}));
        if (buildFingerprint(await buildRuntimeBasis(sandbox, sandboxId)) !== basis.buildBasis) throw sourceError('WORKSPACE_EVIDENCE_STALE', 'Build runtime basis changed');
        const checkpoint = await workspace.call('ita_complete_build_checkpoint', {
          p_key: task.id + ':checkpoint', p_revision: workspace.state.revision, p_hash: workspace.manifest.code_hash,
          p_build_basis: basis.buildBasis, p_verify_basis: basis.verifyBasis, p_basis_id: basis.plan.id,
          p_summary: result.summary, p_preview_url: result.previewUrl || project.preview_url,
        });
        return { ...result, completed: checkpoint.completed };
      },
    });
  }
  await updateTask(task.id, { phase: 'understand' });
  const project = await getProject(task.project_id, task.user_id);
  const files = workspace ? workspace.manifest.files : sourceManifest(await listFiles(task.project_id)).files;
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
  await hydrateSandbox(workspace);
  if (!workspace.manifest.files.some((f) => f.path === 'src/forge-persistence.ts')) await workspace.apply([{ operation: 'write', path: 'src/forge-persistence.ts', content: renderPersistenceHelper(config.environmentId, task.project_id) }], { origin: 'scaffold' });
  const preserveDesign = preserveIterationDesign(project, basis.plan, task.prompt)
    && workspace.manifest.files.some(f=>f.path===DESIGN_TOKENS_PATH);
  if (!preserveDesign) await workspace.apply([{ operation: 'write', path: DESIGN_TOKENS_PATH, content: renderDesignTokensCss(design) }], { origin: 'design' });
  const runtime = await buildRuntimeBasis(sandbox, sandboxId);
  const buildBasis = buildFingerprint(runtime);
  const verifyBasis = verifyFingerprint(basis.acceptance, { runnerHash: sha256(RUNNER_SOURCE), playwrightVersion: PLAYWRIGHT_VERSION, buildBasis });
  await updateTask(task.id, { phase: 'react' });
  const { summary, previewUrl, verificationKind } = await runBuild(
    task, project, sandbox, sandboxId, context, deps, `${basis.prompt}\n\n${preserveDesign ? ITERATION_DESIGN_PROMPT : renderDesignPrompt(design)}`, basis.acceptance,
    { planChars: basis.prompt.length, runtimePolicy: webValidationPolicy(basis.plan, config.actionFusionEnabled), workspace, buildBasis, verifyBasis }
  );

  await extractMemories({ userId: task.user_id, projectId: task.project_id, userPrompt: task.prompt, summary, taskId: task.id });
  await workspace.runtime('checkpoint', async () => ({}));
  const finalBasis = buildFingerprint(await buildRuntimeBasis(sandbox, sandboxId));
  if (finalBasis !== buildBasis) throw sourceError('WORKSPACE_EVIDENCE_STALE', '构建环境已变更；不能沿用旧证据完成');
  const completion = {
    p_key: `${task.id}:checkpoint`, p_revision: workspace.state.revision, p_hash: workspace.manifest.code_hash,
    p_build_basis: buildBasis, p_verify_basis: verifyBasis, p_basis_id: basis.plan.id, p_summary: summary,
    p_preview_url: previewUrl || project.preview_url,
  };
  // This single DB transaction creates snapshot/message/project outcome/task terminal state.
  const checkpoint = await workspace.call('ita_complete_build_checkpoint', completion);
  return { summary, previewUrl, verificationKind, completed: checkpoint.completed };
}

export async function buildRuntimeBasis(sandbox, sandboxId) {
  const js = `const fs=require('node:fs'),c=require('node:crypto'); const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>['NODE_ENV','NODE_OPTIONS'].includes(k)||k.startsWith('VITE_')).sort(([a],[b])=>a.localeCompare(b))); const files=fs.readdirSync('.').filter(p=>/^\\.env(?:\\..*)?$/.test(p)&&p!=='.env.example').sort().map(p=>[p,fs.readFileSync(p).toString('base64')]); console.log(JSON.stringify({nodeVersion:process.version,platform:process.platform,arch:process.arch,environmentHash:c.createHash('sha256').update(JSON.stringify({env,files})).digest('hex')}));`;
  const r = await sandbox.exec(sandboxId, `node -e ${shellQuote(js)}`, { timeoutMs: 20000 });
  const npm = await sandbox.exec(sandboxId, 'npm --version', { timeoutMs: 20000 });
  if (r.exitCode !== 0 || r.timedOut || npm.exitCode !== 0 || npm.timedOut) throw sourceError('WORKSPACE_ENVIRONMENT', '无法取得真实构建环境依据');
  return { ...JSON.parse(r.stdout.trim()), npmVersion: npm.stdout.trim(), command: 'npm run --ignore-scripts build', installCommand: INSTALL_CMD };
}

/** Deterministic edit validation reuses the actual Worker tool pipeline; no ReAct or model calls. */
export async function runDeterministicValidation(task, sandbox, sandboxId, workspace, basis, deps, { summary = '已应用用户提交的文件修改。', stageNote = '已确认用户提交；无模型调用' } = {}) {
  task.plan = initialStages();
  for (const stage of task.plan.filter(s=>['understand','read','edit'].includes(s.key))) {stage.status='done';stage.note=stageNote;}
  const progress = new BuildProgress({ maxFixRounds: config.maxFixRounds, fixRounds: task.fix_rounds || 0 });
  const ctx = { task, sandbox, sandboxId, workspace, progress, deps, acceptance: basis.acceptance,
    buildBasis: basis.buildBasis, verifyBasis: basis.verifyBasis, contextRevision: workspace.state.revision,
    previewUrl: '', verificationResult: null, fusionEnabled: false, runtimePolicy: { workflow: 'manual', afterBuildSuccess: [] } };
  if (task.tool_steps + 3 > config.maxToolSteps) throw new AgentStopError('TOOL_STEP_LIMIT', 'Validation budget exhausted; source preserved');
  for (const tool of ['build', 'start_dev', 'verify']) {
    const result = await executeOperation(ctx, tool, {}, true);
    if (!result.ok) throw new AgentStopError('USER_APPLY_VALIDATION_FAILED', result.observation);
  }
  const blocked = progress.canFinish();
  if (blocked) throw new AgentStopError('USER_APPLY_VALIDATION_FAILED', blocked);
  return { summary: composeSummary(summary, ctx.verificationResult).replace('已实现(代理说明):','已应用:'),
    previewUrl: ctx.previewUrl, verificationKind: ctx.verificationResult.kind };
}

// Ordinary action iteration follows the confirmed workspace, including user-applied styling.
export function preserveIterationDesign(project, plan, prompt) {
  return Boolean(project.checkpoint_id && plan?.kind === 'action' && !wantsDesignChange(prompt));
}
const ITERATION_DESIGN_PROMPT = '【已有应用迭代】当前 Workspace 的布局和 src/design-tokens.css 是已有样式依据；保留用户已确认的手工修改。旧设计记忆仅供参考，不能用它重置当前样式。不重做无关界面，继续使用已有 CSS tokens、系统字体、可见焦点与响应式约定；新增依赖仍需声明和安装。';
