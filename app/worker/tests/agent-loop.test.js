import { applyChanges as applyChangesFixture } from './fixtures/legacy-changes.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';

// agent.js 间接导入 supabase.js,需在导入前提供占位配置(不发起任何网络请求)
process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';
process.env.MAX_FIX_ROUNDS = '2';
process.env.MAX_TOOL_STEPS = '40';

const { runBuild: actualRunBuild, hydrateSandbox, BUILD_CMD, DEV_CMD, previousVerificationFailure } = await import('../src/agent.js');
const acceptance = [{ id: 'A1', action: '打开页面', expect: '看到内容', external: false, steps: [{ op: 'expectText', selector: 'main', contains: '内容' }] }];
const verify = { checks: [{ id: 'A1', status: 'pass', reason: '' }], base: { blocking: [], warnings: [] }, screenshots: [] };
function runBuild(task, project, sandbox, sandboxId, context, deps) {
  deps.verifyApp ||= async () => verify;
  return actualRunBuild(task, project, sandbox, sandboxId, context, deps, '', acceptance);
}
const verifyAction = { tool: 'verify', args: {} };
const { SCAFFOLD_FILES } = await import('../src/scaffold.js');

function fakeSandbox({ buildExit = 0 } = {}) {
  const calls = [];
  return {
    calls,
    workdir: '/w',
    async exec(_id, cmd) {
      calls.push(cmd);
      return { exitCode: cmd === BUILD_CMD ? buildExit : 0, stdout: cmd.startsWith('curl ') ? '200' : '', stderr: '' };
    },
    async checkProcess() { return false; },
    async listFiles() { return ['package.json', 'src/App.tsx']; },
    async readFile(_id, p) { if (p !== 'package.json') throw new Error('not found'); return '{}'; },
    async writeFile(_id, p) { calls.push(`write:${p}`); },
    async startBackground(_id, cmd) { calls.push(`bg:${cmd}`); return { commandId: 'c1' }; },
    async isPortListening() { return true; },
    async readLogs() { return ''; },
    async previewUrl() { return 'https://preview.example'; },
  };
}

function fakeDeps(actions) {
  const steps = [];
  const upserts = [];
  let i = 0;
  return {
    applyChangesFixture,
    steps,
    upserts,
    checkLease: async () => {},
    listFiles: async () => [],
    chat: async () => JSON.stringify(actions[Math.min(i++, actions.length - 1)]),
    appendStep: async (t, s) => { steps.push(s); (t.steps ||= []).push(s); },
    updateTask: async () => {},
    updateProject: async () => {},
    upsertFile: async (_t, path) => upserts.push(path),
    deleteFile: async () => {},
  };
}

const finishedSteps = (deps) => deps.steps.filter((step) => step.event !== 'started' && step.tool !== 'change_journal');

const newTask = () => ({ id: 't', user_id: 'u', project_id: 'p', tool_steps: 0, fix_rounds: 0 });

test('连续无效模型输出只修正一次，每次有活动记录且不把长输出加入上下文', async () => {
  const deps = fakeDeps([]);
  let calls = 0;
  deps.chat = async (messages) => {
    calls++;
    assert.ok(messages.every((m) => !m.content.includes('invalid-output-')));
    return 'invalid-output-'.repeat(1000);
  };
  const task = newTask();
  const sb = fakeSandbox();
  await assert.rejects(runBuild(task, {}, sb, 's', 'ctx', deps), { code: 'LLM_FORMAT_STALLED' });
  assert.equal(calls, 2);
  assert.equal(task.tool_steps, 2);
  assert.equal(deps.steps.filter((s) => s.tool === 'llm_parse_error').length, 2);
  assert.equal(sb.calls.length, 0);
});

test('缺少 write_file 的 content 按协议修正一次，不能当成空文件写入', async () => {
  const deps = fakeDeps([{ tool: 'write_file', args: { path: 'src/App.tsx' } }]);
  const task = newTask();
  const sb = fakeSandbox();
  await assert.rejects(runBuild(task, {}, sb, 's', 'ctx', deps), { code: 'LLM_FORMAT_STALLED' });
  assert.equal(task.tool_steps, 2);
  assert.deepEqual(sb.calls, []);
  assert.deepEqual(deps.upserts, []);
});

