import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';
process.env.FORGE_NO_MAIN = '1';

const { runPlan, runBuild, resolveBuildBasis } = await import('../src/agent.js');
const { validatePlan, applyToolResult, initialStages, MAX_QUESTIONS } = await import('../src/planner.js');
const { LeaseLostError } = await import('../src/supabase.js');
const { summarizeError } = await import('../src/index.js');

const PLAN = {
  understanding: '做一个待办应用', scope: ['添加', '删除', '完成'], steps: ['写 App', '构建'], design: '单列',
  acceptance: [{ id: 'A1', action: '添加待办', expect: '列表出现新任务', external: false, steps: [{ op: 'fill', selector: '[data-testid=task-input]', value: '买牛奶' }, { op: 'click', selector: '[data-testid=add-task]' }, { op: 'expectText', selector: '[data-testid=task-list]', contains: '买牛奶' }] }],
  questions: [{ id: 'q1', question: '是否需要持久化?', options: ['本地存储', '不需要'], recommended: '本地存储' }],
};

function recorder(outputs = []) {
  const calls = { upsertFile: 0, deleteFile: 0, updateProject: 0, savePlan: [], steps: [], messages: [], patches: [] };
  let i = 0;
  const deps = {
    calls,
    chat: async () => outputs[Math.min(i++, outputs.length - 1)],
    upsertFile: async () => { calls.upsertFile += 1; },
    deleteFile: async () => { calls.deleteFile += 1; },
    updateProject: async () => { calls.updateProject += 1; },
    updateTask: async (_id, p) => calls.patches.push(p),
    appendStep: async (_t, s) => calls.steps.push(s),
    addMessage: async (_t, _r, c, m) => calls.messages.push({ c, m }),
    savePlan: async (_t, kind, content) => { calls.savePlan.push({ kind, content }); return { id: `p-${kind}`, version: 3, kind, content }; },
  };
  return deps;
}

test('Plan 模式:保存待审阅计划,不写文件、不启动应用、不改项目', async () => {
  const deps = recorder([JSON.stringify(PLAN)]);
  const { plan } = await runPlan({ id: 't' }, 'ctx', { layout: { type: 'single-column' } }, deps);
  assert.equal(plan.version, 3);
  assert.equal(deps.calls.savePlan[0].kind, 'plan');
  assert.equal(deps.calls.upsertFile + deps.calls.deleteFile + deps.calls.updateProject, 0);
  assert.equal(deps.calls.steps[0].phase, 'awaiting_review');
  assert.match(deps.calls.messages[0].c, /1 个问题/);
});

test('计划校验:问题最多 3 个,推荐项必须是选项之一', () => {
  const qs = Array.from({ length: MAX_QUESTIONS + 1 }, (_, n) => ({ id: `q${n}`, question: 'x', options: ['a', 'b'] }));
  assert.throws(() => validatePlan({ ...PLAN, questions: qs }), /最多 3/);
  assert.throws(() => validatePlan({ ...PLAN, questions: [{ id: 'q', question: 'x', options: ['a', 'b'], recommended: 'c' }] }), /recommended/);
  assert.deepEqual(validatePlan({ ...PLAN, questions: undefined }).questions, []);
});

test('Build 读取已批准版本与反馈;未批准或版本不符被拒绝', async () => {
  const approved = { id: 'p2', version: 2, kind: 'plan', status: 'approved', content: PLAN };
  const deps = {
    ...recorder(),
    getPlan: async () => approved,
    getLatestPlanVersion: async () => 2,
    listFeedback: async (_p, v) => [{ plan_version: 1, content: '加上截止日期', answers: { q1: '本地存储' }, upTo: v }],
  };
  const basis = await resolveBuildBasis({ id: 't', project_id: 'p', plan_id: 'p2', plan_version: 2 }, 'ctx', deps);
  assert.match(basis.prompt, /已批准的计划 v2/);
  assert.match(basis.prompt, /加上截止日期/);
  assert.match(basis.prompt, /q1=本地存储/);
  assert.match(basis.prompt, /列表出现新任务/);
  assert.equal(basis.acceptance[0].id, 'A1');
  assert.equal(deps.calls.savePlan.length, 0); // 不另起方案
  await assert.rejects(resolveBuildBasis({ id: 't', project_id: 'p', plan_id: 'p2', plan_version: 1 }, 'ctx', deps), (e) => e.code === 'PLAN_VERSION_MISMATCH');
  const draftDeps = { ...deps, getPlan: async () => ({ ...approved, status: 'draft' }) };
  await assert.rejects(resolveBuildBasis({ id: 't', project_id: 'p', plan_id: 'p2', plan_version: 2 }, 'ctx', draftDeps), (e) => e.code === 'PLAN_NOT_APPROVED');
});

test('直接 Build:先生成并保存简短行动计划(视为授权)再执行', async () => {
  const deps = recorder([JSON.stringify({ understanding: '待办', steps: ['读代码', '改 App', '构建'], acceptance: PLAN.acceptance })]);
  const task = { id: 't', project_id: 'p' };
  const basis = await resolveBuildBasis(task, 'ctx', deps);
  assert.equal(deps.calls.savePlan[0].kind, 'action');
  assert.equal(task.plan_id, 'p-action');
  assert.match(deps.calls.steps[0].observation, /读代码 → 改 App → 构建/);
  assert.match(basis.prompt, /v3/);
});

