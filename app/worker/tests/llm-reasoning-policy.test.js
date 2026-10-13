import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { REASONING_EFFORTS, parseReasoningEffort, parseRequireReasoningPolicy, resolveReasoningPolicy, reasoningPolicyProblems } from '../src/llm-reasoning-policy.js';
import { buildConfiguredRequestBody, prepareRequest, providerProblems } from '../src/llm-provider.js';
import { config } from '../src/config.js';
import { chat } from '../src/llm.js';
import { extractMemories } from '../src/memory.js';
import { logger } from '../src/logger.js';
import { withExecutionControl } from '../src/execution-control.js';
import { MAX_PROVIDER_ATTEMPTS } from '../src/provider-retry.js';
import { describeLlm } from '../src/doctor-llm.js';

const messages = [{ role: 'user', content: 'offline fixture' }];
const options = { providerName: 'openrouter', model: 'qwen/qwen3.8-flash', messages,
  temperature: 0.2, json: true, jsonMode: 'off', nativeOptions: {} };
const settings = { llmMaxOutputTokens: '', llmMaxOutputTokensPlan: 4096,
  llmMaxOutputTokensMemory: 1024, llmRequireOutputCap: true, llmOmitTemperature: true,
  llmReasoningEffortPlan: 'none', llmReasoningEffortMemory: 'none', llmRequireReasoningPolicy: true };
const selected = { llmProvider: 'openrouter', llmModel: options.model, llmApiKey: 'fake' };
function safeBody(body, cap) {
  assert.equal(body.model, options.model); assert.equal(body.max_tokens, cap);
  assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
  assert.equal(Object.hasOwn(body, 'temperature'), false);
  assert.deepEqual(body.reasoning, { effort: 'none' });
  assert.deepEqual(body.provider, { allow_fallbacks: false, require_parameters: true });
}

test('strict effort enum preserves reviewed vocabulary without echoing malformed input', () => {
  assert.deepEqual(REASONING_EFFORTS, ['none', 'low', 'medium', 'high']);
  for (const value of REASONING_EFFORTS) assert.equal(parseReasoningEffort(value), value);
  for (const value of [undefined, null, '']) assert.equal(parseReasoningEffort(value), null);
  for (const value of [true, false, 0, 'off', 'NONE', ' none ', [], {}, 'SECRET'])
    assert.throws(() => parseReasoningEffort(value), e =>
      e.code === 'LLM_REASONING_POLICY_CONFIG' && !e.message.includes('SECRET'));
});

test('require policy boolean is strict and unset defaults to false', () => {
  for (const value of [undefined, null, '', false, 'false']) assert.equal(parseRequireReasoningPolicy(value), false);
  for (const value of [true, 'true']) assert.equal(parseRequireReasoningPolicy(value), true);
  for (const value of [1, 0, 'TRUE', 'yes', ' true ', [], {}, 'SECRET'])
    assert.throws(() => parseRequireReasoningPolicy(value), e =>
      e.code === 'LLM_REASONING_POLICY_CONFIG' && !e.message.includes('SECRET'));
});

test('purpose policy has no global/Build default and validates inactive fields', () => {
  assert.deepEqual(resolveReasoningPolicy(settings, 'plan'), { trustedReasoningEffort: 'none',
    requireReasoningPolicy: true, reasoningPolicySource: 'LLM_REASONING_EFFORT_PLAN', reasoningPolicyPurpose: 'plan' });
  assert.equal(resolveReasoningPolicy(settings, 'memory_extraction').reasoningPolicySource, 'LLM_REASONING_EFFORT_MEMORY');
  assert.equal(resolveReasoningPolicy({ ...settings, llmRequireReasoningPolicy: false }, 'build_decision').trustedReasoningEffort, null);
  assert.throws(() => resolveReasoningPolicy({ llmReasoningEffortMemory: 'INVALID' }, 'plan'), { code: 'LLM_REASONING_POLICY_CONFIG' });
  assert.equal(reasoningPolicyProblems({ llmReasoningEffortPlan: 'INVALID',
    llmReasoningEffortMemory: 'INVALID', llmRequireReasoningPolicy: 'yes' }).length, 3);
  assert.equal(providerProblems({ ...selected, llmReasoningEffortMemory: 'INVALID' }).length, 1);
});

