import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { chat, parseJson } from '../src/llm.js';

test('GLM-4.5-air chat serializes auto without response_format and preserves correction context and complete filename', async () => {
  const previous = { ...config }, savedFetch = globalThis.fetch;
  const messages = [
    { role: 'system', content: '只输出工具 JSON；文件名必须完整。' },
    { role: 'assistant', content: '{"tool":"read_file","args":{"path":"package."}}' },
    { role: 'user', content: '读取 package. 失败；实际存在的文件：package.json。' },
  ];
  let requests = 0;
  try {
    Object.assign(config, { llmProvider: 'zhipu', zhipuModel: 'glm-4.5-air', zhipuApiKey: 'test', zhipuJsonMode: 'auto' });
    globalThis.fetch = async (_url, options) => {
      requests++;
      const body = JSON.parse(options.body);
      assert.equal(body.model, 'glm-4.5-air');
      assert.equal(body.temperature, 0.1);
      assert.ok(!Object.hasOwn(body, 'response_format'));
      assert.deepEqual(body.messages, messages);
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"tool":"read_file","args":{"path":"package.json","offset":0}}' } }] }));
    };
    assert.equal(parseJson(await chat(messages, { json: true, temperature: 0.1 })).args.path, 'package.json');
    assert.equal(requests, 1);
  } finally { Object.assign(config, previous); globalThis.fetch = savedFetch; }
});
