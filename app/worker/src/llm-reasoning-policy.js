import { aliyunCapabilities } from './aliyun-capabilities.js';

/** Trusted purpose-specific policy; no global effort or model-specific guesses. */
export const REASONING_EFFORTS = Object.freeze(['none', 'low', 'medium', 'high']);
const policyError = (code, message) => Object.assign(new Error(message), { code });

export function parseReasoningEffort(value, label = 'reasoning effort') {
  if (value == null || value === '') return null;
  if (typeof value === 'string' && REASONING_EFFORTS.includes(value)) return value;
  throw policyError('LLM_REASONING_POLICY_CONFIG', label + ' 必须是 none / low / medium / high');
}

export function parseRequireReasoningPolicy(value) {
  if (value == null || value === '' || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw policyError('LLM_REASONING_POLICY_CONFIG', 'LLM_REQUIRE_REASONING_POLICY 必须是 true 或 false');
}

const fields = [
  ['llmReasoningEffortPlan', 'LLM_REASONING_EFFORT_PLAN'],
  ['llmReasoningEffortMemory', 'LLM_REASONING_EFFORT_MEMORY'],
  ['llmReasoningEffortBuild', 'LLM_REASONING_EFFORT_BUILD'],
  ['llmReasoningEffortDesign', 'LLM_REASONING_EFFORT_DESIGN'],
  ['llmReasoningEffortActionPlan', 'LLM_REASONING_EFFORT_ACTION_PLAN'],
];

export function reasoningPolicyProblems(settings) {
  const problems = [];
  for (const [key, label] of fields) {
    try { parseReasoningEffort(settings[key], label); } catch (error) { problems.push(error.message); }
  }
  try { parseRequireReasoningPolicy(settings.llmRequireReasoningPolicy); } catch (error) { problems.push(error.message); }
  return problems;
}

export function resolveReasoningPolicy(settings, purpose = 'unspecified') {
  // Validate inactive fields too: malformed config must never silently fall back.
  const efforts = Object.fromEntries(fields.map(([key, label]) => [key, parseReasoningEffort(settings[key], label)]));
  const requireReasoningPolicy = parseRequireReasoningPolicy(settings.llmRequireReasoningPolicy);
  const reasoningPolicyPurpose = String(purpose).toLowerCase();
  const field = reasoningPolicyPurpose === 'plan' ? fields[0]
    : reasoningPolicyPurpose === 'memory_extraction' ? fields[1]
    : reasoningPolicyPurpose === 'build_decision' ? fields[2]
    : reasoningPolicyPurpose === 'design' ? fields[3] : reasoningPolicyPurpose === 'action_plan' ? fields[4] : null;
  const trustedReasoningEffort = field ? efforts[field[0]] : null;
  if (requireReasoningPolicy && trustedReasoningEffort == null)
    throw policyError('LLM_REASONING_POLICY_REQUIRED', 'LLM_REASONING_POLICY_REQUIRED: 当前推理用途没有可信 reasoning policy');
  return { trustedReasoningEffort, requireReasoningPolicy,
    reasoningPolicySource: trustedReasoningEffort == null ? null : field[1], reasoningPolicyPurpose };
}

/** Final request invariant after native mapping; replace, never merge enabling subfields. */
export function applyReasoningPolicy(body, { providerName, model, trustedReasoningEffort, requireReasoningPolicy = false }) {
  const effort = parseReasoningEffort(trustedReasoningEffort);
  const required = parseRequireReasoningPolicy(requireReasoningPolicy);
  if (effort == null) {
    if (required) throw policyError('LLM_REASONING_POLICY_REQUIRED', 'LLM_REASONING_POLICY_REQUIRED: 当前推理没有可信 reasoning policy');
    return {};
  }
  if (providerName === 'aliyun' && aliyunCapabilities(model) && effort === 'none') {
    // Trusted off overrides optional enablement; no OpenRouter routing fields.
    body.enable_thinking = false;
    delete body.reasoning_effort;
    delete body.thinking_budget;
    if (aliyunCapabilities(model).preserveThinking) body.preserve_thinking = false;
    return { effectiveReasoningEffort: 'none' };
  }
  if (providerName !== 'openrouter')
    throw policyError('LLM_REASONING_POLICY_UNSUPPORTED', 'LLM_REASONING_POLICY_UNSUPPORTED: 当前 adapter 尚无已确认的可信 reasoning policy 映射');
  body.reasoning = { effort };
  body.provider = { ...body.provider, require_parameters: true };
  // Effective here means sent in the request; it is not evidence of provider enforcement.
  return { effectiveReasoningEffort: effort };
}
