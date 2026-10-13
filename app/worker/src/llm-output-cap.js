/** Trusted output budgets; never sourced from user text or provider/native options. */
export const MAX_OUTPUT_TOKEN_CAP = 131072; // Sanity limit, not a model capability or a Demo choice.
const capError = (code, message) => Object.assign(new Error(message), { code });

export function parseOutputTokenCap(value, label = 'maxOutputTokens') {
  if (value == null || value === '') return null;
  const validType = typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value));
  const number = validType ? Number(value) : NaN;
  if (!Number.isSafeInteger(number) || number < 1 || number > MAX_OUTPUT_TOKEN_CAP)
    throw capError('LLM_OUTPUT_CAP_CONFIG', label + ' 必须是 1–' + MAX_OUTPUT_TOKEN_CAP + ' 的整数');
  return number;
}

export function parseRequireOutputCap(value) {
  if (value == null || value === '' || value === false || value === 'false') return false;
  if (value === true || value === 'true') return true;
  throw capError('LLM_OUTPUT_CAP_CONFIG', 'LLM_REQUIRE_OUTPUT_CAP 必须是 true 或 false');
}

const fields = [
  ['llmMaxOutputTokens', 'LLM_MAX_OUTPUT_TOKENS'],
  ['llmMaxOutputTokensPlan', 'LLM_MAX_OUTPUT_TOKENS_PLAN'],
  ['llmMaxOutputTokensMemory', 'LLM_MAX_OUTPUT_TOKENS_MEMORY'],
  ['llmMaxOutputTokensBuild', 'LLM_MAX_OUTPUT_TOKENS_BUILD'],
  ['llmMaxOutputTokensDesign', 'LLM_MAX_OUTPUT_TOKENS_DESIGN'],
  ['llmMaxOutputTokensActionPlan', 'LLM_MAX_OUTPUT_TOKENS_ACTION_PLAN'],
];

export function outputCapProblems(settings) {
  const errors = [];
  for (const [key, label] of fields) {
    try { parseOutputTokenCap(settings[key], label); } catch (error) { errors.push(error.message); }
  }
  try { parseRequireOutputCap(settings.llmRequireOutputCap); } catch (error) { errors.push(error.message); }
  return errors;
}

export function resolveOutputCap(settings, purpose = 'unspecified') {
  // Validate every configured field, including inactive overrides; no malformed-config fallback.
  const caps = Object.fromEntries(fields.map(([key, label]) => [key, parseOutputTokenCap(settings[key], label)]));
  const requireOutputCap = parseRequireOutputCap(settings.llmRequireOutputCap);
  const normalized = String(purpose).toLowerCase();
  const override = normalized === 'plan' ? fields[1] : normalized === 'memory_extraction' ? fields[2] : normalized === 'build_decision' ? fields[3]
    : normalized === 'design' ? fields[4] : normalized === 'action_plan' ? fields[5] : null;
  const selected = override && caps[override[0]] != null ? override : fields[0];
  const maxOutputTokens = caps[selected[0]];
  if (requireOutputCap && maxOutputTokens == null)
    throw capError('LLM_OUTPUT_CAP_REQUIRED', 'LLM_OUTPUT_CAP_REQUIRED: 当前推理用途没有可信硬输出上限');
  return { maxOutputTokens, requireOutputCap, outputCapSource: maxOutputTokens == null ? null : selected[1] };
}

/** Explicit OpenRouter Chat Completions contract; other adapters require reviewed mappings. */
export function applyOutputCap(body, { providerName, maxOutputTokens, requireOutputCap = false }) {
  const cap = parseOutputTokenCap(maxOutputTokens);
  const required = parseRequireOutputCap(requireOutputCap);
  if (cap == null) {
    if (required) throw capError('LLM_OUTPUT_CAP_REQUIRED', 'LLM_OUTPUT_CAP_REQUIRED: 当前推理没有可信硬输出上限');
    return { effectiveMaxOutputTokens: null, outputCapField: null };
  }
  if (providerName !== 'openrouter')
    throw capError('LLM_OUTPUT_CAP_UNSUPPORTED', 'LLM_OUTPUT_CAP_UNSUPPORTED: 当前 adapter 尚未确认硬输出上限映射');
  // Apply after native options: a confirmed budget cannot be removed, raised, or duplicated.
  delete body.max_completion_tokens;
  body.max_tokens = cap;
  // Reject routes unable to honor parameters rather than silently dropping the budget.
  body.provider = { ...body.provider, require_parameters: true };
  return { effectiveMaxOutputTokens: cap, outputCapField: 'max_tokens' };
}
