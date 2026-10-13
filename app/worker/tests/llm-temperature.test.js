import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseOmitTemperature, resolveTemperatureOmission } from '../src/llm-temperature.js';
import { prepareRequest, buildConfiguredRequestBody, providerProblems } from '../src/llm-provider.js';
import { requestDiagnostics } from '../src/llm-diagnostics.js';
import { describeLlm } from '../src/doctor-llm.js';
import { config } from '../src/config.js';
import { chat } from '../src/llm.js';
import { extractMemories } from '../src/memory.js';
import { logger } from '../src/logger.js';
import { withExecutionControl } from '../src/execution-control.js';
import { MAX_PROVIDER_ATTEMPTS } from '../src/provider-retry.js';

const messages = [{ role: 'user', content: 'offline fixture' }];
const options = { providerName: 'openrouter', model: 'anthropic/claude-haiku-5.5',
  messages, temperature: 0.2, json: true, jsonMode: 'off', nativeOptions: {} };
const settings = { llmMaxOutputTokens: '', llmMaxOutputTokensPlan: 4096,
  llmMaxOutputTokensMemory: 1024, llmRequireOutputCap: true, llmOmitTemperature: true };

function capped(body, cap) {
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.equal(Object.hasOwn(JSON.parse(JSON.stringify(body)), 'temperature'), false);
  assert.equal(body.max_tokens, cap);
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
  assert.deepEqual(body.provider, { allow_fallbacks: false, require_parameters: true });
}

test('trusted omission boolean is strict, default false, and never echoes arbitrary malformed values', () => {
  for (const value of [undefined, null, '', false, 'false']) assert.equal(parseOmitTemperature(value), false);
  for (const value of [true, 'true']) assert.equal(parseOmitTemperature(value), true);
  for (const value of [1, 0, '1', 'TRUE', 'yes', ' true ', [], {}, 'SECRET'])
    assert.throws(() => parseOmitTemperature(value), e => e.code === 'LLM_TEMPERATURE_CONFIG' && !e.message.includes('SECRET'));
  assert.deepEqual(resolveTemperatureOmission({}), { omitTemperature: false });
  assert.ok(providerProblems({ llmProvider: 'openrouter', llmModel: 'offline',
    llmApiKey: 'fake', llmOmitTemperature: 'yes' }).some(x => x.includes('LLM_OMIT_TEMPERATURE')));
});

