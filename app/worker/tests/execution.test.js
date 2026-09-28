import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';
process.env.MAX_FIX_ROUNDS = '6';
process.env.MAX_TOOL_STEPS = '40';

const sb = await import('../src/supabase.js');
const { upsertMemory } = await import('../src/memory.js');
const { runBuild, BUILD_CMD } = await import('../src/agent.js');

// 模拟数据库:只有与当前 execution_id 精确匹配的写入才生效(与 0002 的 SQL 条件一致)
const db = { execution: null, calls: [] };
sb.admin.rpc = async (fn, args) => {
  db.calls.push({ fn, exec: args.p_execution_id });
  const ok = args.p_execution_id === db.execution;
  if (fn === 'ita_worker_save_plan' || fn === 'ita_worker_upsert_memory') {
    return ok ? { data: { id: 'x' }, error: null } : { data: null, error: { message: 'LEASE_LOST' } };
  }
  return { data: ok, error: null };
};

test('同一 worker 重新领取后:E1 的心跳/任务/步骤/文件/计划/记忆写入全部被拒,E2 全部成功', async () => {
  const task = { id: 't1', steps: [], tool_steps: 0 };
  db.execution = 'E1';
  sb.setExecution('t1', 'E1');
  await sb.updateTask('t1', { phase: 'react' }); // E1 有效
  db.execution = 'E2'; // 超时 → resume → 再次领取得到 E2
  const lost = (e) => e.code === 'LEASE_LOST';
  await assert.rejects(sb.heartbeat('t1'), lost);
  await assert.rejects(sb.updateTask('t1', { phase: 'zombie' }), lost);
  await assert.rejects(sb.appendStep(task, { tool: 'write_file', phase: 'react' }), lost);
  await assert.rejects(sb.ensureLease('t1'), lost);
  await assert.rejects(sb.savePlan(task, 'action', {}), lost);
  const before = db.calls.length;
  await upsertMemory('t1', { scope: 'project', key: 'k', value: 'v' });
  assert.equal(db.calls[before].exec, 'E1'); // 记忆写入以 E1 调用,数据库拒绝(只记 warn)

  sb.setExecution('t1', 'E2');
  await sb.heartbeat('t1');
  await sb.updateTask('t1', { phase: 'e2' });
  await sb.appendStep(task, { tool: 'build', phase: 'react' });
  await sb.ensureLease('t1');
  await sb.savePlan(task, 'action', {});
  await upsertMemory('t1', { scope: 'project', key: 'k', value: 'v' });
  assert.ok(db.calls.slice(-6).every((c) => c.exec === 'E2'));
  sb.setExecution('t1', null);
  assert.equal(sb.executionOf('t1'), null);
});

test('恢复后预算已重置:历史累计 40 步/6 轮的任务仍能 build → start_dev → finish', async () => {
  const actions = [{ tool: 'build', args: {} }, { tool: 'start_dev', args: {} }, { tool: 'verify', args: {} }, { tool: 'finish', args: { summary: 'resumed-ok' } }];
  let i = 0;
  const steps = [];
  const deps = {
    chat: async () => JSON.stringify(actions[Math.min(i++, actions.length - 1)]),
    appendStep: async (_t, s) => steps.push(s),
    updateTask: async () => {}, updateProject: async () => {}, upsertFile: async () => {}, deleteFile: async () => {},
    verifyApp: async () => ({ checks: [{ id: 'A1', status: 'pass', reason: '' }], base: { blocking: [], warnings: [] }, screenshots: [] }),
  };
  const sandbox = {
    workdir: '/w',
    async exec(_id, cmd) { return { exitCode: 0, stdout: cmd === BUILD_CMD ? 'built' : '', stderr: '' }; },
    async checkProcess() { return false; },
    async listFiles() { return ['package.json']; },
    async readFile() { return '{}'; },
    async writeFile() {},
    async startBackground() { return { commandId: 'c' }; },
    async isPortListening() { return true; },
    async readLogs() { return ''; },
    async previewUrl() { return 'https://preview.example'; },
  };
  // 与 ita_retry_task(resume) 返回值一致:本次计数清零,历史并入 total_*
  const task = { id: 'r', user_id: 'u', project_id: 'p', tool_steps: 0, fix_rounds: 0, total_tool_steps: 40, total_fix_rounds: 6, kind: 'resume', resumes: 1 };
  const result = await runBuild(task, {}, sandbox, 's', 'ctx', deps, '', [{ id: 'A1', action: '打开页面', expect: '看到内容', external: false, steps: [{ op: 'expectText', selector: 'main', contains: '内容' }] }]);
  assert.match(result.summary, /已实现.*resumed-ok/);
  assert.match(result.summary, /已验证.*A1/);
  assert.equal(task.tool_steps, 4);
  assert.ok(!steps.some((s) => /TOOL_STEP_LIMIT|FIX_LIMIT_REACHED/.test(String(s.observation))));
});
