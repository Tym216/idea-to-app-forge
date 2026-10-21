# Temperature 的实际发送

`PLAN_TEMPERATURE` / `BUILD_TEMPERATURE` 表达调用期望，provider adapter 根据已确认能力决定是否发送。`LLM_OMIT_TEMPERATURE=true` 是额外的可信配置，明确要求最终请求不带 temperature；空值或 false 保留普通 adapter 行为。

变量只接受严格的 true / false；非法配置不静默降级。最终 omission 条件是“provider capability 要求省略”或“可信配置要求省略”，在原生 options 处理后删除字段，不用 null / 0 代替。调用参数不能取消该要求。

诊断同时显示 requested、effective、是否省略及原因（capability、config 或两者）。省略意味着使用供应商默认采样方式，不表示这个模型普遍不支持 temperature。只读 `doctor:llm` 使用同一配置解析；物理 retry 复用同一序列化 body。

它不修改模型、reasoning、输出上限或费用额度，也不能独立证明某条上游路由的实际温度行为。运行配置需要重启 Worker 才生效，不能从旧的本地模型对照实验推断当前环境值。