test('real explicit env loading retains raw omission and startup validator rejects malformed boolean', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-temperature-env-'));
  const file = join(dir, 'offline.env');
  const base = ['FORGE_ENVIRONMENT_ID=atoms-demo', 'EXPECTED_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst',
    'SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY=sb_secret_offline',
    'LLM_PROVIDER=openrouter', 'LLM_MODEL=offline', 'OPENROUTER_API_KEY=fake', 'DAYTONA_API_KEY=fake'];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS || '',
    FORGE_NO_MAIN: '1', FORGE_ENV_FILE: file, LANGFUSE_ENABLED: 'false' };
  const code = "const {config,assertRunnable}=await import('./src/config.js'); const {resolveTemperatureOmission}=await import('./src/llm-temperature.js'); console.log(JSON.stringify({raw:config.llmOmitTemperature,policy:resolveTemperatureOmission(config),problems:assertRunnable()}));";
  try {
    for (const [raw, effective] of [['', false], ['false', false], ['true', true]]) {
      writeFileSync(file, [...base, 'LLM_OMIT_TEMPERATURE=' + raw].join('\n'));
      const child = spawnSync(process.execPath, ['--input-type=module', '-e', code],
        { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
      assert.equal(child.status, 0, child.stderr);
      assert.deepEqual(JSON.parse(child.stdout), { raw, policy: { omitTemperature: effective }, problems: [] });
    }
    writeFileSync(file, [...base, 'LLM_OMIT_TEMPERATURE=TRUE'].join('\n'));
    const child = spawnSync(process.execPath, ['--input-type=module', '-e',
      "const {assertRunnable}=await import('./src/config.js'); console.log(JSON.stringify(assertRunnable()));"],
      { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.match(child.stdout, /LLM_OMIT_TEMPERATURE/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('omit unset/false preserves identical legacy bodies and caps for every existing adapter', () => {
  for (const providerName of ['openrouter', 'deepseek', 'zhipu', 'gemini', 'ollama', 'lmstudio']) {
    const input = { ...options, providerName };
    const legacy = { model: options.model, messages, temperature: 0.2,
      ...(providerName === 'openrouter' ? { provider: { allow_fallbacks: false } } : {}) };
    for (const llmOmitTemperature of [undefined, '', false, 'false'])
      assert.deepEqual(buildConfiguredRequestBody({ llmOmitTemperature }, 'plan', input), legacy);
  }
  const cappedLegacy = prepareRequest({ ...options, maxOutputTokens: 4096 }).body;
  assert.deepEqual(buildConfiguredRequestBody({ ...settings, llmOmitTemperature: false }, 'plan', options), cappedLegacy);
});

test('trusted final omission composes with every adapter without a model-specific exception', () => {
  for (const providerName of ['openrouter', 'deepseek', 'zhipu', 'gemini', 'ollama', 'lmstudio']) {
    const body = buildConfiguredRequestBody({ llmOmitTemperature: true }, 'plan', { ...options, providerName });
    assert.equal(Object.hasOwn(body, 'temperature'), false);
  }
});

test('offline future Haiku Plan and memory payloads retain exact caps and unauthorized purposes fail closed', () => {
  capped(buildConfiguredRequestBody(settings, 'plan', options), 4096);
  capped(buildConfiguredRequestBody(settings, 'memory_extraction', { ...options, temperature: 0 }), 1024);
  for (const purpose of ['doctor_probe', 'design', 'build_decision', 'unspecified'])
    assert.throws(() => buildConfiguredRequestBody(settings, purpose, options), { code: 'LLM_OUTPUT_CAP_REQUIRED' });
});

test('supported native option paths cannot reintroduce temperature or replace trusted cap/routing', () => {
  const nativeOptions = [
    { temperature: 1 }, { temperature: null }, { temperature: 0, omitTemperature: false },
    { temperature: 1, max_tokens: 99999, max_completion_tokens: 99999 },
    { provider: { temperature: 1, require_parameters: false, allow_fallbacks: true } },
    { reasoning: { effort: 'high' }, temperature: 1, max_tokens: null },
  ];
  for (const native of nativeOptions) {
    for (const encoded of [native, JSON.stringify(native)])
      capped(buildConfiguredRequestBody(settings, 'plan',
        { ...options, temperature: 1, omitTemperature: false, maxOutputTokens: 99999,
          requireOutputCap: false, nativeOptions: encoded }), 4096);
  }
});

test('existing capability omission wins when trusted flag is false, with source provider_capability or both', () => {
  for (const nativeOptions of [null, { thinking: { type: 'enabled' } }]) {
    for (const omitTemperature of [false, true]) {
      const result = prepareRequest({ ...options, providerName: 'deepseek', model: 'deepseek-flash',
        reasoningMode: 'high', nativeOptions, omitTemperature });
      assert.equal(Object.hasOwn(result.body, 'temperature'), false);
      assert.equal(result.body.thinking.type, 'enabled');
      assert.equal(result.capability.temperatureOmitted, true);
      assert.equal(result.capability.temperatureOmitSource, omitTemperature ? 'both' : 'provider_capability');
      const diag = requestDiagnostics({ requestId: 'offline', logicalCallId: 'offline', attempt: 1,
        provider: 'deepseek', model: 'deepseek-flash', purpose: 'plan', timeoutMs: 120000,
        messagesCount: 1, contextChars: { user: 15 }, requestBody: JSON.stringify(result.body),
        capability: result.capability, body: result.body }).snapshot();
      assert.equal(diag.requested_temperature, 0.2); assert.equal(diag.effective_temperature, null);
      assert.equal(diag.temperature_omitted, true);
      assert.equal(diag.temperature_omit_source, omitTemperature ? 'both' : 'provider_capability');
    }
  }
  const legacy = prepareRequest(options).capability;
  assert.equal(legacy.temperatureOmitted, false); assert.equal(legacy.temperatureOmitSource, null);
});

async function mockRuntime(fn, extra = {}) {
  const previous = { ...config }, oldFetch = globalThis.fetch, oldLogger = { ...logger }, logs = [];
  Object.assign(config, settings, { llmProvider: 'openrouter', llmModel: options.model,
    llmApiKey: 'fake', llmBaseUrl: 'https://offline.invalid/v1', llmJsonMode: 'off',
    llmTimeoutMs: 120000, planTemperature: 0.2, buildTemperature: 0.1,
    planProviderOptionsRaw: '{}', buildProviderOptionsRaw: '{}' }, extra);
  for (const level of ['info', 'warn', 'error']) logger[level] = (message, meta) => logs.push({ message, ...meta });
  try { await fn({ logs }); }
  finally { Object.assign(config, previous); globalThis.fetch = oldFetch; Object.assign(logger, oldLogger); }
}
const response = (content = '{}') => new Response(JSON.stringify({
  choices: [{ message: { content }, finish_reason: 'stop' }],
}));

test('real common Plan boundary ignores caller omission override and records requested/effective diagnostics', async () => mockRuntime(async ({ logs }) => {
  let body;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return response(); };
  await chat(messages, { purpose: 'plan', temperature: 1, omitTemperature: false, maxOutputTokens: 99999 });
  capped(body, 4096);
  const meta = logs.find(x => x.message === 'model.request_started');
  assert.equal(meta.requested_temperature, 0.2); assert.equal(meta.effective_temperature, null);
  assert.equal(meta.temperature_omitted, true); assert.equal(meta.temperature_omit_source, 'trusted_config');
  assert.equal(meta.effective_max_output_tokens, 4096);
}, { planProviderOptionsRaw: '{"temperature":1,"max_tokens":99999,"provider":{"require_parameters":false}}' }));

test('real extractMemories -> chat path omits requested zero temperature, keeps cap, and performs normal extraction', async () => mockRuntime(async ({ logs }) => {
  let body, writes = 0;
  globalThis.fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return response('{"upsert":[{"scope":"project","key":"offline","value":"test"}],"remove":[]}');
  };
  await extractMemories({ userId: 'u', projectId: 'p', userPrompt: 'offline', summary: 'offline', taskId: 't' },
    { chat, upsertMemory: async () => { writes++; }, suggestMemory: async () => {}, deleteMemory: async () => {} });
  capped(body, 1024); assert.equal(writes, 1);
  const meta = logs.find(x => x.message === 'model.request_started');
  assert.equal(meta.purpose, 'memory_extraction'); assert.equal(meta.requested_temperature, 0);
  assert.equal(meta.effective_temperature, null); assert.equal(meta.temperature_omit_source, 'trusted_config');
}));

test('malformed omission and unauthorized purpose stop before provider fetch and lease probe', async () => mockRuntime(async () => {
  let fetches = 0, leases = 0;
  globalThis.fetch = async () => { fetches++; return response(); };
  const control = { signal: new AbortController().signal, checkLease: async () => { leases++; } };
  config.llmOmitTemperature = 'yes';
  await assert.rejects(withExecutionControl(control, () => chat(messages, { purpose: 'plan' })), { code: 'LLM_TEMPERATURE_CONFIG' });
  config.llmOmitTemperature = true;
  await assert.rejects(withExecutionControl(control, () => chat(messages, { purpose: 'build_decision' })), { code: 'LLM_OUTPUT_CAP_REQUIRED' });
  assert.equal(fetches, 0); assert.equal(leases, 0);
}));

test('two physical retries preserve identical serialized omission and caps despite trusted config changing', async () => mockRuntime(async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) {
      config.llmOmitTemperature = false; config.planTemperature = 1; config.llmMaxOutputTokensPlan = 99999;
      config.planProviderOptionsRaw = '{"temperature":1,"max_tokens":99999}';
      return new Response('overload', { status: 503 });
    }
    return response();
  };
  await chat(messages, { purpose: 'plan' });
  assert.equal(bodies.length, MAX_PROVIDER_ATTEMPTS); assert.equal(MAX_PROVIDER_ATTEMPTS, 2);
  assert.equal(bodies[0], bodies[1]);
  for (const body of bodies) capped(JSON.parse(body), 4096);
}));

test('doctor direct inference obeys trusted omission, but required missing default cap still fails before HTTP', () => {
  const input = { ...options, temperature: 0, omitTemperature: false, maxOutputTokens: 99999 };
  capped(buildConfiguredRequestBody({ ...settings, llmMaxOutputTokens: 512 }, 'doctor_probe', input), 512);
  assert.throws(() => buildConfiguredRequestBody(settings, 'doctor_probe', input), { code: 'LLM_OUTPUT_CAP_REQUIRED' });
  const source = readFileSync(new URL('../src/doctor.js', import.meta.url), 'utf8');
  assert.match(source, /body: JSON.stringify\(buildConfiguredRequestBody\(config, 'doctor_probe'/);
});

test('read-only doctor projection reflects trusted omission without falsely claiming unsupported capability', () => {
  const input = { llmProvider: 'openrouter', llmModel: options.model, llmApiKey: 'fake',
    planTemperature: 0.2, buildTemperature: 0.1, planProviderOptionsRaw: '{}', buildProviderOptionsRaw: '{}' };
  const report = describeLlm({ ...input, ...settings });
  assert.deepEqual(report.problems, []);
  for (const stage of Object.values(report.stages)) {
    assert.equal(stage.sentTemperature, null);
    assert.equal(stage.temperatureOmitted, true);
    assert.equal(stage.temperatureOmitSource, 'trusted_config');
    assert.equal(stage.temperatureStatus, 'omitted_by_config');
  }
  const legacy = describeLlm(input);
  assert.equal(legacy.stages.plan.sentTemperature, 0.2);
  assert.equal(legacy.stages.build.sentTemperature, 0.1);
  assert.equal(legacy.stages.plan.temperatureOmitSource, null);
});
