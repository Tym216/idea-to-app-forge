import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOutputTokenCap, parseRequireOutputCap, resolveOutputCap, outputCapProblems, MAX_OUTPUT_TOKEN_CAP } from '../src/llm-output-cap.js';
import { prepareRequest, providerProblems, buildConfiguredRequestBody } from '../src/llm-provider.js';
import { config } from '../src/config.js';
import { chat } from '../src/llm.js';
import { extractMemories } from '../src/memory.js';
import { logger } from '../src/logger.js';
import { withExecutionControl } from '../src/execution-control.js';
import { MAX_PROVIDER_ATTEMPTS } from '../src/provider-retry.js';
import { createTaskMetrics, withTaskMetrics } from '../src/task-metrics.js';

const defaults = {
  llmMaxOutputTokens: '', llmMaxOutputTokensPlan: '', llmMaxOutputTokensMemory: '', llmRequireOutputCap: '',
};
const request = (extra = {}) => prepareRequest({
  providerName: 'openrouter', model: 'offline-model', messages: [], temperature: 0.2,
  json: true, jsonMode: 'off', nativeOptions: {}, ...extra,
});

test('trusted output config accepts positive integers and rejects malformed values without coercion or secret echo', () => {
  for (const value of [1, '512', MAX_OUTPUT_TOKEN_CAP]) assert.equal(parseOutputTokenCap(value), Number(value));
  for (const value of [0, '0', -1, '-1', 1.5, '1.5', NaN, Infinity, true, {}, 'NaN', 'SECRET', '4e3', '0x10', ' 12 ', MAX_OUTPUT_TOKEN_CAP + 1]) {
    assert.throws(() => parseOutputTokenCap(value, 'LLM_MAX_OUTPUT_TOKENS'), (e) => e.code === 'LLM_OUTPUT_CAP_CONFIG' && !e.message.includes('SECRET'));
  }
  for (const value of [undefined, null, '']) assert.equal(parseOutputTokenCap(value), null);
  for (const value of [true, 'true']) assert.equal(parseRequireOutputCap(value), true);
  for (const value of [false, 'false', '', undefined]) assert.equal(parseRequireOutputCap(value), false);
  for (const value of ['yes', 'TRUE', 1]) assert.throws(() => parseRequireOutputCap(value), { code: 'LLM_OUTPUT_CAP_CONFIG' });
});

test('Plan and memory overrides win; design/action/build/unknown purposes use the default', () => {
  const settings = { llmMaxOutputTokens: '8192', llmMaxOutputTokensPlan: '4096', llmMaxOutputTokensMemory: '1024', llmRequireOutputCap: 'true' };
  assert.equal(resolveOutputCap(settings, 'plan').maxOutputTokens, 4096);
  assert.equal(resolveOutputCap(settings, 'Plan').maxOutputTokens, 4096);
  assert.equal(resolveOutputCap(settings, 'memory_extraction').maxOutputTokens, 1024);
  for (const purpose of ['design', 'action_plan', 'build_decision', 'unspecified', 'future_purpose'])
    assert.equal(resolveOutputCap(settings, purpose).maxOutputTokens, 8192);
  assert.equal(resolveOutputCap(settings, 'plan').outputCapSource, 'LLM_MAX_OUTPUT_TOKENS_PLAN');
  assert.equal(resolveOutputCap({ llmMaxOutputTokens: 2048 }, 'plan').maxOutputTokens, 2048);
  assert.deepEqual(resolveOutputCap({}, 'plan'), { maxOutputTokens: null, requireOutputCap: false, outputCapSource: null });
});

test('all configured cap fields are validated even if an override would mask a malformed default', () => {
  const settings = { llmMaxOutputTokens: 'bad', llmMaxOutputTokensPlan: 4096 };
  assert.throws(() => resolveOutputCap(settings, 'plan'), { code: 'LLM_OUTPUT_CAP_CONFIG' });
  for (const field of Object.keys(defaults).filter(x => x !== 'llmRequireOutputCap'))
    assert.ok(outputCapProblems({ [field]: '0' }).length);
  assert.ok(outputCapProblems({ llmRequireOutputCap: 'wrong' }).length);
  assert.ok(providerProblems({ llmProvider: 'openrouter', openrouterModel: 'offline', openrouterApiKey: 'fake', llmMaxOutputTokens: 0 }).some(x => x.includes('LLM_MAX_OUTPUT_TOKENS')));
});

