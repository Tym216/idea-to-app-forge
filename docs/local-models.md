# 本地模型与 DeepSeek 响应边界

Ollama / LM Studio 共用现有 OpenAI Chat Completions 客户端、暂停/租约控制、请求统计和 Langfuse，不引入 SDK 或额外 Agent。无需迁移和 npm install；配置后重启 Worker。

## Ollama

在 Worker 的 `app/worker/.env` 中填写，MODEL 使用 `ollama list` 中已下载的完整模型名：

```ini
LLM_PROVIDER=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434/v1
OLLAMA_MODEL=你的已下载模型名
OLLAMA_JSON_MODE=off
```

先让 Ollama 服务运行、模型可用，再运行 `npm run doctor` 做实际连通测试，然后 `npm start`。本地 Ollama 不需要 Key；可留空 `OLLAMA_API_KEY`，此时请求不发送 Authorization。使用需要鉴权的兼容网关时可填写该项。

## LM Studio

下载/加载模型，在 Developer 页面启动 API Server，复制 `/v1/models` 返回的模型 ID：

```ini
LLM_PROVIDER=lmstudio
LMSTUDIO_BASE_URL=http://127.0.0.1:1234/v1
LMSTUDIO_MODEL=你的模型ID
LMSTUDIO_JSON_MODE=off
```

默认无需 Key；若开启 Require Authentication，填 `LMSTUDIO_API_KEY=你的API Token`。这两个 BASE_URL 都需要带 `/v1`，不要再带 `/chat/completions`，Worker 会添加后者。

地址相对 **Worker 运行环境**：Worker 在 WSL、模型服务在 Windows 时，127.0.0.1 是否可达取决于 WSL 网络设置。若 doctor 连接失败，请使用该环境能访问的 Windows 服务地址，并检查服务监听设置。Daytona 不需要连接本地模型，模型请求由 Worker 发起。现有请求超时预算不变，模型冷启动或长上下文生成仍可能超时。

JSON_MODE 默认 off，仅靠提示词及现有解析校验；确认特定模型的 json_object 兼容性后才设 on。缺模型名拒绝启动；本地免 Key 不改变云端供应商必填 Key 的规则。

## DeepSeek thinking

不自动开关 thinking，也不添加 reasoning_effort。本轮保留供应商默认行为。Forge 使用文本 JSON 模拟工具调用，没有发送原生 tools；现有代码只读取 `choices[0].message.content`，不拼接 reasoning_content，不将其回传历史，也不会在 content 为空时用推理内容兜底。

新增诊断识别 reasoning_content，Langfuse 元数据记录是否存在推理内容；原有 usage 已保留供应商返回的推理 token 细分。没有上传完整推理文本。LLM_FORMAT_STALLED 表示最终 content 无法解析或不符合工具协议，不足以证明 thinking 导致失败。步骤日志现在显示协议校验原因；结合该调用的 content 与 finish_reason 区分截断、JSON 错误、缺字段/未知工具。

这部分规则与当前 DeepSeek 官方文档一致：thinking 开启时 temperature 被忽略；未发送 tools 时无需回传 reasoning_content；JSON 模式要求 response_format=json_object 和 JSON 提示词。JSON 模式可能出现空 content，仍应明确报错而非用推理文本执行操作。

## 验证边界

测试拦截真实客户端发送的 HTTP 请求，覆盖两个本地供应商无 Key/可选鉴权、模型名校验、端点拼接、云端权限要求，以及 DeepSeek content/推理隔离。没有调用真实本地模型或 DeepSeek 验证生成质量，也没有测量速度/显存占用。

参考：[Ollama OpenAI compatibility](https://docs.ollama.com/api/openai-compatibility)、[LM Studio compatibility](https://lmstudio.ai/docs/developer/openai-compat)、[LM Studio authentication](https://lmstudio.ai/docs/developer/core/authentication)、[DeepSeek thinking](https://api-docs.deepseek.com/guides/thinking_mode/)、[DeepSeek JSON](https://api-docs.deepseek.com/guides/json_mode/)。
