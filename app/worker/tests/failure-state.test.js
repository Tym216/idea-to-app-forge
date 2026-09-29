import { test } from 'node:test';
import assert from 'node:assert/strict';
process.env.FORGE_NO_MAIN = '1';
const { makeFailurePatch } = await import('../src/index.js');
const { isSupabaseError } = await import('../src/execution-control.js');
test('数字 DOMException 错误码不导致错误处理再次崩溃', () => {
  const error = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.equal(error.code, 23);
  assert.equal(isSupabaseError(error), false);
  const patch = makeFailurePatch(error, { current_tool: null });
  assert.equal(patch.status, 'failed');
  assert.equal(JSON.parse(patch.error).code, 'ERROR');
  assert.match(JSON.parse(patch.error).reason, /timeout/);
  assert.equal(isSupabaseError({ code: 'SUPABASE_NETWORK' }), true);
  assert.equal(isSupabaseError({ code: 'LLM_TIMEOUT' }), false);
});
test('AGENT_STALLED failure writes integer milliseconds and preserves failure code', () => {
  const error = Object.assign(new Error('stalled'), { code: 'AGENT_STALLED' });
  const patch = makeFailurePatch(error, { current_tool: { tool: 'read_file', started: performance.now() - 1025.337 } });
  assert.equal(patch.status, 'failed');
  assert.equal(patch.phase, 'error');
  assert.equal(patch.last_tool, 'read_file');
  assert.ok(Number.isInteger(patch.last_tool_ms) && patch.last_tool_ms >= 1025);
  assert.equal(JSON.parse(patch.error).code, 'AGENT_STALLED');
});
test('failure without current tool omits runtime milliseconds', () => {
  const patch = makeFailurePatch(new Error('network'), { current_tool: null });
  assert.equal('last_tool_ms' in patch, false);
});
test('invalid or future elapsed time never becomes a negative/noninteger value', () => {
  for (const started of [NaN, performance.now() + 5000]) {
    const patch = makeFailurePatch(new Error('x'), { current_tool: { tool: 'verify', started } });
    assert.equal(patch.last_tool_ms, 0);
  }
});