test('actual explicit env loading preserves raw caps and rejects invalid config in the shared startup validator', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-cap-env-'));
  const file = join(dir, 'offline.env');
  writeFileSync(file, [
    'FORGE_ENVIRONMENT_ID=atoms-demo', 'EXPECTED_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst',
    'SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY=sb_secret_offline',
    'LLM_PROVIDER=openrouter', 'LLM_MODEL=offline', 'OPENROUTER_API_KEY=fake', 'DAYTONA_API_KEY=fake',
    'LLM_MAX_OUTPUT_TOKENS=8192', 'LLM_MAX_OUTPUT_TOKENS_PLAN=4096',
    'LLM_MAX_OUTPUT_TOKENS_MEMORY=1024', 'LLM_REQUIRE_OUTPUT_CAP=true',
  ].join('\n'));
  const code = "const {config,assertRunnable}=await import('./src/config.js');const {resolveOutputCap}=await import('./src/llm-output-cap.js');console.log(JSON.stringify({plan:resolveOutputCap(config,'plan'),memory:resolveOutputCap(config,'memory_extraction'),problems:assertRunnable()}));";
  try {
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS || '', FORGE_NO_MAIN: '1', FORGE_ENV_FILE: file, LANGFUSE_ENABLED: 'false' };
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    const parsed = JSON.parse(child.stdout); assert.equal(parsed.plan.maxOutputTokens, 4096); assert.equal(parsed.memory.maxOutputTokens, 1024); assert.deepEqual(parsed.problems, []);
    writeFileSync(file, readFileSync(file, 'utf8').replace('LLM_MAX_OUTPUT_TOKENS=8192', 'LLM_MAX_OUTPUT_TOKENS=0'));
    const invalid = spawnSync(process.execPath, ['--input-type=module', '-e', "const {assertRunnable}=await import('./src/config.js');console.log(JSON.stringify(assertRunnable()));"], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
    assert.equal(invalid.status, 0); assert.match(invalid.stdout, /LLM_MAX_OUTPUT_TOKENS/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('OpenRouter maps the trusted cap to one exact integer max_tokens field', () => {
  const { body, capability } = request({ maxOutputTokens: '2048', requireOutputCap: true });
  assert.equal(body.max_tokens, 2048); assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
  assert.equal(capability.outputCapField, 'max_tokens'); assert.equal(capability.effectiveMaxOutputTokens, 2048);
});

test('native options cannot increase, remove, null or conflict with the final trusted cap', () => {
  for (const nativeOptions of [
    { max_tokens: 99999 }, { max_completion_tokens: 99999 }, { max_tokens: null },
    { max_tokens: null, max_completion_tokens: 99999 }, { max_tokens: 0 },
    { provider: { max_tokens: 99999, allow_fallbacks: true, require_parameters: false } },
    { reasoning: { effort: 'high', max_tokens: 99999 }, max_tokens: 99999 },
  ]) {
    const { body } = request({ maxOutputTokens: 1024, requireOutputCap: true, nativeOptions });
    assert.equal(body.max_tokens, 1024); assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
    assert.deepEqual(body.provider, { allow_fallbacks: false, require_parameters: true });
  }
  for (const nativeOptions of ['{broken', [], 'null'])
    assert.throws(() => request({ maxOutputTokens: 1024, requireOutputCap: true, nativeOptions }));
});

test('backward compatibility leaves legacy bodies unchanged when caps are unset', () => {
  assert.deepEqual(request().body, { model: 'offline-model', messages: [], temperature: 0.2, provider: { allow_fallbacks: false } });
  for (const providerName of ['deepseek', 'zhipu', 'gemini', 'ollama', 'lmstudio']) {
    const { body } = request({ providerName });
    assert.equal(Object.hasOwn(body, 'max_tokens'), false); assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
    assert.equal(body.temperature, 0.2);
  }
  assert.throws(() => request({ providerName: 'zhipu', maxOutputTokens: 1024 }), { code: 'LLM_OUTPUT_CAP_UNSUPPORTED' });
});

test('reasoning behavior remains untouched; sending a cap makes no generic billing-bound claim', () => {
  const thinking = request({ maxOutputTokens: 4096, nativeOptions: { thinking: { type: 'enabled' } } });
  assert.equal(thinking.body.thinking, undefined); assert.equal(thinking.body.reasoning, undefined);
  const before = request({ nativeOptions: { reasoning: { effort: 'high' } } });
  const after = request({ maxOutputTokens: 4096, nativeOptions: { reasoning: { effort: 'high' } } });
  assert.deepEqual(after.body.reasoning, before.body.reasoning);
  assert.equal(after.capability.reasoningBillingBounded, undefined);
});

async function mockRuntime(fn, settings = {}) {
  const previous = { ...config }, oldFetch = globalThis.fetch, oldLogger = { ...logger };
  const logs = [];
  Object.assign(config, defaults, { llmProvider: 'openrouter', llmModel: 'offline-model', llmApiKey: 'fake',
    llmBaseUrl: 'https://offline.invalid/v1', llmJsonMode: 'off', llmTimeoutMs: 120000,
    planProviderOptionsRaw: '{}', buildProviderOptionsRaw: '{}', planTemperature: 0.2 }, settings);
  for (const level of ['info', 'warn', 'error']) logger[level] = (message, meta) => logs.push({ message, ...meta });
  try { await fn({ logs }); }
  finally { Object.assign(config, previous); globalThis.fetch = oldFetch; Object.assign(logger, oldLogger); }
}
const response = (text = '{}') => new Response(JSON.stringify({ choices: [{ message: { content: text }, finish_reason: 'stop' }] }));

test('require-cap errors precede every inference HTTP request and lease probe, including missing memory cap', async () => mockRuntime(async () => {
  let fetches = 0, leases = 0;
  globalThis.fetch = async () => { fetches++; return response(); };
  for (const purpose of ['memory_extraction', 'build_decision', 'design', 'unspecified']) {
    await assert.rejects(withExecutionControl({ signal: new AbortController().signal, checkLease: async () => { leases++; } },
      () => chat([], { purpose })), { code: 'LLM_OUTPUT_CAP_REQUIRED' });
  }
  assert.equal(fetches, 0); assert.equal(leases, 0);
}, { llmRequireOutputCap: true, llmMaxOutputTokensPlan: 4096 }));

test('invalid caps/native options fail locally; raw config is never silently replaced by a fallback', async () => mockRuntime(async () => {
  let fetches = 0; globalThis.fetch = async () => { fetches++; return response(); };
  config.llmMaxOutputTokens = 'bad';
  await assert.rejects(chat([], { purpose: 'plan' }), { code: 'LLM_OUTPUT_CAP_CONFIG' });
  config.llmMaxOutputTokens = 1024; config.planProviderOptionsRaw = '{broken';
  await assert.rejects(chat([], { purpose: 'plan' }), /JSON/);
  assert.equal(fetches, 0);
}));

test('common boundary sends Plan override and retains cap-source/physical-budget diagnostics', async () => mockRuntime(async ({ logs }) => {
  let body; globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return response(); };
  await chat([], { purpose: 'plan' });
  assert.equal(body.max_tokens, 4096);
  const meta = logs.find(x => x.message === 'model.request_started');
  assert.equal(meta.effective_max_output_tokens, 4096); assert.equal(meta.output_cap_field, 'max_tokens');
  assert.equal(meta.output_cap_source, 'LLM_MAX_OUTPUT_TOKENS_PLAN'); assert.equal(meta.output_cap_required, true);
  assert.equal(meta.max_physical_attempts, MAX_PROVIDER_ATTEMPTS);
}, { llmMaxOutputTokens: 8192, llmMaxOutputTokensPlan: 4096, llmRequireOutputCap: true }));

test('normal extractMemories uses its independent cap without bypassing the common client', async () => mockRuntime(async () => {
  let body, writes = 0;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return response('{"upsert":[{"scope":"project","key":"offline","value":"test"}],"remove":[]}'); };
  await extractMemories({ userId: 'u', projectId: 'p', userPrompt: 'offline', summary: 'offline', taskId: 't' },
    { chat, upsertMemory: async () => { writes++; }, suggestMemory: async () => {}, deleteMemory: async () => {} });
  assert.equal(body.max_tokens, 1024); assert.equal(body.temperature, 0); assert.equal(writes, 1);
}, { llmMaxOutputTokensPlan: 4096, llmMaxOutputTokensMemory: 1024, llmRequireOutputCap: true }));

test('uncapped memory cannot fetch or write; existing auxiliary-warning semantics remain unchanged', async () => mockRuntime(async ({ logs }) => {
  let fetches = 0, writes = 0;
  globalThis.fetch = async () => { fetches++; return response(); };
  await extractMemories({ userId: 'u', projectId: 'p', userPrompt: 'offline', summary: 'offline', taskId: 't' },
    { chat, upsertMemory: async () => { writes++; }, suggestMemory: async () => { writes++; }, deleteMemory: async () => { writes++; } });
  assert.equal(fetches, 0); assert.equal(writes, 0);
  assert.ok(logs.some(x => x.message === 'memory.extract.failed' && x.auxiliary === true && x.error.includes('LLM_OUTPUT_CAP_REQUIRED')));
}, { llmMaxOutputTokensPlan: 4096, llmRequireOutputCap: true }));

test('frozen logical payload preserves cap across physical retry even if config changes mid-attempt', async () => mockRuntime(async ({ logs }) => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) {
      config.llmMaxOutputTokensPlan = 99999; config.planProviderOptionsRaw = '{"max_tokens":99999}';
      return new Response('overload', { status: 503 });
    }
    return response();
  };
  const metrics = createTaskMetrics({ id: 'offline' });
  await withTaskMetrics(metrics, () => chat([], { purpose: 'plan' }));
  assert.equal(bodies.length, MAX_PROVIDER_ATTEMPTS); assert.equal(bodies[0], bodies[1]);
  assert.equal(JSON.parse(bodies[1]).max_tokens, 2048);
  assert.equal(metrics.logical_model_turn_count, 1); assert.equal(metrics.model_request_count, 2);
  for (const row of logs.filter(x => x.message === 'model.request')) assert.equal(row.effective_max_output_tokens, 2048);
}, { llmMaxOutputTokensPlan: 2048, llmRequireOutputCap: true }));