test('浏览器验收工具故障立即停止，不继续调用模型或计入应用修复轮数', async () => {
  const deps = fakeDeps([{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, { tool: 'verify', args: {} }]);
  let calls = 0;
  const originalChat = deps.chat;
  deps.chat = async (...args) => { calls++; return originalChat(...args); };
  deps.verifyApp = async () => ({ toolError: 'npm package name invalid' });
  const task = newTask();
  await assert.rejects(runBuild(task, {}, fakeSandbox(), 's', 'ctx', deps), { code: 'VERIFY_TOOL_ERROR' });
  assert.equal(calls, 3);
  assert.equal(task.fix_rounds, 0);
  assert.match(deps.steps.at(-1).observation, /浏览器验收环境故障/);
});

test('修复上限:构建持续失败时循环层以 FIX_LIMIT_REACHED 终止,不被工具级 catch 吞掉', async () => {
  const task = newTask();
  const deps = fakeDeps([{ tool: 'build', args: {} }]);
  const sandbox = fakeSandbox({ buildExit: 1 });
  await assert.rejects(runBuild(task, {}, sandbox, 's', 'ctx', deps), (e) => e.code === 'FIX_LIMIT_REACHED');
  assert.equal(task.tool_steps, 3); // 2 轮修复 + 第 3 次超限,远低于总步数 40
  assert.equal(deps.steps.at(-1).phase, 'stopped');
  assert.ok(sandbox.calls.every((c) => !c.includes('pnpm')));
});

test('门槛:未构建拒绝 start_dev 与 finish;构建+预览后 finish 成功;使用 npm 命令', async () => {
  const deps = fakeDeps([
    { tool: 'start_dev', args: {} },
    { tool: 'finish', args: { summary: 'x' } },
    { tool: 'build', args: {} },
    { tool: 'finish', args: { summary: 'x' } },
    { tool: 'start_dev', args: {} },
    { tool: 'finish', args: { summary: 'x' } },
    verifyAction,
    { tool: 'finish', args: { summary: 'done' } },
  ]);
  const sandbox = fakeSandbox();
  const result = await runBuild(newTask(), {}, sandbox, 's', 'ctx', deps);
  assert.match(result.summary, /已验证.*A1/);
  assert.equal(result.previewUrl, 'https://preview.example');
  assert.match(finishedSteps(deps)[0].observation, /尚未成功构建,不能 start_dev/);
  assert.match(finishedSteps(deps)[1].observation, /不能 finish/);
  assert.match(finishedSteps(deps)[3].observation, /尚未启动开发服务器/);
  assert.match(finishedSteps(deps)[5].observation, /尚未取得浏览器验收结果/);
  assert.ok(sandbox.calls.includes('npm install --no-audit --no-fund --ignore-scripts --package-lock=true && npm run build'));
  assert.ok(!sandbox.calls.includes(`bg:${DEV_CMD}`)); // Healthy existing preview is preserved.
  assert.ok(sandbox.calls.some(c=>c.startsWith('curl ')));
});

test('文件工具在执行前记录真实路径和开始事件，完成后记录结果', async () => {
  const deps = fakeDeps([
    { tool: 'read_file', args: { path: 'package.json' } },
    { tool: 'build', args: {} },
    { tool: 'start_dev', args: {} },
    verifyAction,
    { tool: 'finish', args: { summary: '完成' } },
  ]);
  await runBuild(newTask(), {}, fakeSandbox(), 's', 'ctx', deps);
  assert.deepEqual(deps.steps.slice(0, 2).map((step) => [step.event, step.tool, step.path, step.ok]), [
    ['started', 'read_file', 'package.json', undefined],
    ['finished', 'read_file', 'package.json', true],
  ]);
});

test('失效:验收通过后改代码,旧结果不能直接 finish', async () => {
  const deps = fakeDeps([
    { tool: 'build', args: {} },
    { tool: 'start_dev', args: {} },
    verifyAction,
    { tool: 'write_file', args: { path: 'src/App.tsx', content: 'x' } },
    { tool: 'finish', args: {} },
    { tool: 'build', args: {} },
    { tool: 'start_dev', args: {} },
    verifyAction,
    { tool: 'finish', args: { summary: 'ok' } },
  ]);
  const result = await runBuild(newTask(), {}, fakeSandbox(), 's', 'ctx', deps);
  assert.ok(finishedSteps(deps).some((step) => /不能 finish/.test(step.observation)));
  assert.match(result.summary, /已验证.*A1/);
});

test('重复失败:read_file 同参数连续失败返回文件列表并以 AGENT_STALLED 终止', async () => {
  const deps = fakeDeps([{ tool: 'read_file', args: { path: 'package.' } }]);
  await assert.rejects(runBuild(newTask(), {}, fakeSandbox(), 's', 'ctx', deps), (e) => e.code === 'AGENT_STALLED');
  assert.match(finishedSteps(deps)[0].observation, /实际存在的文件:\npackage\.json/);
  assert.match(finishedSteps(deps)[1].observation, /不要重复/);
});

test('脚手架通过 workspace system Change Set，不走直接文件 upsert', async () => {
  const changes=[];
  await hydrateSandbox({manifest:{files:[{path:'src/App.tsx',content:'x'}]},apply:async (items,opts)=>{changes.push({items,opts});}});
  assert.equal(changes[0].opts.origin,'scaffold');
  assert.ok(changes[0].items.some((c)=>c.path==='package.json'));
  assert.ok(!changes[0].items.some((c)=>c.path==='src/App.tsx'));
});



test('Build 提交弱断言被拒绝;验收只执行计划绑定的检查', async () => {
  let checksSeen;
  const deps = fakeDeps([
    { tool: 'build', args: {} },
    { tool: 'start_dev', args: {} },
    { tool: 'verify', args: { checks: [{ id: 'A1', steps: [{ op: 'expectVisible', selector: 'body' }] }] } },
    verifyAction,
    { tool: 'finish', args: { summary: 'done' } },
  ]);
  deps.verifyApp = async ({ checks }) => {
    checksSeen = checks;
    return verify;
  };
  const result = await runBuild(newTask(), {}, fakeSandbox(), 's', 'ctx', deps);
  assert.match(finishedSteps(deps)[2].observation, /不接受检查参数/);
  assert.deepEqual(checksSeen, [{ id: 'A1', steps: acceptance[0].steps }]);
  assert.match(result.summary, /已验证.*A1/);
});

test('无 confirmed workspace 的旧测试路径不能自动获得修复写入资格，保留预览并停止', async () => {
  const task = newTask();
  const deps = fakeDeps([{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, verifyAction]);
  let called = 0;
  deps.chat = async () => JSON.stringify(called++ < 2 ? [{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }][called - 1] : verifyAction);
  deps.verifyApp = async () => ({ checks: [{ id: 'A1', status: 'fail', reason: '内容缺失' }], base: { blocking: ['页面异常: 核心流程崩溃'], warnings: [] } });
  await assert.rejects(runBuild(task, {}, fakeSandbox(), 's', 'ctx', deps), (e) => e.code === 'VERIFY_FAILED');
  assert.equal(task.tool_steps, 3);
  assert.equal(called, 3);
  assert.equal(task.fix_rounds, 0);
  assert.equal(task.steps.filter((s) => s.tool === 'verify_attempt').length, 1);
  assert.equal(task.plan.find((s) => s.key === 'verify').status, 'failed');
});

test('verify budget guards the expensive action, not recovery; a confirmed edit permits second check', async () => {
  const task = newTask();
  task.steps = [{ tool: 'verify_attempt', event: 'started' }, { tool: 'write_file', event: 'finished', ok: true }];
  const deps = fakeDeps([{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, verifyAction]);
  deps.verifyApp = async () => ({ checks: [{ id: 'A1', status: 'fail', reason: '内容缺失' }], base: { blocking: ['页面异常: 核心流程崩溃'], warnings: [] } });
  await assert.rejects(runBuild(task, {}, fakeSandbox(), 's', 'ctx', deps), { code: 'VERIFY_FAILED' });
  assert.equal(task.steps.filter((s) => s.tool === 'verify_attempt').length, 2);

  let calls = 0;
  deps.chat = async () => JSON.stringify([
    { tool: 'write_file', args: { path: 'src/App.tsx', content: 'fixed' } },
    { tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, verifyAction,
  ][calls++]);
  task.tool_steps = 0; // RPC resume resets tool steps but preserves verification attempts.
  const sandbox = fakeSandbox();
  await assert.rejects(runBuild(task, {}, sandbox, 's', 'ctx', deps), { code: 'VERIFY_ATTEMPT_LIMIT' });
  assert.equal(calls, 4);
  assert.ok(sandbox.calls.includes('write:src/App.tsx'));
  assert.equal(task.steps.filter((s) => s.tool === 'verify_attempt').length, 2);
});

test('same code revision cannot spend another verify attempt', async () => {
  const task = newTask();
  task.steps = [{ tool: 'verify_attempt', event: 'started' }];
  const deps = fakeDeps([{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, verifyAction]);
  let verifyCalls = 0;
  deps.verifyApp = async () => { verifyCalls++; return verify; };
  const sandbox = fakeSandbox();
  await assert.rejects(runBuild(task, {}, sandbox, 's', 'ctx', deps), { code: 'VERIFY_REVISION_UNCHANGED' });
  assert.ok(sandbox.calls.includes(BUILD_CMD));
  assert.equal(verifyCalls, 0);
  assert.equal(task.steps.filter((s) => s.tool === 'verify_attempt').length, 1);
});

test('手动重试上下文携带最近的验收失败，不要求重新生成全部应用', () => {
  const text = previousVerificationFailure({ steps: [{ tool: 'verify', ok: false, observation: '找不到 game-board' }] });
  assert.match(text, /找不到 game-board/);
  assert.match(text, /request_plan_revision/);
  assert.equal(previousVerificationFailure({ steps: [] }), '');
});

test('验收定义错误时 Build 请求新计划并停止,不自行改断言', async () => {
  const deps = fakeDeps([{ tool: 'request_plan_revision', args: { reason: 'A1 要求的按钮与用户确认的流程冲突' } }]);
  await assert.rejects(runBuild(newTask(), {}, fakeSandbox(), 's', 'ctx', deps), (e) => e.code === 'PLAN_REVISION_REQUIRED' && /A1/.test(e.message));
  assert.equal(deps.steps.at(-1).phase, 'stopped');
});

test('非阻断验收失败保留预览并完成带警告任务，不追加修复模型调用', async () => {
  const task = newTask();
  const deps = fakeDeps([{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, verifyAction]);
  let calls = 0;
  deps.chat = async () => JSON.stringify([{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, verifyAction][calls++]);
  deps.verifyApp = async () => ({ base: { blocking: [], warnings: [] },
    checks: [{ id: 'A1', status: 'fail', reason: '步骤 3 expectTrue: 表达式为假', stepResults: [{ index: 3, op: 'expectTrue', ok: false, actual: 'false' }] }] });
  const result = await runBuild(task, {}, fakeSandbox(), 's', 'ctx', deps);
  assert.equal(result.verificationKind, 'success_with_warnings');
  assert.match(result.summary, /未验证.*A1/);
  assert.equal(calls, 3);
  assert.equal(task.steps.find((s) => s.tool === 'verify_report').result.items[0].stepResults[0].actual, 'false');
});


test('manual verify records one attempt and one pass in task metrics', async () => {
  const { createTaskMetrics, withTaskMetrics } = await import('../src/task-metrics.js');
  const task = newTask();
  const deps = fakeDeps([{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, verifyAction,
    { tool: 'finish', args: { summary: '完成' } }]);
  const metrics = createTaskMetrics(task);
  await withTaskMetrics(metrics, () => runBuild(task, {}, fakeSandbox(), 's', 'ctx', deps));
  assert.equal(metrics.verify_count, 1);
  assert.equal(metrics.verify_pass_count, 1);
});


test('provider length response is never executed, even when its JSON parses; one bounded split correction',async()=>{
 const deps=fakeDeps([]),sb=fakeSandbox();let calls=0;
 deps.chatResponse=async messages=>{
  if(++calls===2){
   assert.match(messages.at(-1).content,/拆成多个较小模块/);
   assert.match(messages.at(-1).content,/不要原样重发/);
   assert.ok(messages.every(m=>!m.content.includes('must-not-write.ts')));
  }
  return {text:JSON.stringify({tool:'write_file',args:{path:'src/must-not-write.ts',content:'truncated-code'}}),finishReason:'length'};
 };
 await assert.rejects(runBuild(newTask(),{},sb,'s','ctx',deps),{code:'LLM_OUTPUT_TRUNCATED'});
 assert.equal(calls,2);assert.deepEqual(sb.calls,[]);assert.deepEqual(deps.upserts,[]);
 assert.ok(deps.steps.filter(s=>s.tool==='llm_parse_error').every(s=>s.result.truncated&&s.result.finish_reason==='length'));
});

test('truncation correction can proceed with a complete smaller file and normal build validation',async()=>{
 const actions=[{tool:'write_file',args:{path:'src/Small.tsx',content:'export const small = 1;'}},
  {tool:'build',args:{}},{tool:'start_dev',args:{}},verifyAction,{tool:'finish',args:{summary:'done'}}];
 const deps=fakeDeps(actions),sb=fakeSandbox();let calls=0;
 const normalChat=deps.chat;
 deps.chatResponse=async messages=>++calls===1
  ?{text:'{"tool":"write_file","args":{"path":"src/large.tsx","content":"CUT',finishReason:'length'}
  :{text:await normalChat(messages),finishReason:'stop'};
 const result=await runBuild(newTask(),{},sb,'s','ctx',deps);
 assert.equal(calls,6);assert.ok(result.previewUrl);
 assert.ok(sb.calls.includes('write:src/Small.tsx'));assert.ok(!sb.calls.includes('write:src/large.tsx'));
});
