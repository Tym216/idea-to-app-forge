import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepareRequest, normalizeResponse, validateResponse } from '../src/llm-provider.js';
import { config } from '../src/config.js';
import { chat, chatResponse } from '../src/llm.js';
import { generateStructured } from '../src/planner.js';

const base = { providerName: 'deepseek', model: 'deepseek-flash', messages: [], temperature: 0.3, json: true };
test('DeepSeek thinking maps generic effort and omits ineffective temperature; off preserves sampling', () => {
  for (const reasoningMode of ['low', 'high']) {
    const { body, capability } = prepareRequest({ ...base, reasoningMode });
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, reasoningMode);
    assert.equal(body.temperature, undefined);
    assert.equal(capability.sentTemperature, null);
    assert.equal(capability.requestedTemperature, 0.3);
    assert.deepEqual(body.response_format, { type: 'json_object' });
  }
  const { body } = prepareRequest({ ...base, interactionMode: 'json_action', reasoningMode: 'off' });
  assert.deepEqual(body.thinking, { type: 'disabled' });
  assert.equal(body.temperature, 0.3);
  assert.equal(body.reasoning_effort, undefined);
});
test('unknown models never receive guessed thinking params; requested thinking fails explicitly', () => {
  const { body, capability } = prepareRequest({ ...base, model: 'custom' });
  assert.equal(body.thinking, undefined);
  assert.equal(capability.effectiveReasoning, 'unconfirmed');
  assert.ok(capability.warnings.length);
  assert.throws(() => prepareRequest({ ...base, model: 'custom', reasoningMode: 'high', reasoningPolicy: 'strict' }), { code: 'LLM_CAPABILITY_UNSUPPORTED' });
  assert.throws(() => prepareRequest({ ...base, interactionMode: 'native_tools' }), { code: 'LLM_CAPABILITY_UNSUPPORTED' });
  assert.throws(() => prepareRequest({ ...base, reasoningMode: 'typo' }), { code: 'LLM_CAPABILITY_UNSUPPORTED' });
});
test('best-effort Plan reasoning downgrades unmapped GLM without guessed parameters; strict rejects', () => {
  const options = { ...base, providerName: 'zhipu', model: 'glm-4.5-air', reasoningMode: 'high' };
  const { body, capability } = prepareRequest(options);
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(body.temperature, 0.3);
  assert.equal(capability.requestedReasoning, 'high');
  assert.equal(capability.negotiatedReasoning, 'off');
  assert.equal(capability.effectiveReasoning, 'unconfirmed');
  assert.match(capability.downgradeReason, /尚无已确认/);
  assert.ok(capability.warnings.some((warning) => warning.includes('降级')));
  assert.throws(() => prepareRequest({ ...options, reasoningPolicy: 'strict' }), { code: 'LLM_CAPABILITY_UNSUPPORTED' });
});

test('Plan passes best-effort or strict reasoning policy to the model client', async () => {
  for (const reasoningPolicy of ['best_effort', 'strict']) {
    let seen;
    await generateStructured({ chat: async (_messages, options) => {
      seen = options;
      return '{"ok":true}';
    }, system: 'JSON', context: 'test', validate: (value) => value, code: 'PLAN_INVALID',
    reasoningMode: 'high', reasoningPolicy });
    assert.equal(seen.reasoningPolicy, reasoningPolicy);
  }
});