test('real explicit env loader and startup validator wire all three fields without fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-reasoning-env-')), file = join(dir, 'offline.env');
  const base = ['FORGE_ENVIRONMENT_ID=atoms-demo', 'EXPECTED_SUPABASE_PROJECT_REF=abcdefghijklmnopqrst',
    'SUPABASE_URL=https://abcdefghijklmnopqrst.supabase.co', 'SUPABASE_SERVICE_ROLE_KEY=sb_secret_offline',
    'LLM_PROVIDER=openrouter', 'LLM_MODEL=offline', 'OPENROUTER_API_KEY=fake', 'DAYTONA_API_KEY=fake'];
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, NODE_OPTIONS: process.env.NODE_OPTIONS || '',
    FORGE_NO_MAIN: '1', FORGE_ENV_FILE: file, LANGFUSE_ENABLED: 'false' };
  const run = code => spawnSync(process.execPath, ['--input-type=module', '-e', code],
    { cwd: new URL('..', import.meta.url), env, encoding: 'utf8' });
  try {
    for (const flag of ['', 'false', 'true']) {
      writeFileSync(file, [...base, 'LLM_REASONING_EFFORT_PLAN=none', 'LLM_REASONING_EFFORT_MEMORY=none',
        'LLM_REQUIRE_REASONING_POLICY=' + flag].join('\n'));
      const child = run("const {config,assertRunnable}=await import('./src/config.js'); const {resolveReasoningPolicy}=await import('./src/llm-reasoning-policy.js'); console.log(JSON.stringify({plan:resolveReasoningPolicy(config,'plan'),memory:resolveReasoningPolicy(config,'memory_extraction'),problems:assertRunnable()}));");
      assert.equal(child.status, 0, child.stderr);
      const result = JSON.parse(child.stdout);
      assert.deepEqual(result.problems, []); assert.equal(result.plan.trustedReasoningEffort, 'none');
      assert.equal(result.memory.trustedReasoningEffort, 'none'); assert.equal(result.plan.requireReasoningPolicy, flag === 'true');
    }
    for (const invalid of ['LLM_REASONING_EFFORT_PLAN=invalid', 'LLM_REASONING_EFFORT_MEMORY=invalid',
      'LLM_REQUIRE_REASONING_POLICY=TRUE']) {
      writeFileSync(file, [...base, invalid].join('\n'));
      const child = run("const {assertRunnable}=await import('./src/config.js'); console.log(JSON.stringify(assertRunnable()));");
      assert.equal(child.status, 0, child.stderr);
      assert.match(child.stdout, /LLM_(?:REASONING_EFFORT|REQUIRE_REASONING_POLICY)/);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('unset/false policy preserves identical native legacy bodies across all providers and purposes', () => {
  for (const providerName of ['openrouter', 'deepseek', 'zhipu', 'gemini', 'ollama', 'lmstudio']) {
    const expected = { model: options.model, messages, temperature: 0.2,
      ...(providerName === 'openrouter' ? { provider: { allow_fallbacks: false } } : {}) };
    for (const llmRequireReasoningPolicy of [undefined, '', false, 'false'])
      for (const purpose of ['plan', 'memory_extraction', 'build_decision', 'unspecified'])
        assert.deepEqual(buildConfiguredRequestBody({ llmRequireReasoningPolicy }, purpose, { ...options, providerName }), expected);
  }
  assert.deepEqual(buildConfiguredRequestBody({}, 'plan', { ...options, nativeOptions: { reasoning: { effort: 'high' } } }),
    { model: options.model, messages, temperature: 0.2, reasoning: { effort: 'high' }, provider: { allow_fallbacks: false } });
  assert.deepEqual(buildConfiguredRequestBody({}, 'plan', { ...options, nativeOptions: null }),
    { model: options.model, messages, temperature: 0.2, reasoning: { effort: 'none' }, provider: { allow_fallbacks: false } });
});

test('future Qwen Plan/Memory bodies compose exact caps, temperature absence and reasoning none', () => {
  safeBody(buildConfiguredRequestBody(settings, 'plan', options), 4096);
  safeBody(buildConfiguredRequestBody(settings, 'memory_extraction', options), 1024);
});

test('trusted none replaces native low/medium/high/null/removal and nested enabling/budget fields', () => {
  for (const reasoning of [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }, null,
    undefined, { effort: 'high', enabled: true, max_tokens: 99999, exclude: false }]) {
    const native = reasoning === undefined ? {} : { reasoning };
    for (const nativeOptions of [native, JSON.stringify(native)])
      safeBody(buildConfiguredRequestBody(settings, 'plan', {
        ...options, nativeOptions, trustedReasoningEffort: 'high', requireReasoningPolicy: false,
        reasoningPolicySource: null, omitTemperature: false, maxOutputTokens: 99999,
      }), 4096);
  }
});

test('historical OpenRouter thinking/Alibaba enable_thinking remain ignored', () => {
  const nativeOptions = { thinking: { type: 'enabled' }, enable_thinking: true, reasoning_effort: 'high' };
  const legacy = prepareRequest({ ...options, nativeOptions });
  for (const key of ['thinking', 'enable_thinking', 'reasoning']) assert.equal(Object.hasOwn(legacy.body, key), false);
  assert.equal(legacy.capability.warnings.length, 3);
  safeBody(buildConfiguredRequestBody(settings, 'plan', { ...options, nativeOptions }), 4096);
});

test('trusted policy never guesses unreviewed provider mappings', () => {
  for (const providerName of ['deepseek', 'zhipu', 'gemini', 'ollama', 'lmstudio'])
    assert.throws(() => buildConfiguredRequestBody({ llmReasoningEffortPlan: 'none' }, 'plan',
      { ...options, providerName }), { code: 'LLM_REASONING_POLICY_UNSUPPORTED' });
  for (const effort of REASONING_EFFORTS)
    assert.deepEqual(buildConfiguredRequestBody({ llmReasoningEffortPlan: effort }, 'plan', options).reasoning, { effort });
});

async function mockRuntime(fn, extra = {}) {
  const previous = { ...config }, oldFetch = globalThis.fetch, oldLogger = { ...logger }, logs = [];
  Object.assign(config, selected, settings, { llmBaseUrl: 'https://offline.invalid/v1', llmJsonMode: 'off',
    llmTimeoutMs: 120000, planTemperature: 0.2, buildTemperature: 0.1,
    planProviderOptionsRaw: '{}', buildProviderOptionsRaw: '{}' }, extra);
  for (const level of ['info', 'warn', 'error']) logger[level] = (message, meta) => logs.push({ message, ...meta });
  try { await fn({ logs }); }
  finally { Object.assign(config, previous); globalThis.fetch = oldFetch; Object.assign(logger, oldLogger); }
}
const response = (content = '{}') => new Response(JSON.stringify({ choices: [{ message: { content }, finish_reason: 'stop' }] }));

test('common Plan boundary ignores caller policy overrides and emits trusted/sent diagnostics', async () => mockRuntime(async ({ logs }) => {
  let body;
  globalThis.fetch = async (_url, init) => { body = JSON.parse(init.body); return response(); };
  await chat(messages, { purpose: 'plan', trustedReasoningEffort: 'high', requireReasoningPolicy: false,
    reasoningMode: 'high', omitTemperature: false, maxOutputTokens: 99999 });
  safeBody(body, 4096);
  const meta = logs.find(x => x.message === 'model.request_started');
  assert.equal(meta.trusted_reasoning_effort, 'none'); assert.equal(meta.effective_reasoning_effort, 'none');
  assert.equal(meta.reasoning_policy_source, 'LLM_REASONING_EFFORT_PLAN'); assert.equal(meta.reasoning_policy_purpose, 'plan');
  assert.equal(meta.reasoning_policy_required, true); assert.equal(meta.max_physical_attempts, 2);
}, { planProviderOptionsRaw: '{"reasoning":{"effort":"high","enabled":true,"max_tokens":99999},"thinking":{"type":"enabled"}}' }));

test('real extractMemories -> common chat -> OpenRouter path receives trusted none', async () => mockRuntime(async ({ logs }) => {
  let body, writes = 0, calls = 0;
  globalThis.fetch = async (_url, init) => {
    calls++; body = JSON.parse(init.body);
    return response('{"upsert":[{"scope":"project","key":"offline","value":"test"}],"remove":[]}');
  };
  await extractMemories({ userId: 'u', projectId: 'p', userPrompt: 'offline', summary: 'offline', taskId: 't' },
    { chat, upsertMemory: async () => { writes++; }, suggestMemory: async () => {}, deleteMemory: async () => {} });
  safeBody(body, 1024); assert.equal(calls, 1); assert.equal(writes, 1);
  const meta = logs.find(x => x.message === 'model.request_started');
  assert.equal(meta.reasoning_policy_source, 'LLM_REASONING_EFFORT_MEMORY');
  assert.equal(meta.reasoning_policy_purpose, 'memory_extraction'); assert.equal(meta.effective_reasoning_effort, 'none');
}));

test('required missing policy blocks unreviewed purposes before lease/fetch even when default cap exists', async () => mockRuntime(async () => {
  let fetches = 0, leases = 0;
  globalThis.fetch = async () => { fetches++; return response(); };
  const control = { signal: new AbortController().signal, checkLease: async () => { leases++; } };
  config.llmMaxOutputTokens = 512;
  for (const purpose of ['design', 'action_plan', 'build_decision', 'doctor_probe', 'unspecified']) {
    await assert.rejects(withExecutionControl(control, () => chat(messages, { purpose, trustedReasoningEffort: 'none' })),
      { code: 'LLM_REASONING_POLICY_REQUIRED' });
    assert.throws(() => buildConfiguredRequestBody(config, purpose, options), { code: 'LLM_REASONING_POLICY_REQUIRED' });
  }
  config.llmReasoningEffortPlan = '';
  await assert.rejects(withExecutionControl(control, () => chat(messages, { purpose: 'plan' })), { code: 'LLM_REASONING_POLICY_REQUIRED' });
  assert.equal(fetches, 0); assert.equal(leases, 0);
}));

test('combined future required config preserves existing output cap failure ordering and zero HTTP', async () => mockRuntime(async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; return response(); };
  for (const purpose of ['design', 'action_plan', 'build_decision', 'doctor_probe', 'unspecified'])
    await assert.rejects(chat(messages, { purpose }), { code: 'LLM_OUTPUT_CAP_REQUIRED' });
  assert.equal(calls, 0);
}));

