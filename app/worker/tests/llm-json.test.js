import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequestBody, classifyModelFetchError, parseJson } from '../src/llm.js';

test('zhipu glm-4-plus 不发送 response_format,其他模型保留', () => {
  const base = { messages: [], temperature: 0.1, json: true };
  assert.equal(buildRequestBody({ ...base, providerName: 'zhipu', model: 'glm-4-plus' }).response_format, undefined);
  assert.deepEqual(buildRequestBody({ ...base, providerName: 'deepseek', model: 'deepseek-chat' }).response_format, {
    type: 'json_object',
  });
});

test('parseJson 保留完整文件名与字符串', () => {
  const raw = '```json\n{"tool":"write_file","args":{"path":"package.json","content":"{\\"type\\":\\"application/json\\"}"}}\n```';
  const action = parseJson(raw);
  assert.equal(action.args.path, 'package.json');
  assert.match(action.args.content, /application\/json/);
});

test('模型 fetch 故障区分超时与网络错误，不回显底层地址或密钥', () => {
  const context = { providerName: 'zhipu', model: 'glm-4.5-air', elapsedMs: 123000 };
  const timeout = classifyModelFetchError({ name: 'TimeoutError' }, context);
  assert.equal(timeout.code, 'LLM_TIMEOUT');
  assert.match(timeout.message, /zhipu.*glm-4\.5-air.*超时/);
  const network = classifyModelFetchError({ name: 'TypeError', message: 'fetch failed Bearer secret', cause: { code: 'ECONNRESET' } }, context);
  assert.equal(network.code, 'LLM_NETWORK');
  assert.equal(network.causeCode, 'ECONNRESET');
  assert.doesNotMatch(network.message, /Bearer|secret|https?:/);
});
