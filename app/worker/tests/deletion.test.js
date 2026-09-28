import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SUPABASE_URL ||= 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-placeholder';

const { processOneDeletion, classifySandboxes } = await import('../src/deletion.js');
const { activeMemories, extractMemories } = await import('../src/memory.js');
const { isNotFound, sandboxLabels } = await import('../src/sandbox/daytona.js');

/** 模拟数据库删除队列:与 0003 的 claim/complete 语义一致。 */
function fakeDb(job) {
  const calls = [];
  let pending = job;
  return {
    calls,
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === 'ita_claim_project_deletion') { const j = pending; pending = null; return { data: j ? [j] : [], error: null }; }
      if (fn === 'ita_complete_project_deletion') return { data: args.p_ok ? 'deleted' : 'failed', error: null };
      return { data: null, error: { message: 'unexpected' } };
    },
    requeue(j) { pending = j; },
  };
}
const complete = (db) => db.calls.filter((c) => c.fn === 'ita_complete_project_deletion');

test('删除成功:只删除该项目保存的 sandbox_id,然后完成数据删除', async () => {
  const db = fakeDb({ project_id: 'P', user_id: 'u', sandbox_id: 'sbx-P', attempts: 1 });
  const destroyed = [];
  const r = await processOneDeletion({ rpc: db.rpc, getSandbox: () => ({ destroy: async (id) => { destroyed.push(id); return { existed: true }; } }), workerId: 'w' });
  assert.deepEqual(destroyed, ['sbx-P']);
  assert.equal(r.status, 'deleted');
  assert.equal(complete(db)[0].args.p_ok, true);
  assert.equal(complete(db)[0].args.p_attempts, 1);
});

test('沙箱不存在视为成功', async () => {
  const db = fakeDb({ project_id: 'P', user_id: 'u', sandbox_id: 'gone', attempts: 1 });
  const r = await processOneDeletion({ rpc: db.rpc, getSandbox: () => ({ destroy: async () => ({ existed: false }) }), workerId: 'w' });
  assert.equal(r.status, 'deleted');
});

test('Daytona 删除失败:标记 failed(项目保留)且原因脱敏;重试成功后完成', async () => {
  const db = fakeDb({ project_id: 'P', user_id: 'u', sandbox_id: 'sbx-P', attempts: 1 });
  let fail = true;
  const sandbox = { destroy: async () => { if (fail) throw new Error('503 Bearer dtn_secretkey123 https://x.daytona.io/a?token=abc'); return { existed: true }; } };
  const r1 = await processOneDeletion({ rpc: db.rpc, getSandbox: () => sandbox, workerId: 'w' });
  assert.equal(r1.status, 'failed');
  const err = complete(db)[0].args.p_error;
  assert.equal(complete(db)[0].args.p_ok, false);
  assert.ok(err.includes('503') && !/dtn_secret|token=abc/.test(err), err);
  fail = false;
  db.requeue({ project_id: 'P', user_id: 'u', sandbox_id: 'sbx-P', attempts: 2 });
  const r2 = await processOneDeletion({ rpc: db.rpc, getSandbox: () => sandbox, workerId: 'w' });
  assert.equal(r2.status, 'deleted');
});

test('没有待删除项目时不调用 Daytona', async () => {
  const db = fakeDb(null);
  let touched = false;
  assert.equal(await processOneDeletion({ rpc: db.rpc, getSandbox: () => { touched = true; }, workerId: 'w' }), null);
  assert.equal(touched, false);
});

test('孤儿核对:只有带标签且项目不存在才是孤儿;无标签归属未知;不看创建时间', () => {
  const r = classifySandboxes([
    { id: 'a', labels: { app: 'forge', forge_project_id: 'P1' }, createdAt: '2020-01-01' },
    { id: 'b', labels: { app: 'forge', forge_project_id: 'GONE' } },
    { id: 'c', labels: { app: 'forge' }, createdAt: '2000-01-01' },
  ], ['P1']);
  assert.deepEqual(r.inUse.map((s) => s.id), ['a']);
  assert.deepEqual(r.orphan.map((s) => s.id), ['b']);
  assert.deepEqual(r.unknown.map((s) => s.id), ['c']);
});

test('沙箱标签包含 project_id / user_id;404 判定为不存在', () => {
  assert.deepEqual(sandboxLabels({ projectId: 'p', userId: 'u' }), { app: 'forge', forge_project_id: 'p', forge_user_id: 'u' });
  assert.ok(isNotFound({ statusCode: 404 }) && isNotFound(new Error('Sandbox not found')) && !isNotFound(new Error('503')));
});

test('停用的默认偏好不注入;项目约定照常', () => {
  const list = activeMemories([
    { scope: 'user', key: 'a', enabled: true }, { scope: 'user', key: 'off', enabled: false }, { scope: 'project', key: 'p' },
  ]);
  assert.deepEqual(list.map((m) => m.key), ['a', 'p']);
});

test('记忆抽取:user 范围只生成建议,不自动写入;不自动删除全局偏好', async () => {
  const log = [];
  await extractMemories({ userId: 'u', projectId: 'p', userPrompt: 'x', summary: 'y', taskId: 't' }, {
    chat: async () => JSON.stringify({
      upsert: [{ scope: 'user', key: 'lang', value: '中文' }, { scope: 'project', key: 'db', value: 'local' }],
      remove: [{ scope: 'user', key: 'old' }, { scope: 'project', key: 'tmp' }],
    }),
    upsertMemory: async (_t, i) => log.push(`upsert:${i.scope}:${i.key}`),
    suggestMemory: async (_t, i) => log.push(`suggest:${i.key}`),
    deleteMemory: async (_u, _p, scope, key) => log.push(`delete:${scope}:${key}`),
  });
  assert.deepEqual(log, ['suggest:lang', 'upsert:project:db', 'delete:project:tmp']);
});
