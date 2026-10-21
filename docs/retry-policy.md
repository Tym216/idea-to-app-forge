# 重试、修正和恢复

这些机制分别解决不同问题，不是一个无限重试循环。Provider 错误统一从 `classifyProviderError` 分类，不在 Agent 各工具内散落供应商判断；当前不会自动换模型。

## Provider retry

- 已知瞬时连接错误、HTTP 408、500/502/503/504，以及排除额度错误后的 429，最多重发一次。
- 余额/额度不足、鉴权或配置错误、完整请求超时、不可用输出和未知错误，不用同一机制盲重发。
- 普通瞬时错误等待 300–600ms；限流等待 1500–1800ms。有更长 Retry-After 时遵守，但超过 5 秒直接停止，不提前发送。
- 同一个序列化 body、模型和共享 deadline，最多两个物理请求；默认模型时限 120 秒，短修复调用可进一步缩短。等待及每次派发都检查 abort / 租约。

供应商可能已处理断开的请求并计费，不能保证上游恰好一次。未知 usage 不填零；强费用保护对每个物理请求分别预留。

## 协议修正

Design / Plan / Build 的输出无法解析或缺必要字段时，最多携带具体反馈修正一次，这是新的逻辑调用。输出截断不能执行半份文件，修正应要求更小且完整的动作，不能自动提高输出或费用额度。

设计审美、间距或对比度不理想只提示并继续，不重生成整个 Design。设计仍需满足可执行的结构与类型。保存设计约定失败按持久化问题处理，不能冒充 DESIGN_INVALID 再生成；事后可选记忆失败记 warning，执行许可或租约失败仍必须传播。

## Runtime recovery

文件部分写入、状态未知或命令超时，先核对原操作、进程及 canonical manifest，再决定是否续接。租约过期不等于远程副作用结束。受控写入复用 ChangeSet reconcile；普通 runtime 恢复的生命周期证明见[运行恢复](build-runtime-recovery.md)。不能手改 writer / revision 或直接重复命令来解锁。

## Agent repair

构建错误与功能断言提供新证据时，Agent 可在原预算内修代码。明确验收 blocker 另有[一次受限快速修复](verification-repair.md)：准入、4 次模型调用、90 秒决策/派发预算和持久化标记分别生效，不会因暂停或重启无限刷新额度。同一任务验收次数上限仍为两次，不能重复验收相同源码，也不能放宽已批准的标准。User Apply / Restore 保持零 LLM。

HTTP-only 模式未运行浏览器检查时是 inconclusive，不冒充 assertion false；真正核心断言失败仍阻断。辅助功能失败不应掩盖实际主流程故障。

## 观测与兼容性

Telemetry 区分 logical model turns 和 physical provider requests；每次物理请求有独立 request ID、attempt 和共享 logical-call ID。未知用量保留缺失状态。指标标签由运行配置决定，不能只凭历史版本标签推导收益。

已复现的 `glm-4.5-air` JSON mode 兼容问题由 adapter 明确处理：即使配置 on 也不发送 `response_format`；`glm-4-plus` 在 auto 下也省略。仍要求模型返回 JSON 并校验协议，不将错误文件名自动猜成另一个路径。其他模型不能据此推断同样行为。

离线回归证明分类、上限、payload、状态和取消边界；不证明上游未来可用性、任意模型成功率或成本收益。ObservationPack 完整压缩、小模型决策替换及自动模型 fallback 不属于当前已完成能力。
