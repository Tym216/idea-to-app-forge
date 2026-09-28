import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentStopError, BuildProgress, mayModifyCode } from '../src/build-progress.js';

test('相同失败调用先提示调整,持续重复则 AGENT_STALLED', () => {
  const p = new BuildProgress({ maxFixRounds: 6, maxRepeats: 3 });
  assert.equal(p.recordResult('read_file', { path: 'package.' }, false), '');
  assert.match(p.recordResult('read_file', { path: 'package.' }, false), /不要重复/);
  assert.throws(() => p.recordResult('read_file', { path: 'package.' }, false), (e) => e.code === 'AGENT_STALLED');
});

test('构建/预览门槛、失效与修复上限', () => {
  const p = new BuildProgress({ maxFixRounds: 1 });
  assert.ok(p.canStartDev());
  assert.ok(p.canFinish());
  p.recordBuild(true);
  assert.equal(p.canStartDev(), '');
  assert.ok(p.canFinish());
  p.recordPreview('https://preview');
  assert.ok(p.canFinish());
  assert.equal(p.canVerify(), '');
  p.recordVerification({ kind: 'passed' });
  assert.equal(p.canFinish(), '');
  p.invalidate();
  assert.ok(p.canFinish());
  p.recordBuild(true);
  p.recordPreview('https://preview');
  assert.ok(p.canFinish());
  assert.ok(mayModifyCode('npm install lodash'));
  assert.ok(!mayModifyCode('ls src'));
  p.recordBuild(false);
  assert.throws(() => p.recordBuild(false), (e) => e instanceof AgentStopError && e.code === 'FIX_LIMIT_REACHED');
});
