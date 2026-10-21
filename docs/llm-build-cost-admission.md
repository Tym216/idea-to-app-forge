# 请求费用准入

费用准入在每次真实模型 POST 前执行，与输出上限、任务租约及 abort 检查共用调用边界。配置是 Worker 启动时的可信输入，不来自用户消息或工具参数。不调用在线价格服务，也不自动提高额度。

## 配置

通用配置使用 `LLM_COST_CURRENCY=USD|CNY`、`LLM_COST_INPUT_PER_MILLION`、`LLM_COST_OUTPUT_PER_MILLION`、`LLM_MAX_THEORETICAL_COST_PER_EXECUTION`，并用 `LLM_REQUIRE_COST_BUDGET=true` 启用强制准入。

旧 `*_USD_PER_MILLION` / `LLM_MAX_THEORETICAL_COST_USD_PER_EXECUTION` 仍可用，但不能与通用配置混用。价格接受有限非负十进制值；强制模式要求完整价格、正数预算和可信输出上限。错误配置在请求前失败。如何修改见[预算配置](llm-budget.md)。

## 估算与预留

```text
input_upper_bound_tokens = final_request_UTF8_bytes + 2048
output_upper_bound_tokens = trusted_output_cap + provider_specific_margin
request_theoretical_max = input_tokens × input_rate / 1,000,000
                        + output_tokens × output_rate / 1,000,000
```

统计完整最终 JSON body，不按字符数除以经验比例。当前阿里云受支持映射额外预留 10 个输出 token；OpenRouter 映射使用其可信 cap。该方法是依赖已确认价格与上游执行语义的保守暴露模型，不是精确 tokenizer、实际账单或对所有模型的数学费用保证。

内部使用 BigInt 有理数和 1e-12 货币单位，单项费用向上取整、预算向下取整。每个 `(task_id, execution_id)` 共用一个进程内 ledger：同一次执行中的 Design、Plan、Build、Memory 等实际调用共用额度；具体发生哪些用途由任务路径决定。

每次物理请求，包括 retry，都先同步检查并预留全额；超时、短回复或缺失 usage 不退还预留。没有 await 的检查/扣减避免同进程竞争。新 execution 有新预算，所以它不是整个项目的累计消费上限，也不包含沙箱/托管费用。ledger 不作为跨进程持久账本；进程内同一执行不能中途换价格或重置额度，正常接管使用新的 execution identity。

## 不可绕过的边界

- 只有具有任务/执行身份、有效检查函数和 abort signal 的上下文才能进行强制预算生成。
- 最终 body 必须匹配可信输出映射，不能用 caller/native options 提高 cap。
- 支持的阿里云模型要求可信 reasoning `none`；OpenRouter 要求支持所需参数，不能自动猜测未确认的计费维度。
- 直接 operator 生成没有任务级预算，required 模式下被拒绝；只读 doctor 配置投影和模型列表查询仍可用。
- 超出预算的请求在发送前报 `LLM_COST_BUDGET_EXCEEDED`。诊断分别保留理论预留和基于 usage 的费用估计，二者都不替代供应商账单。

代码入口为 `llm-cost-admission.js` / `llm.js`。离线回归覆盖缺配置、最终 body、caller 覆盖、精度与币种、物理 retry、共享 ledger、超预算零请求和 operator 绕过；这些测试不证明任意路由的实际价格或 cap enforcement。
