# 文档导航

第一次看项目，先读[根 README](../README.md)：体验、启动、配置和限制都在其中。这里保留需要进一步理解的运行说明与关键实现边界，不要求逐篇阅读。

## 运行与配置

| 需求 | 文档 |
| --- | --- |
| 选择供应商、请求与响应适配 | [Provider capabilities](provider-capabilities.md) |
| 使用阿里云接口 | [阿里云配置](aliyun-provider.md) |
| Ollama / LM Studio 与 DeepSeek | [本地模型](local-models.md) |
| 理解费用保护、如何调上限 | [预算配置](llm-budget.md) |
| 定位超时与请求参数 | [LLM diagnostics](llm-diagnostics.md) |

## 关键机制

| 关注点 | 文档 |
| --- | --- |
| workspace revision、源码与写入资格 | [Workspace contract](phase2-workspace-contract.md) |
| App 版本身份与业务数据隔离 | [App Version / App state](app-version-and-platform-state.md) |
| 预览启动与有限加载恢复 | [Preview recovery](preview-load-recovery.md) |
| 执行中断后为何要先核对 | [Runtime reconciliation](build-runtime-recovery.md) |
| 验收结果如何解释 | [Verification diagnostics](verification-diagnostics.md) |
| 一次短修复的预算与停止条件 | [Bounded repair](verification-repair.md) |
| 精简上下文、合并操作与纯逻辑检查 | [Reliability and latency](generation-reliability-and-latency.md) |
| 传输重试、协议修正和恢复区别 | [Retry policy](retry-policy.md) |

## 模型保护的实现细节

[输出上限](llm-output-cap.md)、[输出截断](llm-output-truncation.md)、[费用准入](llm-build-cost-admission.md)、[可信 reasoning policy](llm-reasoning-policy.md)、[temperature omission](llm-temperature.md)说明实际约束；不是供应商计费保证或自动提升预算的机制。

## 历史资料

[历史资料索引](history.md)保存此前的 Main 迁移预案和测试证据。里面的 PASS / NO-GO 都有原来的环境、artifact 与时间范围，不代表今天服务健康，也不授权执行其中的运维命令。未提交的 review 草稿、凭据和本地运行证据不在交付范围内。
