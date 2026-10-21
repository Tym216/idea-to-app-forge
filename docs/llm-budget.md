# 模型预算保护与配置

`LLM_COST_BUDGET_EXCEEDED` 由 Forge 在请求发送前产生，表示下一次请求会超过本次 execution 的累计理论费用上限。它不是供应商余额不足、单次请求价格限制，也不是供应商账单。

## 如何调整

修改 Worker 实际通过 `FORGE_ENV_FILE` 加载的私密配置文件（不要提交该文件），例如：

```ini
LLM_REQUIRE_COST_BUDGET=true
LLM_COST_CURRENCY=CNY
LLM_MAX_THEORETICAL_COST_PER_EXECUTION=2.00
```

`2.00` 是可选的测试上限示例，不会由代码自动应用。保留当前模型对应的 `LLM_COST_INPUT_PER_MILLION` / `LLM_COST_OUTPUT_PER_MILLION`；不要为了放行请求而改低单价。旧 USD 配置使用 `LLM_MAX_THEORETICAL_COST_USD_PER_EXECUTION`，不要混用两套配置。

修改配置后，等待当前执行结束，停止旧 Worker，确认没有残留实例，再使用相同的显式 env 启动一个 Worker。配置不会热更新；失败任务不会自动恢复。需要继续时由用户选择恢复，保留已确认的源码和进度。

## 预算与实际用量为什么不同

每次物理请求（包括网络重试）都按完整请求 UTF-8 字节数加安全余量估算输入 token，并按最大允许输出预留费用。短回复的实际 token 通常更少，但现有硬保护不退还预留，也不把超时或缺失 usage 当成免费请求。

因此这是一条保守的执行级硬上限。Plan 和 Build 是各自的 task/execution；同一次 execution 内各 purpose 共用预算。授权恢复后新 execution 有独立预算，并非整个项目的累计消费封顶。它也不包含沙箱等基础设施费用。

实际 token 费用估计在 `usage_cost_estimate` 中单独记录，理论预留在 `llm.cost_admission` 中记录。两者都不能替代供应商账单。当前不自动加预算，也不使用平均 token 比例放宽硬保护；更精确的放行需要已验证的模型 tokenizer/计费边界，以及对缺失用量、超时、并发和重试的保守处理。