test('租约失效:开始事件写入被拒绝时立即中止,不执行工具', async () => {
  const execs = [];
  const deps = {
    ...recorder([JSON.stringify({ tool: 'run_command', args: { command: 'ls' } })]),
    appendStep: async () => { throw new LeaseLostError('t'); },
  };
  const sandbox = { workdir: '/w', exec: async (_i, c) => { execs.push(c); return { exitCode: 0, stdout: '', stderr: '' }; }, checkProcess: async () => false };
  await assert.rejects(runBuild({ id: 't', tool_steps: 0, fix_rounds: 0 }, {}, sandbox, 's', 'ctx', deps, '', PLAN.acceptance), (e) => e.code === 'LEASE_LOST');
  assert.equal(execs.length, 0);
});

test('超时后标记 aborted 的旧执行不会继续调用工具', async () => {
  const task = { id: 't', tool_steps: 0, fix_rounds: 0, aborted: '任务已超时' };
  const deps = recorder([JSON.stringify({ tool: 'build', args: {} })]);
  await assert.rejects(runBuild(task, {}, {}, 's', 'ctx', deps, '', PLAN.acceptance), (e) => e.code === 'ABORTED');
  assert.equal(deps.calls.steps.length, 0);
});

test('超时错误摘要记录最后执行的工具与耗时,并给出下一步', () => {
  const s = summarizeError(Object.assign(new Error('x'), { code: 'TASK_TIMEOUT' }), { current_tool: { tool: 'build', started: performance.now() - 5000 } });
  assert.equal(s.lastTool, 'build');
  assert.match(s.reason, /最后执行 build,已耗时 5 秒/);
  assert.match(s.next, /恢复任务/);
});

test('模型网络错误明确指出模型阶段，并建议恢复已保存任务', () => {
  const error = Object.assign(new Error('调用 zhipu 模型 glm-4.5-air 网络请求失败（约 30 秒）'), { code: 'LLM_NETWORK' });
  const summary = summarizeError(error, { current_tool: null });
  assert.equal(summary.code, 'LLM_NETWORK');
  assert.match(summary.reason, /zhipu.*网络请求失败/);
  assert.match(summary.next, /恢复任务.*无需新建沙箱/);
  assert.equal(summary.lastTool, null);
});

test('阶段状态只随真实结果推进;改代码后构建结果回到待开始', () => {
  const st = initialStages();
  applyToolResult(st, 'build', false);
  assert.equal(st.find((s) => s.key === 'build').status, 'failed');
  applyToolResult(st, 'build', true);
  applyToolResult(st, 'start_dev', true);
  assert.equal(st.find((s) => s.key === 'preview').status, 'done');
  applyToolResult(st, 'write_file', true);
  assert.equal(st.find((s) => s.key === 'build').status, 'pending');
  assert.equal(st.find((s) => s.key === 'preview').status, 'pending');
});

test('计划缺少固定检查不能保存或在批准后由 Build 偷偷补写', async () => {
  assert.throws(() => validatePlan({ ...PLAN, acceptance: [{ id: 'A1', action: '添加', expect: '新增一项', external: false }] }), /缺少验收条件 A1/);
  let modelCalls = 0;
  const oldPlan = { id: 'old', version: 1, kind: 'plan', status: 'approved', content: { ...PLAN, acceptance: [{ id: 'A1', action: '添加', expect: '新增一项', external: false }] } };
  const deps = { ...recorder(), getPlan: async () => oldPlan, getLatestPlanVersion: async () => 1, listFeedback: async () => [], chat: async () => { modelCalls += 1; return '{}'; } };
  await assert.rejects(resolveBuildBasis({ id: 't', project_id: 'p', plan_id: 'old', plan_version: 1 }, 'ctx', deps), (e) => e.code === 'PLAN_REVISION_REQUIRED');
  assert.equal(modelCalls, 0);
});

test('出现新计划后不允许恢复绑定旧验收的任务', async () => {
  const deps = { ...recorder(), getPlan: async () => ({ id: 'old', version: 2, kind: 'plan', status: 'approved', content: PLAN }), getLatestPlanVersion: async () => 3 };
  await assert.rejects(resolveBuildBasis({ id: 't', project_id: 'p', plan_id: 'old', plan_version: 2 }, 'ctx', deps), (e) => e.code === 'PLAN_VERSION_STALE');
});


test('budget failure summary preserves cost details and points to the effective setting without automatic retry',()=>{
 const message='Forge 本次执行的模型预算保护已触发（不是供应商余额不足）：预算 CNY 0.5，已预留理论费用 CNY 0.4713674，下一次请求理论上限 CNY 0.0408118。该请求尚未发送；以上为保守估算，不是实际扣费。';
 for(const setting of ['LLM_MAX_THEORETICAL_COST_PER_EXECUTION','LLM_MAX_THEORETICAL_COST_USD_PER_EXECUTION']) {
  const result=summarizeError(Object.assign(new Error(message),{code:'LLM_COST_BUDGET_EXCEEDED',budgetSetting:setting}),{mode:'build'});
  assert.equal(result.reason,message);
  assert.ok(result.next.includes(setting));
  assert.match(result.next,/重启 Worker/);
  assert.match(result.next,/不会自动加预算或重试/);
 }
});
