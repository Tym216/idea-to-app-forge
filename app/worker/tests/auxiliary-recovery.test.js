import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.SUPABASE_URL = 'http://127.0.0.1:1';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'placeholder';
const { extractMemories, upsertMemory, suggestMemory } = await import('../src/memory.js');
const { admin } = await import('../src/supabase.js');
const { runCommand } = await import('../src/agent.js');
const { withExecutionControl, beforeModelCall } = await import('../src/execution-control.js');
const { logger } = await import('../src/logger.js');
const input = { userId: 'u', projectId: 'p', taskId: 't', userPrompt: 'x', summary: 'done' };

test('actual memory RPC failure propagates to design caller; auxiliary caller warns, lease rejection stops', async () => {
  const original = admin.rpc;
  const item = { scope: 'project', key: 'design_system', value: '{}' };
  try {
    admin.rpc = async () => ({ error: { code: 'P0001', message: 'database write failed' } });
    await assert.rejects(upsertMemory('t', item), { code: 'SUPABASE_STATE' });
    await extractMemories(input, { chat: async () => '{"upsert":[{"scope":"project","key":"x","value":"y"}]}', upsertMemory });
    admin.rpc = async () => ({ error: { code: 'P0001', message: 'LEASE_LOST' } });
    await assert.rejects(upsertMemory('t', item), { code: 'LEASE_LOST' });
    await assert.rejects(suggestMemory('t', item), { code: 'LEASE_LOST' });
    await assert.rejects(extractMemories(input, { chat: async () => '{"upsert":[{"scope":"project","key":"x","value":"y"}]}', upsertMemory }), { code: 'LEASE_LOST' });
  } finally { admin.rpc = original; }
});

test('optional memory API/storage failure is a warning with no model retry', async () => {
  const original = logger.warn, warnings = [];
  logger.warn = (...args) => warnings.push(args);
  try {
    let calls = 0;
    await extractMemories(input, { chat: async () => { calls++; throw new Error('model failure'); } });
    await extractMemories(input, { chat: async () => { calls++; return '{"upsert":[{"scope":"project","key":"x","value":"y"}]}'; },
      upsertMemory: async () => { throw Object.assign(new Error('save failed'), { code: 'SUPABASE_STATE' }); } });
    assert.equal(calls, 2);
    assert.equal(warnings.length, 2);
    assert.ok(warnings.every(([, data]) => data.auxiliary));
  } finally { logger.warn = original; }
});

test('auxiliary warning never swallows cancellation, lease loss, or failed execution permission check', async () => {
  for (const code of ['LEASE_LOST', 'TASK_TIMEOUT', 'ABORTED']) {
    const error = Object.assign(new Error(code), { code });
    await assert.rejects(extractMemories(input, { chat: async () => { throw error; } }), (e) => e === error);
  }
  const permission = Object.assign(new Error('permission check failed'), { code: 'SUPABASE_NETWORK' });
  await assert.rejects(withExecutionControl({ signal: new AbortController().signal, checkLease: async () => { throw permission; } },
    () => extractMemories(input, { chat: beforeModelCall })), (e) => e === permission);
});

test('timed out commands are never replayed regardless of observed process state', async () => {
  for (const state of [true, false, 'unavailable']) {
    let calls = 0;
    await assert.rejects(runCommand({ exec: async () => { calls++; return { timedOut: true, exitCode: 124 }; },
      checkProcess: async () => { if (state === 'unavailable') throw new Error('network'); return state; },
    }, 's', 'npm install'), { code: 'COMMAND_UNCERTAIN' });
    assert.equal(calls, 1);
  }
});
