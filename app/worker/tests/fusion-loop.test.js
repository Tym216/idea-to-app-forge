import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'placeholder';
process.env.MAX_TOOL_STEPS = '40';
const { runBuild, BUILD_CMD, webValidationPolicy } = await import('../src/agent.js');
const { createTaskMetrics, withTaskMetrics, metricsSnapshot } = await import('../src/task-metrics.js');
const acceptance = [{ id: 'A1', action: '打开应用', expect: '内容可见', external: false,
  steps: [{ op: 'expectText', selector: 'main', contains: '内容' }] }];
const passed = { base: { blocking: [], warnings: [] }, checks: [{ id: 'A1', status: 'pass' }], screenshots: [] };
const policy = webValidationPolicy({ version: 1, content: { acceptance } }, true);
const change = (path, content = '内容') => ({ operation: 'write', path, content });

function setup(actions, { buildExit = 0, verification = passed } = {}) {
  const files = new Map([['package.json', '{"dependencies":{}}'], ['src/App.tsx', 'old']]);
  const database = new Map(files);
  const calls = [];
  let modelCalls = 0;
  const task = { id: 't', project_id: 'p', user_id: 'u', execution_id: 'E1', tool_steps: 0, fix_rounds: 0, steps: [] };
  const sandbox = {
    workdir: '/w',
    async readFile(_s, path) { if (!files.has(path)) throw new Error('file not found'); return files.get(path); },
    async writeFile(_s, path, content) { calls.push(`write:${path}`); files.set(path, content); },
    async listFiles() { return [...files.keys()]; },
    async exec(_s, command) { calls.push(command); return { exitCode: command === BUILD_CMD ? buildExit : 0, stdout: '', stderr: '' }; },
    async checkProcess() { return false; },
    async startBackground() { calls.push('start'); return { commandId: 'c' }; },
    async isPortListening() { return true; }, async readLogs() { return ''; },
    async previewUrl() { return 'https://preview.example'; },
  };
  const deps = {
    async chat() { const action = actions[modelCalls++]; assert.ok(action, 'unexpected extra model turn'); return JSON.stringify(action); },
    async checkLease() {},
    async appendStep(t, step) { t.steps.push(structuredClone(step)); },
    async listFiles() { return [...database].map(([path, content]) => ({ path, content })); },
    async upsertFile(_t, path, content) { database.set(path, content); },
    async updateTask() {}, async updateProject() {},
    async verifyApp() { calls.push('verify'); return verification; },
  };
  const run = (options = {}) => runBuild(task, {}, sandbox, 's', 'ctx', deps, '', acceptance,
    { fusionEnabled: true, runtimePolicy: policy, ...options });
  return { task, sandbox, deps, calls, files, database, run, modelCalls: () => modelCalls };
}
const finish = { tool: 'finish', args: { summary: '完成' } };

