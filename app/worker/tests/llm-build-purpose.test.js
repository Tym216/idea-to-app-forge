import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildConfiguredRequestBody, providerProblems } from '../src/llm-provider.js';
import { resolveOutputCap } from '../src/llm-output-cap.js';
import { resolveReasoningPolicy } from '../src/llm-reasoning-policy.js';
import { describeLlm } from '../src/doctor-llm.js';

export const future = {
  llmProvider: 'openrouter', llmModel: 'qwen/qwen3.8-flash', llmApiKey: 'offline',
  llmBaseUrl: 'https://offline.invalid/v1', llmJsonMode: 'off', llmTimeoutMs: 120000,
  llmMaxOutputTokens: '', llmMaxOutputTokensPlan: 4096, llmMaxOutputTokensMemory: 1024,
  llmMaxOutputTokensBuild: 4096, llmRequireOutputCap: true, llmOmitTemperature: true,
  llmReasoningEffortPlan: 'none', llmReasoningEffortMemory: 'none',
  llmReasoningEffortBuild: 'none', llmRequireReasoningPolicy: true,
  llmRequireCostBudget: true, llmCostInputUsdPerMillion: '0.20', llmCostOutputUsdPerMillion: '0.47',
  llmMaxTheoreticalCostUsdPerExecution: '0.10', planProviderOptionsRaw: '{}', buildProviderOptionsRaw: '{}',
  planTemperature: 0.2, buildTemperature: 0.1, maxToolSteps: 40, maxFixRounds: 1,
  actionFusionEnabled: true, fusionMaxFiles: 8, fusionMaxBytes: 131072,
};
const options = { providerName: 'openrouter', model: future.llmModel, messages: [],
  temperature: 0.1, json: true, jsonMode: 'off', nativeOptions: {} };

test('Build cap/reasoning map ONLY build_decision; Plan/Memory retain their reviewed mappings', () => {
  for (const [purpose, cap, source] of [['build_decision', 4096, 'BUILD'], ['plan', 4096, 'PLAN'],
    ['memory_extraction', 1024, 'MEMORY']]) {
    const body = buildConfiguredRequestBody(future, purpose, options);
    assert.equal(body.max_tokens, cap);
    assert.equal(Object.hasOwn(body, 'temperature'), false);
    assert.equal(Object.hasOwn(body, 'max_completion_tokens'), false);
    assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(body.provider.require_parameters, true);
    assert.equal(resolveOutputCap(future, purpose).outputCapSource, 'LLM_MAX_OUTPUT_TOKENS_' + source);
    assert.equal(resolveReasoningPolicy(future, purpose).reasoningPolicySource, 'LLM_REASONING_EFFORT_' + source);
  }
  for (const purpose of ['action_plan', 'design', 'doctor', 'unspecified', 'future'])
    for (const resolve of [resolveOutputCap, resolveReasoningPolicy])
      assert.throws(() => resolve(future, purpose), e => /_REQUIRED$/.test(e.code));
});

test('Build final invariants override caller/native enabling, nulling, omission or increased cap', () => {
  for (const effort of ['low', 'medium', 'high']) {
    const body = buildConfiguredRequestBody(future, 'build_decision', { ...options,
      maxOutputTokens: 99999, trustedReasoningEffort: 'high', omitTemperature: false,
      nativeOptions: { reasoning: { effort, enabled: true, max_tokens: 99999 }, max_tokens: 99999, temperature: 2 } });
    assert.equal(body.max_tokens, 4096); assert.deepEqual(body.reasoning, { effort: 'none' });
    assert.equal(Object.hasOwn(body, 'temperature'), false);
  }
  assert.ok(providerProblems({ ...future, llmMaxOutputTokensBuild: 'junk' }).length);
  assert.ok(providerProblems({ ...future, llmReasoningEffortBuild: 'junk' }).length);
});

test('doctor projects Build policies/cost without task context or allocating/reserving a ledger', () => {
  const report = describeLlm(future);
  assert.deepEqual(report.problems, []);
  assert.equal(report.stages.build.outputCap, 4096);
  assert.equal(report.stages.build.effectiveReasoningEffort, 'none');
  assert.equal(report.stages.build.sentTemperature, null);
  assert.equal(report.cost.execution_budget_usd, 0.1);
  assert.equal(report.cost.ledger_allocated, false);
  assert.equal(report.stages.build.theoreticalProjection.input_upper_bound_tokens,
    report.stages.build.theoreticalProjection.serialized_body_bytes + 2048);
});

test('doctor cannot label a capless required-cost projection as inference-ready', () => {
  const report = describeLlm({ ...future, llmRequireOutputCap: false, llmMaxOutputTokensBuild: '' });
  assert.equal(report.stages.build.inferenceBlocked, true);
  assert.equal(report.stages.build.code, 'LLM_COST_OUTPUT_CAP_REQUIRED');
  assert.equal(report.cost.ledger_allocated, false);
});
