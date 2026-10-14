# 阿里云模型切换与成本检查

本轮接入百炼 OpenAI-compatible Chat Completions，复用现有 Plan/Build、响应归一、有限 Provider Retry 和成本 admission。没有改 Agent 工具协议，没有接 Anthropic Messages 接口。

## 本地候选配置

已生成 ignored 的 `app/worker/.env.demo.aliyun`，保留 Demo Supabase / Daytona / execution guards。原 `.env.demo` 未修改；填好 Key 前不切换或启动第二个 Worker。API Key 只填候选文件里的 `LLM_API_KEY=`，不填前端、不提交 Git。

核心配置：

```ini
LLM_PROVIDER=aliyun
LLM_MODEL=qwen3.8-flash
LLM_BASE_URL=https://ws-6oyx8956atm6ogpw.cn-beijing.maas.aliyuncs.com/compatible-mode/v1
LLM_API_KEY=
LLM_JSON_MODE=off
PLAN_PROVIDER_OPTIONS={}
BUILD_PROVIDER_OPTIONS={}
LLM_COST_CURRENCY=CNY
LLM_COST_INPUT_PER_MILLION=0.8
LLM_COST_OUTPUT_PER_MILLION=2.7
LLM_MAX_THEORETICAL_COST_PER_EXECUTION=0.50
LLM_REQUIRE_COST_BUDGET=true
```

候选配置对 Design / Plan / action_plan / build_decision 显式设置 4096 输出上限，Memory 1024；各用途 trusted reasoning 为 none，映射到 `enable_thinking=false`。保留原来的 temperature omission 与 JSON mode off，先用同一模型家族测试托管接口差异。需要测试 temperature 或 JSON mode 时再单独调整，避免一次改变太多变量。

Key 填写后，先只读诊断（GET 模型列表，不产生生成费用）：

```bash
cd /home/brilliant-tai/idea-to-app_v0.75/app/worker
FORGE_ENV_FILE="$PWD/.env.demo.aliyun" npm run doctor:llm
```

列表接口不支持时只能报告 unknown，不能据此声称模型调用通过。当前强成本 guard 不允许 `smoke:llm` 绕过执行预算直接推理；后续使用受控的新项目正常产品流程测真实请求。正式切换前确认旧 Worker 无执行中的任务并停止它，然后只启动一个新进程：

```bash
FORGE_ENV_FILE="$PWD/.env.demo.aliyun" npm start
```

不要在同一 shell 留下其他模型的 `LLM_*` / provider 配置；现有 loader 的进程环境优先规则仍有效。不要把候选文件合并进 Main `.env`。

## 模型与参数边界

本地已确认参数映射的 Alibaba-hosted IDs：`qwen3.8-flash`、`qwen3.8-max`、`deepseek-v4-pro`。API 接入可以选择其他明确模型，但强输出 / reasoning guard 遇到未登记映射会在 HTTP 前拒绝；第三方命名空间别名不继承能力。

这些模型使用 `max_completion_tokens` 限制思考与回答的总输出，费用预留额外计入文档说明的 10-token 容差。可信 none 覆盖可选 native enablement，不携带 OpenRouter `provider` / `reasoning` 字段。更高 trusted reasoning 档位本轮没有映射；可选原生 `enable_thinking` 不等于已验证的 Build Thinking 流程。

DeepSeek 在百炼上的参数以百炼文档为准，不能使用 `LLM_PROVIDER=deepseek` 配合百炼 URL 冒充直连 DeepSeek。换模型时必须一起更新该地域、输入档位适用的价格上界；不能沿用 Flash 单价。此 URL 的 `apps/anthropic` 是另一协议，本轮不使用。

## 成本

2026-10-14 核对的北京 qwen3.8-flash 原价为输入 ¥0.8 / 百万 tokens、输出 ¥2.7 / 百万 tokens。估算公式：

```text
人民币估算 = 输入 tokens / 1,000,000 × 0.8
           + 输出 tokens / 1,000,000 × 2.7
```

例：合计 100,000 输入 + 20,000 输出约 ¥0.134。这里的合计包含所有模型调用；不能只数最终生成代码。缓存命中、活动优惠、资源包不用于上界预留；供应商账单仍是最终依据。

`LLM_COST_CURRENCY` 与通用单价/预算一起使用，不允许混入旧 `*_USD_*` 字段。未使用通用价格配置时，旧美元配置照常有效。日志新增 `usage_cost_estimate`（按真实返回 tokens 和配置价格计算，明确不是账单），以及带 `cost_currency` 的 theoretical admission。

候选的 ¥0.50 是每个 execution 的保守理论暴露预算，按完整 UTF-8 请求体与输出上限预留；每次 physical retry 再预留一次，没有退款。它可能先于实际账单达到上限，不代表单个完整项目必定能在 ¥0.50 内完成。Resume 新 execution / Worker 重启不是持久化项目总账；平台费用限额仍应另设。本轮没有自动提高任何预算。

## 验证范围

本地离线测试覆盖 endpoint、Key 缺失、请求参数、响应归一、五个用途、重试逐次预留、货币隔离、费用估算及旧供应商回归。2026-10-14 用户填写 Key 后，真实只读模型列表鉴权通过，qwen3.8-flash 已列出；唯一 Demo Worker 已从 OpenRouter 切换至显式 .env.demo.aliyun，并通过正常 schema/preflight、开始轮询。尚未发出真实生成请求，实际 cap enforcement、延迟、稳定性和生成质量仍待正常任务验证；未修改 Main / restore-test，未部署或 push。另一个 uncertain 项目的 retained writer 原样保留，没有恢复或解锁。

依据：[Chat Completions 参数](https://help.aliyun.com/en/model-studio/qwen-api-via-openai-chat-completions)、[Qwen3.8-Flash 北京价格](https://help.aliyun.com/zh/model-studio/qwen3-8-flash)、[思考模式](https://help.aliyun.com/zh/model-studio/deep-thinking/)。