test('same deterministic change: baseline 6 model turns -> fused 2, preserving operations and canonical checks', async () => {
  const baseline = setup([
    { tool: 'write_file', args: { path: 'src/App.tsx', content: '内容' } },
    { tool: 'write_file', args: { path: 'src/index.css', content: '内容' } },
    { tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, { tool: 'verify', args: {} }, finish,
  ]);
  const old = await baseline.run({ fusionEnabled: false, runtimePolicy: webValidationPolicy(null, false) });
  const fused = setup([{ tool: 'apply_changes', args: { changes: [change('src/App.tsx'), change('src/index.css')], after: 'build' } }, finish]);
  const metrics = createTaskMetrics(fused.task, { fusionEnabled: true });
  const result = await withTaskMetrics(metrics, () => fused.run());
  assert.equal(baseline.modelCalls(), 6);
  assert.equal(fused.modelCalls(), 2);
  assert.equal(fused.task.tool_steps, baseline.task.tool_steps);
  assert.deepEqual([...fused.database], [...baseline.database]);
  assert.equal(result.previewUrl, old.previewUrl);
  assert.match(result.summary, /已验证/);
  assert.equal(fused.task.plan.find((s) => s.key === 'verify').status, 'done');
  const snapshot = metricsSnapshot(metrics, 'succeeded');
  assert.equal(snapshot.tool_call_count, 2);
  assert.equal(snapshot.operation_count, 5);
  assert.equal(snapshot.verify_pass_count, 1);
  assert.equal(fused.task.steps.filter((s) => s.tool === 'write_file' && s.event === 'finished').length, 2);
});

test('batch validation rejects duplicate paths before any side effect', async () => {
  const f = setup([{ tool: 'apply_changes', args: { changes: [change('src/App.tsx'), change('src/App.tsx')] } }]);
  await assert.rejects(f.run()); // fake model refuses a subsequent recovery call; no write happened.
  assert.equal(f.calls.length, 0);
  assert.equal(f.task.steps.some((s) => s.tool === 'change_journal'), false);
});

test('insufficient budget stops BEFORE whole batch; auto validation also respects remaining steps', async () => {
  const f = setup([{ tool: 'apply_changes', args: { changes: [change('src/App.tsx'), change('src/index.css')], after: 'build' } }]);
  f.task.tool_steps = 38;
  await assert.rejects(f.run(), { code: 'TOOL_STEP_LIMIT' });
  assert.equal(f.calls.length, 0);
  const automatic = setup([{ tool: 'build', args: {} }]);
  automatic.task.tool_steps = 39;
  await assert.rejects(automatic.run(), { code: 'TOOL_STEP_LIMIT' });
  assert.ok(automatic.calls.includes(BUILD_CMD));
  assert.ok(!automatic.calls.includes('start'));
});

test('manual/non-web policy never auto-starts or auto-verifies', async () => {
  const f = setup([{ tool: 'build', args: {} }, { tool: 'request_plan_revision', args: { reason: '调整验收' } }]);
  await assert.rejects(f.run({ runtimePolicy: webValidationPolicy(null, true) }), { code: 'PLAN_REVISION_REQUIRED' });
  assert.ok(!f.calls.includes('start') && !f.calls.includes('verify'));
});

test('build failure never starts preview; browser failure stops without another repair model turn', async () => {
  const failedBuild = setup([{ tool: 'apply_changes', args: { changes: [change('src/App.tsx')], after: 'build' } },
    { tool: 'request_plan_revision', args: { reason: '需调整' } }], { buildExit: 1 });
  await assert.rejects(failedBuild.run(), { code: 'PLAN_REVISION_REQUIRED' });
  assert.ok(!failedBuild.calls.includes('start'));
  for (const action of [{ tool: 'build', args: {} },
    { tool: 'apply_changes', args: { changes: [change('src/App.tsx')], after: 'build' } }]) {
    const failedVerify = setup([action], { verification: { ...passed, checks: [{ id: 'A1', status: 'fail', reason: '缺少内容' }] } });
    await assert.rejects(failedVerify.run(), { code: 'VERIFY_FAILED' });
    assert.equal(failedVerify.modelCalls(), 1);
    assert.ok(failedVerify.calls.includes('start'));
    assert.equal(failedVerify.task.plan.find((stage) => stage.key === 'build').status, 'done');
    assert.equal(failedVerify.task.plan.find((stage) => stage.key === 'edit').status, 'done');
    assert.equal(failedVerify.task.plan.find((stage) => stage.key === 'verify').status, 'failed');
  }
});

test('pause/lease loss between writes retains first file and prevents build or second write', async () => {
  const f = setup([{ tool: 'apply_changes', args: { changes: [change('src/App.tsx'), change('src/index.css')], after: 'build' } }]);
  f.deps.checkLease = async () => { if (f.database.get('src/App.tsx') === '内容') throw Object.assign(new Error('lost'), { code: 'LEASE_LOST' }); };
  await assert.rejects(f.run(), { code: 'LEASE_LOST' });
  assert.deepEqual(f.calls, ['write:src/App.tsx']);
});

test('successful verification followed by a write invalidates finish; requires fresh build/verify', async () => {
  const f = setup([{ tool: 'build', args: {} },
    { tool: 'apply_changes', args: { changes: [change('src/App.tsx')], after: 'none' } }, finish,
    { tool: 'request_plan_revision', args: { reason: '停止' } }]);
  await assert.rejects(f.run(), { code: 'PLAN_REVISION_REQUIRED' });
  assert.ok(f.task.steps.some((s) => s.tool === 'finish' && /不能 finish/.test(s.observation)));
});
