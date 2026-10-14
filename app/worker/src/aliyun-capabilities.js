/** Confirmed Alibaba-hosted model IDs only; not third-party namespace aliases.
 * https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions
 * max_completion_tokens includes reasoning + answer; documented tolerance <= 10 tokens.
 * Adding a model also requires operator-reviewed region/model prices, never price inheritance.
 */
export const ALIYUN_OUTPUT_TOKEN_MARGIN = 10;
const models = Object.freeze({
  'qwen3.8-flash': Object.freeze({ preserveThinking: true }),
  'qwen3.8-max': Object.freeze({ preserveThinking: true }),
  'deepseek-v4-pro': Object.freeze({ preserveThinking: false }),
});
export function aliyunCapabilities(model) { return Object.hasOwn(models, model) ? models[model] : null; }
