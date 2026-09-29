import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyChanges, reconcileChanges, validateChanges, hashContent, pendingChanges } from '../src/apply-changes.js';

function fixture({ failDatabase = false, timeoutAfterWrite = false } = {}) {
  const disk = new Map([['src/App.tsx', 'old']]);
  const database = new Map([['src/App.tsx', 'old']]);
  const task = { id: 't', project_id: 'p', execution_id: 'e', steps: [] };
  const writes = [];
  const sandbox = {
    async readFile(_s, p) { if (!disk.has(p)) throw new Error('file not found'); return disk.get(p); },
    async writeFile(_s, p, content) {
      disk.set(p, content); writes.push(p);
      if (timeoutAfterWrite) throw new Error('timeout after write');
    },
  };
  const deps = {
    checkLease: async () => {},
    listFiles: async () => [...database].map(([path, content]) => ({ path, content })),
    listChangeJournals: async () => [{ id: task.id, steps: task.steps }],
    appendStep: async (t, step) => { t.steps.push(structuredClone(step)); },
    upsertFile: async (_t, p, content) => { if (failDatabase) throw new Error('database timeout'); database.set(p, content); },
  };
  return { disk, database, task, writes, sandbox, deps };
}
const changes = [{ operation: 'write', path: 'src/App.tsx', content: 'new' }, { operation: 'write', path: 'src/New.tsx', content: 'second' }];
const run = (f, extra = {}) => applyChanges({ ...f, sandboxId: 's', changes, beforeWrite: async () => {}, invalidate: () => {}, ...extra });

test('validate entire batch before mutation: unsupported/duplicate/traversal/size rejected', () => {
  assert.equal(validateChanges({ changes, after: 'build' }).changes.length, 2);
  for (const path of ['../a', '/etc/passwd', 'src/../../a', 'C:/a', 'src\\a', '.git/config']) {
    assert.throws(() => validateChanges({ changes: [{ operation: 'write', path, content: 'x' }] }));
  }
  assert.throws(() => validateChanges({ changes: [changes[0], { ...changes[0], path: './src/App.tsx' }] }), /重复/);
  assert.throws(() => validateChanges({ changes: [{ ...changes[0], operation: 'patch' }] }));
  assert.throws(() => validateChanges({ changes, after: 'verify' }));
  assert.throws(() => validateChanges({ changes }, { maxBytes: 1 }));
});

test('successful writes have durable intent BEFORE side effect and invalidation before mutation', async () => {
  const f = fixture();
  let invalidated = false;
  const original = f.sandbox.writeFile;
  f.sandbox.writeFile = async (...args) => {
    assert.ok(invalidated);
    assert.ok(f.task.steps.some((s) => s.event === 'intent' && s.path === args[1]));
    await original(...args);
  };
  const result = await run(f, { invalidate: () => { invalidated = true; } });
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(f.writes, ['src/App.tsx', 'src/New.tsx']);
  assert.equal(f.database.get('src/New.tsx'), 'second');
  assert.equal(pendingChanges([{ id: 't', steps: f.task.steps }]).length, 0);
});

test('sandbox succeeded/database failed: uncertain, later writes NOT run; resume reconciles without sandbox replay', async () => {
  const f = fixture({ failDatabase: true });
  await assert.rejects(run(f), (error) => error.code === 'CHANGE_UNCERTAIN' && error.operations[1].status === 'not_run');
  assert.deepEqual(f.writes, ['src/App.tsx']);
  f.deps.upsertFile = async (_t, path, content) => f.database.set(path, content);
  assert.equal(await reconcileChanges({ ...f }), 1);
  assert.deepEqual(f.writes, ['src/App.tsx']);
  assert.equal(f.database.get('src/App.tsx'), 'new');
  assert.equal(await reconcileChanges({ ...f }), 0);
});

test('write timeout AFTER real side effect is reconciled, not repeated', async () => {
  const f = fixture({ timeoutAfterWrite: true });
  await assert.rejects(run(f), { code: 'CHANGE_UNCERTAIN' });
  await reconcileChanges(f);
  assert.equal(f.writes.length, 1);
  assert.equal(f.database.get('src/App.tsx'), 'new');
});

test('crash before write: unchanged states resolve not_applied; conflicting versions halt without overwrite', async () => {
  const f = fixture();
  const intent = { tool: 'change_journal', event: 'intent', operation_id: 'op', sandbox_id: 's', path: 'src/App.tsx', content: 'new',
    intended_hash: hashContent('new'), before_database_hash: hashContent('old'), before_sandbox_hash: hashContent('old') };
  f.task.steps.push(intent);
  await reconcileChanges(f);
  assert.equal(f.task.steps.at(-1).state, 'not_applied');
  f.task.steps.push({ ...intent, operation_id: 'op2' });
  f.disk.set('src/App.tsx', 'somebody-else');
  await assert.rejects(reconcileChanges(f), { code: 'CHANGE_UNCERTAIN' });
  assert.equal(f.disk.get('src/App.tsx'), 'somebody-else');
  assert.equal(f.writes.length, 0);
});

test('lease lost after a write: stop and retain pending intent for next execution', async () => {
  const f = fixture();
  f.deps.checkLease = async () => { if (f.writes.length) throw Object.assign(new Error('lease lost'), { code: 'LEASE_LOST' }); };
  await assert.rejects(run(f), { code: 'LEASE_LOST' });
  assert.equal(f.writes.length, 1);
  assert.equal(pendingChanges([{ id: 't', steps: f.task.steps }]).length, 1);
  assert.equal(f.database.get('src/App.tsx'), 'old');
});

test('pause before second write preserves partial work; new task resolutions match original intent IDs', async () => {
  const f = fixture();
  await assert.rejects(run(f, { beforeWrite: async (index) => { if (index === 1) throw Object.assign(new Error('paused'), { code: 'LEASE_LOST' }); } }), { code: 'LEASE_LOST' });
  assert.deepEqual(f.writes, ['src/App.tsx']);
  const oldSteps = structuredClone(f.task.steps);
  const newer = { id: 'new-task', project_id: 'p', steps: [] };
  f.deps.listChangeJournals = async () => [{ id: 't', steps: oldSteps }, { id: newer.id, steps: newer.steps }];
  await reconcileChanges({ ...f, task: newer });
  assert.equal(await reconcileChanges({ ...f, task: newer }), 0);
  assert.equal(f.writes.length, 1);
});

test('unavailable original sandbox never triggers replacement sandbox or writes', async () => {
  const f = fixture({ failDatabase: true });
  await assert.rejects(run(f), { code: 'CHANGE_UNCERTAIN' });
  f.sandbox.readFile = async () => { throw new Error('sandbox not running'); };
  await assert.rejects(reconcileChanges(f), { code: 'CHANGE_UNCERTAIN' });
  assert.equal(f.writes.length, 1);
});
