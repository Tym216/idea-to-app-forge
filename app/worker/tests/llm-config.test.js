import { test } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { chat } from '../src/llm.js';
import { resolveProvider, providerProblems, prepareRequest, parseProviderOptions } from '../src/llm-provider.js';
import { describeLlm, inspectModelList } from '../src/doctor-llm.js';
import { runSmoke } from '../src/smoke-llm.js';

test('generic model/baseURL/key/JSON override legacy; legacy fields still work when generic unset', () => {
  const settings = { llmProvider: 'zhipu', zhipuModel: 'legacy', zhipuBaseUrl: 'https://legacy.test/v4', zhipuApiKey: 'old', zhipuJsonMode: 'off' };
  assert.equal(resolveProvider(settings).model, 'legacy');
  const selected = resolveProvider({ ...settings, llmModel: 'generic', llmBaseUrl: 'https://new.test/v1/', llmApiKey: 'new', llmJsonMode: 'on' });
  assert.equal(selected.model, 'generic');
  assert.equal(selected.url, 'https://new.test/v1/chat/completions');
  assert.equal(selected.key, 'new');
  assert.equal(selected.jsonMode, 'on');
  assert.deepEqual(providerProblems({ ...settings, llmBaseUrl: 'https://user:secret@bad.test/' }).some((x) => x.includes('LLM_BASE_URL')), true);
});

test('malformed options and required numeric settings fail before tasks; unknown optional mapping warns without leaking value', () => {
  const base = { llmProvider: 'zhipu', zhipuApiKey: 'fake', zhipuModel: 'glm-4.5-air' };
  assert.ok(providerProblems({ ...base, planProviderOptionsRaw: '{' }).some((x) => x.includes('PLAN_PROVIDER_OPTIONS')));
  assert.ok(providerProblems({ ...base, buildProviderOptionsRaw: '[]' }).some((x) => x.includes('BUILD_PROVIDER_OPTIONS')));
  assert.ok(providerProblems({ ...base, llmTimeoutMs: -1, planTemperature: -0.1 }).some((x) => x.includes('LLM_TIMEOUT_MS')));
  assert.ok(providerProblems({ ...base, llmTimeoutMs: -1, planTemperature: -0.1 }).some((x) => x.includes('PLAN_TEMPERATURE')));
  assert.deepEqual(parseProviderOptions('{}'), {});
  const { body, capability } = prepareRequest({ providerName: 'zhipu', model: 'glm-4.5-air', messages: [], json: true, jsonMode: 'on',
    nativeOptions: { thinking: { type: 'enabled' }, secret: 'top-secret' } });
  assert.equal(body.thinking, undefined);
  assert.equal(body.response_format, undefined);
  assert.equal(capability.effectiveJsonMode, 'off');
  assert.ok(capability.warnings.some((w) => w.includes('JSON mode')));
  assert.doesNotMatch(JSON.stringify(capability), /top-secret/);
});

test('native provider options use confirmed mappings; DeepSeek thinking omits ineffective temperature', () => {
  const deepseek = prepareRequest({ providerName: 'deepseek', model: 'deepseek-flash', messages: [], temperature: 0.2,
    nativeOptions: { thinking: { type: 'enabled' }, reasoning_effort: 'high' } });
  assert.deepEqual(deepseek.body.thinking, { type: 'enabled' });
  assert.equal(deepseek.body.reasoning_effort, 'high');
  assert.equal(deepseek.body.temperature, undefined);
  const local = prepareRequest({ providerName: 'lmstudio', model: 'unknown-model', messages: [],
    nativeOptions: { reasoning_effort: 'high' } });
  assert.equal(local.body.reasoning_effort, undefined);
  assert.ok(local.capability.warnings.length);
});

test('Plan and Build stage overrides select temperature and native options without provider logic in Agent', async () => {
  const prior = { ...config }, oldFetch = globalThis.fetch;
  try {
    Object.assign(config, { llmProvider: 'deepseek', deepseekApiKey: 'fake', deepseekModel: 'deepseek-flash',
      llmModel: '', llmBaseUrl: '', llmApiKey: '', llmJsonMode: '', planTemperature: 0.4, buildTemperature: 0.1,
      planProviderOptionsRaw: '{"thinking":{"type":"enabled"}}', buildProviderOptionsRaw: '{"thinking":{"type":"disabled"}}' });
    const bodies = [];
    globalThis.fetch = async (_url, options) => {
      bodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: '{"ok":true}' }, finish_reason: 'stop' }] }));
    };
    await chat([], { purpose: 'plan', temperature: 0.9 });
    await chat([], { purpose: 'build_decision', temperature: 0.9 });
    await chat([], { purpose: 'memory_extraction', temperature: 0 });
    assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
    assert.equal(bodies[0].temperature, undefined);
    assert.deepEqual(bodies[1].thinking, { type: 'disabled' });
    assert.equal(bodies[1].temperature, 0.1);
    assert.equal(bodies[2].temperature, 0);
  } finally { Object.assign(config, prior); globalThis.fetch = oldFetch; }
});

test('doctor reports requested/effective values and model-list limits without making a chat request', async () => {
  const settings = { llmProvider: 'zhipu', zhipuApiKey: 'fake', zhipuModel: 'glm-4.5-air', llmJsonMode: 'on',
    planTemperature: 0.2, planProviderOptionsRaw: '{"thinking":{"type":"enabled"}}' };
  const report = describeLlm(settings);
  assert.deepEqual(report.problems, []);
  assert.equal(report.stages.plan.effectiveJsonMode, 'off');
  assert.equal(report.stages.plan.reasoningStatus, 'unsupported');
  let seen;
  const found = await inspectModelList(report.selected, async (url) => {
    seen = url;
    return new Response(JSON.stringify({ data: [{ id: 'glm-4.5-air' }] }));
  });
  assert.equal(seen, 'https://open.bigmodel.cn/api/paas/v4/models');
  assert.equal(found.status, 'valid');
  assert.equal((await inspectModelList(report.selected, async () => new Response('', { status: 404 }))).status, 'unknown');
  assert.equal((await inspectModelList(report.selected, async () => new Response('', { status: 401 }))).status, 'auth_error');
  assert.equal((await inspectModelList(report.selected, async () => { throw new Error('offline'); })).status, 'network_error');
  assert.equal((await inspectModelList(report.selected, async () => new Response(JSON.stringify({ data: [{ id: 'other' }] })))).status, 'not_listed');
});

test('smoke:llm requires a real JSON action; this offline test injects a fake client', async () => {
  const prior = { ...config };
  try {
    Object.assign(config, { llmProvider: 'zhipu', zhipuApiKey: 'fake', zhipuModel: 'glm-4.5-air' });
    await runSmoke(async (_messages, options) => {
      assert.equal(options.interactionMode, 'json_action');
      return '{"tool":"finish","args":{"summary":"ok"}}';
    });
    await assert.rejects(runSmoke(async () => '{"tool":"read_file","args":{}}'), /JSON action/);
  } finally { Object.assign(config, prior); }
});
