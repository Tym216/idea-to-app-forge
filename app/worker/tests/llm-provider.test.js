import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROVIDERS, resolveProvider, providerProblems, buildRequestBody } from '../src/llm-provider.js';
import { config, assertRunnable } from '../src/config.js';
import { chat } from '../src/llm.js';

test('各供应商独立选择密钥与模型,规范化 endpoint', () => {
  for (const [name, spec] of Object.entries(PROVIDERS)) {
    const selected = resolveProvider({ llmProvider: name, [`${spec.field}ApiKey`]: `test-${name}`, [`${spec.field}Model`]: 'explicit-model', [`${spec.field}BaseUrl`]: `${spec.baseUrl}/` });
    assert.equal(selected.url, `${spec.baseUrl}/chat/completions`);
    assert.equal(selected.key, `test-${name}`);
    assert.equal(selected.model, 'explicit-model');
  }
});

test('未知供应商及缺少模型拒绝,不隐式退到 DeepSeek', () => {
  assert.throws(() => resolveProvider({ llmProvider: 'typo', deepseekApiKey: 'test' }), /LLM_PROVIDER/);
  assert.deepEqual(providerProblems({ llmProvider: 'gemini', geminiApiKey: 'test' }), ['GEMINI_MODEL 或 LLM_MODEL']);
  assert.deepEqual(providerProblems({ llmProvider: 'openrouter' }), ['OPENROUTER_API_KEY 或 LLM_API_KEY', 'OPENROUTER_MODEL 或 LLM_MODEL']);
  assert.ok(providerProblems({ llmProvider: 'openrouter', openrouterApiKey: 'test', openrouterModel: 'test', openrouterJsonMode: 'bad' }).some((x) => x.includes('JSON_MODE')));
});

test('compatible providers preserve caller temperature; JSON mode stays explicit', () => {
  const base = { messages: [{ role: 'user', content: '输出 JSON' }], model: 'test-model', temperature: 0.2, json: true };
  for (const providerName of ['gemini', 'openrouter', 'ollama', 'lmstudio']) {
    const body = buildRequestBody({ ...base, providerName });
    assert.equal(body.response_format, undefined);
    assert.equal(body.temperature, 0.2);
    assert.equal(buildRequestBody({ ...base, providerName, temperature: undefined }).temperature, undefined);
    assert.deepEqual(buildRequestBody({ ...base, providerName, jsonMode: 'on' }).response_format, { type: 'json_object' });
    assert.equal(buildRequestBody({ ...base, providerName, jsonMode: 'on', json: false }).response_format, undefined);
  }
  assert.equal(buildRequestBody({ ...base, providerName: 'deepseek' }).temperature, 0.2);
  assert.equal(buildRequestBody({ ...base, providerName: 'deepseek', jsonMode: 'off' }).response_format, undefined);
});

test('OpenRouter 固定上游并禁用故障降级;其他接口不带路由字段', () => {
  assert.deepEqual(buildRequestBody({ providerName: 'openrouter', upstream: 'google-vertex', model: 'google/test', messages: [] }).provider, { allow_fallbacks: false, order: ['google-vertex'] });
  assert.deepEqual(buildRequestBody({ providerName: 'openrouter', model: 'test', messages: [] }).provider, { allow_fallbacks: false });
  assert.equal(buildRequestBody({ providerName: 'gemini', model: 'test', messages: [] }).provider, undefined);
});

test('新增供应商通过真实 chat 入口使用正确请求,保留返回文本;失败只请求一次', async () => {
  const snapshot = { ...config };
  const savedFetch = globalThis.fetch;
  try {
    Object.assign(config, { llmModel: '', llmBaseUrl: '', llmApiKey: '', llmJsonMode: '', planTemperature: null, buildTemperature: null, planProviderOptionsRaw: '', buildProviderOptionsRaw: '', environmentId:'atoms-demo',expectedSupabaseProjectRef:'abcdefghijklmnopqrst',envFileExplicit:true,supabaseUrl:'https://abcdefghijklmnopqrst.supabase.co', supabaseServiceRoleKey: 'test', daytonaApiKey: 'test' });
    for (const name of ['openrouter', 'gemini']) {
      const field = PROVIDERS[name].field;
      Object.assign(config, { llmProvider: name, [`${field}ApiKey`]: 'test-key', [`${field}Model`]: 'test-model', [`${field}JsonMode`]: 'off' });
      assert.deepEqual(assertRunnable(), []);
      const calls = [];
      globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        return { ok: true, json: async () => ({ model: 'returned-model', choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }], usage: { prompt_tokens: 4, completion_tokens: 3 } }) };
      };
      assert.equal(await chat([{ role: 'user', content: '返回 JSON' }], { json: true }), '{"ok":true}');
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, resolveProvider(config).url);
      assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
      assert.equal(JSON.parse(calls[0].options.body).model, 'test-model');
      assert.equal(JSON.parse(calls[0].options.body).temperature, 0.2);
      assert.equal(JSON.parse(calls[0].options.body).response_format, undefined);
      calls.length = 0;
      globalThis.fetch = async () => { calls.push(1); return { ok: false, status: 429, text: async () => 'test quota exceeded' }; };
      await assert.rejects(() => chat([]), /429/);
      assert.equal(calls.length, 1);
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: null } }] }) });
      await assert.rejects(() => chat([]), (error) => error.code === 'LLM_INVALID_RESPONSE');
    }
  } finally {
    Object.assign(config, snapshot);
    globalThis.fetch = savedFetch;
  }
});