test('OpenRouter reasoning is a routed preference, not a claim of confirmed model capability', () => {
  const { body, capability } = prepareRequest({ ...base, providerName: 'openrouter', model: 'vendor/model', reasoningMode: 'high' });
  assert.deepEqual(body.reasoning, { effort: 'high' });
  assert.equal(body.temperature, 0.3);
  assert.equal(capability.effectiveReasoning, 'unconfirmed');
  assert.deepEqual(body.provider, { allow_fallbacks: false });
});
test('local effort mapping requires explicit model capability opt-in; Qwen family alone is insufficient', () => {
  for (const providerName of ['ollama', 'lmstudio']) {
    assert.throws(() => prepareRequest({ ...base, providerName, model: 'qwen', reasoningMode: 'high', reasoningPolicy: 'strict' }), { code: 'LLM_CAPABILITY_UNSUPPORTED' });
    const { body } = prepareRequest({ ...base, providerName, model: 'qwen', reasoningMode: 'high', reasoningProfile: 'reasoning_effort' });
    assert.equal(body.reasoning_effort, 'high');
    assert.equal(body.temperature, 0.3);
  }
});
test('Gemini mandatory-thinking models omit unsupported off preference and warn', () => {
  for (const model of ['gemini-2.5-pro', 'gemini-3-pro-preview']) {
    const { body, capability } = prepareRequest({ ...base, providerName: 'gemini', model });
    assert.equal(body.reasoning_effort, undefined);
    assert.ok(capability.warnings.some((warning) => warning.includes('无法确认支持关闭推理')));
  }
  assert.equal(prepareRequest({ ...base, providerName: 'gemini', model: 'gemini-2.5-flash', reasoningMode: 'high' }).body.reasoning_effort, 'high');
});
test('normalization separates reasoning, text parts and tool calls; missing usage stays null', () => {
  const n = normalizeResponse({ choices: [{ message: { content: [{ type: 'text', text: '{"ok":true}' }, { type: 'reasoning', text: 'private' }], reasoning_content: 'private' }, finish_reason: 'stop' }] });
  assert.equal(n.text, '{"ok":true}');
  assert.equal(n.reasoning, 'private');
  assert.deepEqual(n.toolCalls, []);
  assert.equal(n.usage, null);
  assert.equal(n.finishReason, 'stop');
  assert.equal(normalizeResponse({ choices: [{ message: { reasoning: 'R' } }] }).reasoning, 'R');
  assert.equal(normalizeResponse({ choices: [{ message: { reasoning_details: [{ type: 'reasoning.encrypted', data: 'secret' }] } }] }).reasoning, null);
});
test('native-only response is normalized but rejected by current text modes; reasoning cannot become an action', () => {
  const n = normalizeResponse({ choices: [{ message: { content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] });
  assert.doesNotThrow(() => validateResponse(n, 'native_tools'));
  for (const mode of ['structured_text', 'json_action']) assert.throws(() => validateResponse(n, mode), { code: 'LLM_INTERACTION_MISMATCH' });
  assert.throws(() => validateResponse(normalizeResponse({ choices: [{ message: { reasoning_content: '{"tool":"finish"}' } }] })), { code: 'LLM_INVALID_RESPONSE' });
});
test('chat keeps final-text API, chatResponse exposes separated channels; no reasoning goes into protocol repair history', async () => {
  const saved = { ...config }, oldFetch = globalThis.fetch;
  const requests = [];
  try {
    Object.assign(config, { llmModel: '', llmBaseUrl: '', llmApiKey: '', llmJsonMode: '', planTemperature: null, buildTemperature: null, planProviderOptionsRaw: '', buildProviderOptionsRaw: '', llmProvider: 'deepseek', deepseekApiKey: 'fake', deepseekModel: 'deepseek-flash', llmReasoningProfile: 'auto' });
    globalThis.fetch = async (_url, options) => {
      requests.push(JSON.parse(options.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true}', reasoning_content: 'PRIVATE' }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 20 } }) };
    };
    assert.equal(await chat([], { reasoningMode: 'high' }), '{"ok":true}');
    const response = await chatResponse([], { reasoningMode: 'high' });
    assert.equal(response.reasoning, 'PRIVATE');
    assert.equal(response.usage.inputTokens, 10);
    assert.equal(response.usage.outputTokens, 20);
    assert.equal(response.usage.totalTokens, null);
    assert.equal(requests[0].temperature, undefined);
    let attempts = 0;
    await generateStructured({ chat: async (messages, options) => {
      assert.equal(options.reasoningMode, 'high');
      assert.equal(options.interactionMode, 'structured_text');
      assert.ok(!JSON.stringify(messages).includes('PRIVATE'));
      attempts += 1;
      return attempts === 1 ? 'invalid' : await chat(messages, options);
    }, system: 'JSON', context: 'test', validate: (x) => x, code: 'PLAN_INVALID', reasoningMode: 'high' });
    assert.equal(attempts, 2);
    await chat([], { interactionMode: 'json_action', reasoningMode: 'off' });
    assert.deepEqual(requests.at(-1).thinking, { type: 'disabled' });
    const before = requests.length;
    await assert.rejects(() => chat([], { interactionMode: 'native_tools' }), { code: 'LLM_CAPABILITY_UNSUPPORTED' });
    assert.equal(requests.length, before);
  } finally { Object.assign(config, saved); globalThis.fetch = oldFetch; }
});


test('unsupported optional reasoning profile warns and omits parameter instead of failing', () => {
  const { body, capability } = prepareRequest({ ...base, providerName: 'zhipu', model: 'glm-4.5-air',
    reasoningMode: 'high', reasoningProfile: 'reasoning_effort' });
  assert.equal(body.reasoning_effort, undefined);
  assert.equal(body.thinking, undefined);
  assert.equal(capability.negotiatedReasoning, 'off');
  assert.ok(capability.warnings.some((warning) => warning.includes('已忽略此可选偏好')));
  // Explicit strict policy still means the caller requires that capability.
  assert.throws(() => prepareRequest({ ...base, providerName: 'zhipu', model: 'glm-4.5-air',
    reasoningMode: 'high', reasoningProfile: 'reasoning_effort', reasoningPolicy: 'strict' }),
  { code: 'LLM_CAPABILITY_UNSUPPORTED' });
});
