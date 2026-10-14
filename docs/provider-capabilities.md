# 模型请求能力与响应契约

Forge 统一 provider、model、base URL、timeout、Plan/Build temperature 和 JSON 请求偏好。Thinking / reasoning 使用供应商原生字段，集中在 `app/worker/src/llm-provider.js` 校验和映射；Agent 只要求结构化文本或 JSON action，不直接判断供应商。

## 配置与调用

```ini
LLM_PROVIDER=zhipu
LLM_MODEL=glm-4.5-air
LLM_TIMEOUT_MS=120000
PLAN_TEMPERATURE=0.2
BUILD_TEMPERATURE=0.1
LLM_JSON_MODE=auto
PLAN_PROVIDER_OPTIONS={}
BUILD_PROVIDER_OPTIONS={}
```

`PLAN_PROVIDER_OPTIONS` / `BUILD_PROVIDER_OPTIONS` 必须是 JSON 对象；可在 `.env` 中写成单行或完整的多行对象。不填则沿用旧推理配置，填 `{}` 则不发送旧版自动推理参数。可用的原生字段取决于供应商/模型已确认的映射；未知可选字段会省略并记 warning。比如已确认的 DeepSeek 模型可设置 `PLAN_PROVIDER_OPTIONS={"thinking":{"type":"enabled"},"reasoning_effort":"high"}`。没有为 GLM-4.5-Air 猜测推理字段。

通用 `LLM_MODEL`、`LLM_BASE_URL`、`LLM_API_KEY`、`LLM_JSON_MODE` 非空时优先；原有 `ZHIPU_MODEL`、`DEEPSEEK_BASE_URL`、各 `*_JSON_MODE` 等仍有效。旧 `PLAN_REASONING_MODE`、`PLAN_REASONING_POLICY`、`LLM_REASONING_PROFILE` 也暂时兼容，仅在对应 stage options 留空时参与请求。迁移时先运行 `npm run doctor:llm` 比对 requested/effective；不要在未核实能力前复制其他供应商的 thinking 参数。

配置本身无效（非法 JSON、无效 URL、负 timeout/temperature、缺必需 Key/模型）会阻止 Worker 启动；可选参数不支持则省略并警告。`doctor:llm` 只尝试读取模型列表；Worker 启动时也做同样的只读检查。列表接口缺失时报告 unknown 并继续，认证/连接失败或返回的列表明确没有所选模型时阻止启动。`smoke:llm` 才实际发一次可能计费的生成请求。修改配置后重启 Worker。

## 首版能力边界

| 接口 / 模型 | 行为 |
| --- | --- |
| DeepSeek `deepseek-flash` / `deepseek-v4-pro` | 显式 thinking 开关；开启时发送 low/high，省略无效 temperature |
| Aliyun OpenAI-compatible | 已确认的 Qwen3.8 Flash/Max、DeepSeek-V4-Pro 支持 trusted none 和总输出 cap；人民币价格配置与切换步骤见 [阿里云说明](aliyun-provider.md)；未实测 |
| OpenRouter | 映射为 reasoning.effort；记录 unconfirmed 与 warning，上游支持与否由实际响应决定；不假装关掉不可关闭的推理 |
| Gemini 2.5 / 3 兼容端点 | 已确认的 reasoning_effort 映射可发送；无法确认关闭推理的模型省略 off 参数并警告，实际模式由上游决定 |
| Ollama / LM Studio | 默认不猜模型能力；显式 profile 后发送 reasoning_effort，记录能力未确认警告 |
| 其他模型 / 未登记别名 | 原生可选参数无确认映射时省略并警告；服务端实际推理状态仍未知 |

通常保留调用方 temperature；仅已确认无效的模式省略。Trace capability 元数据包含请求/实际发送的 temperature、JSON 模式以及可选参数降级原因。Qwen 是模型家族，需按实际托管接口和模型能力接入，不能仅凭名字推断。

## 响应契约

`chatResponse()` 返回 `{ text, reasoning, toolCalls, finishReason, usage }`。`chat()` 保持返回最终 text，现有 JSON parser 不变。

- text 来自 content 字符串或 text 类型的内容块；不从 reasoning 猜答案，也不剥离混在文本里的 `<think>` 标签。
- reasoning 从独立 reasoning_content、reasoning 或 reasoning.text 详情归一；缺失为 null。加密详情不解码、不拼入文本。
- toolCalls 归一为 `{id,type,name,arguments}` 数组，arguments 保留原字符串，不执行。当前文本模式收到原生工具调用时报 LLM_INTERACTION_MISMATCH。
- usage 为 `{inputTokens,outputTokens,totalTokens,details}`；缺失计数为 null，details 保留供应商计数供既有 telemetry 使用一次，不重复累计 reasoning tokens。
- native_tools 仅预留响应验证契约；请求阶段明确拒绝，不启用原生工具循环。
- 推理正文不进入 parser、对话历史或现有 trace 内容；现有调试输出仍只记录最终文本。只有显式调用 chatResponse 的代码能取得 reasoning。

## 验证边界

离线测试覆盖请求映射、temperature、未知能力、响应归一、文本/原生工具边界，以及 chat 与 Planner 协议修正的接线。尚未使用真实模型验证供应商行为、延迟或生成质量；不能把测试中的 mock 响应当作线上兼容保证。

参数依据：[DeepSeek](https://api-docs.deepseek.com/guides/thinking_mode/)、[OpenRouter](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)、[Gemini OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)、[Ollama OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)。本地模型及服务版本的支持范围需实际核实。