test('malformed inactive effort/require flag fails before lease/fetch without exposing input', async () => mockRuntime(async () => {
  let calls = 0, leases = 0;
  globalThis.fetch = async () => { calls++; return response(); };
  const control = { signal: new AbortController().signal, checkLease: async () => { leases++; } };
  config.llmReasoningEffortMemory = 'SECRET';
  await assert.rejects(withExecutionControl(control, () => chat(messages, { purpose: 'plan' })),
    e => e.code === 'LLM_REASONING_POLICY_CONFIG' && !e.message.includes('SECRET'));
  config.llmReasoningEffortMemory = 'none'; config.llmRequireReasoningPolicy = 'yes';
  await assert.rejects(withExecutionControl(control, () => chat(messages, { purpose: 'plan' })), { code: 'LLM_REASONING_POLICY_CONFIG' });
  assert.equal(calls, 0); assert.equal(leases, 0);
}));

test('two physical attempts retain frozen cap/temperature/none despite mid-attempt config changes', async () => mockRuntime(async () => {
  const bodies = [];
  globalThis.fetch = async (_url, init) => {
    bodies.push(init.body);
    if (bodies.length === 1) {
      config.llmReasoningEffortPlan = 'high'; config.llmReasoningEffortMemory = '';
      config.llmRequireReasoningPolicy = false; config.llmOmitTemperature = false;
      config.llmMaxOutputTokensPlan = 99999; config.planTemperature = 1;
      config.planProviderOptionsRaw = '{"reasoning":{"effort":"high","enabled":true}}';
      return new Response('overload', { status: 503 });
    }
    return response();
  };
  await chat(messages, { purpose: 'plan' });
  assert.equal(MAX_PROVIDER_ATTEMPTS, 2); assert.equal(bodies.length, 2); assert.equal(bodies[0], bodies[1]);
  for (const body of bodies) safeBody(JSON.parse(body), 4096);
}));

test('doctor configured inference cannot bypass reasoning gate and projection makes no upstream claim', () => {
  assert.throws(() => buildConfiguredRequestBody({ ...settings, llmMaxOutputTokens: 512 }, 'doctor_probe',
    { ...options, trustedReasoningEffort: 'none', requireReasoningPolicy: false }), { code: 'LLM_REASONING_POLICY_REQUIRED' });
  assert.match(readFileSync(new URL('../src/doctor.js', import.meta.url), 'utf8'), /buildConfiguredRequestBody\(config, 'doctor_probe'/);
  const report = describeLlm({ ...selected, ...settings, planProviderOptionsRaw: '{}', buildProviderOptionsRaw: '{}' });
  assert.deepEqual(report.problems, []); assert.equal(report.stages.plan.trustedReasoningEffort, 'none');
  assert.equal(report.stages.plan.effectiveReasoningEffort, 'none');
  assert.equal(report.stages.plan.reasoningPolicySource, 'LLM_REASONING_EFFORT_PLAN');
  assert.equal(report.stages.build.inferenceBlocked, true); assert.equal(report.stages.build.code, 'LLM_REASONING_POLICY_REQUIRED');
});
