# 阿里云接口与成本配置

阿里云入口复用 Chat Completions adapter、响应归一化、Provider Retry 和费用准入，不改变 Agent 的 JSON action 协议。当前没有接入 Anthropic Messages 协议；`apps/anthropic` 不能当成兼容模式地址使用。

## 配置

在 Worker 实际加载的完整私密 env 中配置，不能放进前端或提交到 Git：

```ini
LLM_PROVIDER=aliyun
LLM_BASE_URL=https://YOUR_ALIYUN_ENDPOINT/compatible-mode/v1
LLM_MODEL=YOUR_AVAILABLE_MODEL_ID
ALIYUN_API_KEY=YOUR_MODEL_KEY
LLM_JSON_MODE=off
PLAN_PROVIDER_OPTIONS={}
BUILD_PROVIDER_OPTIONS={}
```

URL、Key、模型及价格必须对应自己账号可用的地域和接口。通用 `LLM_API_KEY` / `LLM_BASE_URL` / `LLM_MODEL` 非空时优先于供应商专用配置；进程已有变量优先于文件值，切换前避免遗留其他模型的 `LLM_*`。显式 env 还必须包含根 README 要求的环境身份、Supabase 和 Daytona 配置，不能只填写这里的模型片段。

```bash
cd app/worker
FORGE_ENV_FILE="$PWD/.env.demo" npm run doctor:llm
# 确认旧 Worker 已结束且无未收尾操作后，才启动单个实例：
FORGE_ENV_FILE="$PWD/.env.demo" npm start
```

模型列表接口不支持时，doctor 只能报告 unknown，不能当作生成成功。强制费用保护下，不带任务级执行预算的 `smoke:llm` / doctor 生成不能绕过保护；只读配置和模型列表查询仍可用。

## 参数与模型能力

当前本地 capability 表支持 Alibaba-hosted 的 `qwen3.8-flash`、`qwen3.8-max`、`deepseek-v4-pro`；这是映射范围，不是账号可用性或每个模型的完整 E2E 保证。其他模型名不自动继承可信能力。

已确认模型使用 `max_completion_tokens` 映射可信输出上限，费用预留额外计入 10-token 容差。可信 reasoning `none` 映射到 `enable_thinking=false`，需要时设置 `preserve_thinking=false`，不会携带 OpenRouter 路由字段。更高可信 reasoning 档位未映射；普通原生 thinking 参数可被 adapter 处理，不代表 Build Thinking 协议已经支持。

在百炼调用 DeepSeek 仍应使用 `LLM_PROVIDER=aliyun`，不能把直连 DeepSeek 的参数和成本假设照搬到托管接口。切换模型时，应同时确认其输出、推理、地域和计费边界。

## 费用

使用 `LLM_COST_CURRENCY=CNY` 及通用输入/输出单价、执行预算字段；价格需要操作者按实际模型、地域、输入档位重新核对。仓库的样例值不是实时价格，也不表示供应商余额。

```text
usage 费用估计 = input_tokens × input_rate / 1,000,000
              + output_tokens × output_rate / 1,000,000
```

真实 token 用量估计与发送前的保守费用预留分别记录。超时或缺少 usage 不能当作免费；调整输出 cap 不会自动提高执行预算。具体规则见[费用准入](llm-build-cost-admission.md)和[预算配置](llm-budget.md)。Daytona 与托管费用不在这个 ledger 内。
