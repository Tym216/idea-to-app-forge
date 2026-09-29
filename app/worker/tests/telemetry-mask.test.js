import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureLlmMessages, maskTelemetryData } from '../src/telemetry.js';

test('导出脱敏保留长 system 之后的计划修正消息,不再二次截到 2000 字符', () => {
  const input = captureLlmMessages([
    { role: 'system', content: '规划规则'.repeat(1000) },
    { role: 'assistant', content: '{"scope":[]}' },
    { role: 'user', content: '输出无效(scope 必须为非空数组)，请修正。 Bearer sk-testsecret123456789' },
  ], { LANGFUSE_CAPTURE_CONTENT: 'true' });
  const uploaded = maskTelemetryData({ data: JSON.stringify(input) });
  const restored = JSON.parse(uploaded);
  assert.equal(restored.length, 3);
  assert.match(restored[2].content, /输出无效\(scope/);
  assert.doesNotMatch(uploaded, /sk-testsecret/);
});

test('导出仍有长度上限,关闭调试时不采集内容', () => {
  assert.equal(maskTelemetryData({ data: 'x'.repeat(120001) }).length, 120001);
  assert.ok(maskTelemetryData({ data: 'x'.repeat(120001) }).endsWith('…'));
  assert.equal(captureLlmMessages([{ role: 'user', content: 'private' }], { LANGFUSE_CAPTURE_CONTENT: 'false' }), undefined);
});
