import { currentExecution, assertExecutionActive } from './execution-control.js';
import { parseOutputTokenCap } from './llm-output-cap.js';

// Full final JSON body, with no exclusions (even non-prompt fields), plus template overhead.
// This is a conservative local exposure model, not a tokenizer or an actual billing metric.
export const INPUT_TOKEN_SAFETY_MARGIN = 2048;
const SCALE = 1_000_000_000_000n; // USD picodollars: costs round UP, ceiling rounds DOWN.
const MILLION = 1_000_000n;
const ledgers = new Map(); // Never reset/release an identity's reservation within this process.
const fail = (code, message) => Object.assign(new Error(message), { code });
const fields = [
  ['llmCostInputUsdPerMillion', 'LLM_COST_INPUT_USD_PER_MILLION'],
  ['llmCostOutputUsdPerMillion', 'LLM_COST_OUTPUT_USD_PER_MILLION'],
  ['llmMaxTheoreticalCostUsdPerExecution', 'LLM_MAX_THEORETICAL_COST_USD_PER_EXECUTION'],
];

export function parseRequireCostBudget(value) {
  if (value == null || value === '' || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw fail('LLM_COST_CONFIG', 'LLM_REQUIRE_COST_BUDGET must be true or false');
}

/** Strict decimal parsing, including finite decimal exponents, with exact rational arithmetic. */
export function parseCostDecimal(value, label = 'cost field') {
  if (value == null || value === '') return null;
  const text = typeof value === 'number' ? String(value) : typeof value === 'string' ? value : '';
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text) || !Number.isFinite(Number(text)))
    throw fail('LLM_COST_CONFIG', label + ' must be a finite non-negative decimal');
  const [mantissa, exponentText = '0'] = text.toLowerCase().split('e');
  const [whole, fraction = ''] = mantissa.split('.');
  const exponent = Number(exponentText) - fraction.length;
  // Finite nonzero numbers cannot require arbitrarily huge powers; zero needs no exponent.
  const numerator = BigInt(whole + fraction);
  if (numerator === 0n) return { numerator: 0n, denominator: 1n, value: Number(text) };
  if (!Number.isSafeInteger(exponent) || Math.abs(exponent) > 1000)
    throw fail('LLM_COST_CONFIG', label + ' decimal precision is out of range');
  let n = exponent >= 0 ? numerator * 10n ** BigInt(exponent) : numerator;
  let d = exponent >= 0 ? 1n : 10n ** BigInt(-exponent);
  let a = n, b = d;
  while (b) { [a, b] = [b, a % b]; }
  n /= a; d /= a; // Equivalent decimal spelling must not look like a changed price policy.
  return { numerator: n, denominator: d, value: Number(text) };
}
const numeric = (r) => r.value;
const ceil = (n, d) => (n + d - 1n) / d;
const usd = (units) => Number(units.toString() + 'e-12');

export function resolveCostPolicy(settings) {
  const required = parseRequireCostBudget(settings.llmRequireCostBudget);
  const values = fields.map(([key, label]) => parseCostDecimal(settings[key], label));
  const [input, output, budget] = values;
  if (required && budget && budget.numerator <= 0n)
    throw fail('LLM_COST_CONFIG', 'LLM_MAX_THEORETICAL_COST_USD_PER_EXECUTION must be positive');
  if (required && values.some(v => v == null))
    throw fail('LLM_COST_BUDGET_REQUIRED', 'Required theoretical cost configuration is incomplete');
  const ceiling = budget ? budget.numerator * SCALE / budget.denominator : null;
  if (required && ceiling <= 0n)
    throw fail('LLM_COST_CONFIG', 'Execution budget is below accounting precision');
  return { required, input, output, ceiling,
    inputRate: input ? numeric(input) : null, outputRate: output ? numeric(output) : null,
    budgetUsd: ceiling == null ? null : usd(ceiling) };
}

export function costPolicyProblems(settings) {
  try { resolveCostPolicy(settings); return []; } catch (error) { return [error.message]; }
}

export function describeCostPolicy(settings) {
  const p = resolveCostPolicy(settings);
  return { required: p.required, input_rate_usd_per_million: p.inputRate,
    output_rate_usd_per_million: p.outputRate, execution_budget_usd: p.budgetUsd,
    input_safety_margin_tokens: INPUT_TOKEN_SAFETY_MARGIN,
    accounting: 'picodollars; reservation rounds up; ceiling rounds down',
    ledger_allocated: false };
}