test('persistent transient failure remains bounded to exported two-attempt maximum with identical caps', async () => mockRuntime(async () => {
  const caps = [];
  globalThis.fetch = async (_url, init) => { caps.push(JSON.parse(init.body).max_tokens); return new Response('overload', { status: 503 }); };
  await assert.rejects(chat([], { purpose: 'memory_extraction' }), { code: 'LLM_HTTP' });
  assert.equal(MAX_PROVIDER_ATTEMPTS, 2); assert.deepEqual(caps, [1024, 1024]);
}, { llmMaxOutputTokensMemory: 1024, llmRequireOutputCap: true }));

test('call-site options cannot override the trusted config cap or disable the requirement', async () => mockRuntime(async () => {
  let body; globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return response(); };
  await chat([], { purpose: 'plan', maxOutputTokens: 99999, requireOutputCap: false });
  assert.equal(body.max_tokens, 4096);
}, { llmMaxOutputTokensPlan: 4096, llmRequireOutputCap: true }));

test('pause permission still takes precedence over a missing cap; no inference can escape', async () => mockRuntime(async () => {
  const controller = new AbortController();
  const paused = Object.assign(new Error('paused'), { code: 'TASK_PAUSED' });
  controller.abort(paused); let calls = 0;
  globalThis.fetch = async () => { calls++; return response(); };
  await assert.rejects(withExecutionControl({ signal: controller.signal }, () => chat([], { purpose: 'plan' })), e => e === paused);
  assert.equal(calls, 0);
}, { llmRequireOutputCap: true }));

test('legacy doctor inference also uses the trusted default cap and rejects missing required cap before HTTP', () => {
  const options = { providerName: 'openrouter', model: 'offline', messages: [], temperature: 0, maxOutputTokens: 99999, requireOutputCap: false };
  assert.equal(buildConfiguredRequestBody({ llmMaxOutputTokens: 512 }, 'doctor_probe', options).max_tokens, 512);
  assert.throws(() => buildConfiguredRequestBody({ llmRequireOutputCap: true, llmMaxOutputTokensPlan: 4096 }, 'doctor_probe', options), { code: 'LLM_OUTPUT_CAP_REQUIRED' });
  const source = readFileSync(new URL('../src/doctor.js', import.meta.url), 'utf8');
  assert.match(source, /body: JSON.stringify\(buildConfiguredRequestBody\(config, 'doctor_probe'/);
  assert.doesNotMatch(source, /body: JSON.stringify\(buildRequestBody\(/);
});
