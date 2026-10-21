# 可信 reasoning policy

通用 Plan/Build 原生 options 由 provider adapter 处理。这里描述的是额外的、用于限制已确认调用方式的可信 policy；它不会为所有供应商发明一个可自动推断的 thinking 参数。

`LLM_REASONING_EFFORT_PLAN`、`MEMORY`、`BUILD`、`DESIGN`、`ACTION_PLAN` 分别作用于 `plan`、`memory_extraction`、`build_decision`、`design`、`action_plan`。完整变量名都以 `LLM_REASONING_EFFORT_` 开头，接受空值或 `none|low|medium|high`，没有全局 effort。

`LLM_REQUIRE_REASONING_POLICY=true` 时，本次用途没有配置 policy 会在 HTTP 前失败；false 且未配置时沿用普通 adapter 行为。配置本身非法始终报错。强制费用保护和可选的普通 reasoning preference 不能混为一谈：前者是明确启用的执行限制。

当前映射：

- OpenRouter：在原生 options 处理后，替换为 `reasoning: {effort: ...}`，要求路由支持参数。
- 阿里云 capability 表内的模型，只确认 `none`：发送 `enable_thinking=false`，移除 `reasoning_effort` / `thinking_budget`；需要时还设置 `preserve_thinking=false`。
- 未确认的 provider/model/effort 组合不猜参数，显式 policy 报 unsupported。

目的专用 policy 不扩散到其他用途。诊断中的 effective/sent 代表请求实际发送了什么，不代表已经独立验证供应商内部推理行为。切换模型或地区时，需要重新核对能力和价格；输出上限与[费用准入](llm-build-cost-admission.md)仍分别生效。