/** Pure projection. It neither creates an execution ledger nor authorizes HTTP. */
export function estimateRequestCost(policy, requestBody, trustedOutputCap) {
  if (!policy.required) return null;
  const cap = parseOutputTokenCap(trustedOutputCap);
  if (cap == null) throw fail('LLM_COST_OUTPUT_CAP_REQUIRED', 'Cost admission requires a trusted output cap');
  if (typeof requestBody !== 'string')
    throw fail('LLM_COST_REQUEST_INVALID', 'Cost admission requires the final serialized request');
  let body;
  try { body = JSON.parse(requestBody); } catch {
    throw fail('LLM_COST_REQUEST_INVALID', 'Final serialized request must be valid JSON');
  }
  // Only the existing reviewed adapter currently proves the final cap contract.
  if (body.max_tokens !== cap || Object.hasOwn(body, 'max_completion_tokens'))
    throw fail('LLM_COST_OUTPUT_CAP_REQUIRED', 'Final request does not match the trusted output cap');
  const bytes = Buffer.byteLength(requestBody, 'utf8');
  const inputTokens = bytes + INPUT_TOKEN_SAFETY_MARGIN;
  const inputUnits = ceil(BigInt(inputTokens) * policy.input.numerator * SCALE, policy.input.denominator * MILLION);
  const outputUnits = ceil(BigInt(cap) * policy.output.numerator * SCALE, policy.output.denominator * MILLION);
  const units = inputUnits + outputUnits;
  return { units, diagnostics: {
    serialized_body_bytes: bytes, input_upper_bound_tokens: inputTokens,
    output_upper_bound_tokens: cap, input_rate_usd_per_million: policy.inputRate,
    output_rate_usd_per_million: policy.outputRate, request_theoretical_max_usd: usd(units),
    execution_budget_usd: policy.budgetUsd,
  } };
}

function executionIdentity(taskId) {
  assertExecutionActive();
  const context = currentExecution();
  if (!context || typeof context.taskId !== 'string' || !context.taskId
      || typeof context.executionId !== 'string' || !context.executionId
      || typeof context.checkLease !== 'function' || !context.signal
      || (taskId != null && taskId !== context.taskId))
    throw fail('LLM_COST_EXECUTION_REQUIRED', 'Cost-required inference needs an authoritative execution context');
  return context;
}

export function assertCostExecution(policy, taskId) {
  if (policy.required) executionIdentity(taskId);
}

/** Synchronous compare-and-reserve: no await between reading the ledger and debiting it.
 * Call only immediately before the physical fetch; every attempt pays again, with no refund API.
 * Fencing is checked by beforeModelCall per physical attempt plus the current abort signal.
 */
export function reserveRequestCost(policy, requestBody, trustedOutputCap, { taskId, purpose, attempt } = {}) {
  if (!policy.required) return null;
  const context = executionIdentity(taskId);
  const estimate = estimateRequestCost(policy, requestBody, trustedOutputCap);
  const key = JSON.stringify([context.taskId, context.executionId]);
  const signature = JSON.stringify([policy.input.numerator.toString(), policy.input.denominator.toString(),
    policy.output.numerator.toString(), policy.output.denominator.toString(), policy.ceiling.toString()]);
  let ledger = ledgers.get(key);
  if (!ledger) { ledger = { signature, reserved: 0n }; ledgers.set(key, ledger); }
  if (ledger.signature !== signature)
    throw fail('LLM_COST_POLICY_CHANGED', 'An execution cannot replace its trusted pricing or budget');
  const before = ledger.reserved;
  const admitted = before + estimate.units <= policy.ceiling;
  if (admitted) ledger.reserved += estimate.units;
  const diagnostics = { ...estimate.diagnostics, purpose, execution_id: context.executionId,
    physical_attempt: attempt ?? null, execution_reserved_before: usd(before),
    execution_reserved_after: usd(ledger.reserved), admitted };
  if (!admitted) {
    const error = fail('LLM_COST_BUDGET_EXCEEDED', 'The next provider request exceeds this execution theoretical cost budget');
    error.costAdmission = diagnostics;
    throw error;
  }
  return diagnostics;
}

/** Legacy operator direct-POST exits have no task budget; required mode must never bypass it.
 * Read-only doctor/body projection does not call this and remains usable without a ledger.
 */
export function assertUnbudgetedOperatorInferenceAllowed(settings) {
  if (resolveCostPolicy(settings).required)
    throw fail('LLM_COST_EXECUTION_REQUIRED', 'Operator inference has no explicit cost-authorized execution; use read-only doctor projection');
}
