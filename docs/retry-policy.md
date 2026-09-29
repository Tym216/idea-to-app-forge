# Retry v1：分类处理，限制自动重发

只修改 Worker，无新依赖、数据库迁移或前端操作。保留 `.env`，停止旧 Worker，再从 `app/worker` 运行 `npm start` 加载更新。

## 处理边界

| 情况 | 处理 |
|---|---|
| 设计对比度、间距不理想 | 保留生成值，warning 后继续，不重新生成或自动换色 |
| Design / Plan / Build 输出无法解析或缺必要字段 | 最多一次协议修正，仍不合法则停止 |
| 保存设计约定失败 | 按存储错误停止，不归为 DESIGN_INVALID、不重生成 |
| 事后辅助记忆抽取、保存失败 | warning；不改变已完成的主要工作，不发起语义修复 |
| 暂停、取消、租约失效、执行许可检查失败 | 停止，不能作为辅助错误吞掉 |
| 命令超时 | 查询进程辅助诊断，以 COMMAND_UNCERTAIN 停止，不重放 |
| 文件写入未确认 | 沿用 durable intent 和 reconcile，先核对再继续 |
| 构建/浏览器功能失败 | 保留原有修复预算与停止机制，本轮不扩展 Agent Repair |

接受低对比度不代表符合可访问性要求。设计仍需满足生成 CSS 所需的结构和类型。辅助记忆批次不是事务，失败前已保存的项保留；保存设计约定属于任务的持久化契约，与可选的事后抽取分开处理。

## Provider 统一入口

`provider-retry.js` 的 `classifyProviderError` 返回 `retry_once` 或 `fail` 及原因；`withProviderRetry` 管理等待、预算与取消；`llm.js` 转换供应商错误并记录每次请求。以后 fallback 应从该入口扩展，不散落在工具中。本轮不自动切换模型。

- **允许一次重发**：已知连接中断/临时 DNS 或连接错误、HTTP 500/502/503/504、明确限流或带 Retry-After 的 429。
- **不重发**：额度/余额不足（含智谱 1113）、402、鉴权/配置错误、未知 429、请求超时、空或不可用的模型返回。额度判断优先于 Retry-After。
- **等待有界**：失败后等待 300–600ms 随机抖动；Retry-After 更长则遵守，但超过 5 秒直接停止，不提前发送。
- **共享预算**：相同请求体、同一模型，最多两个实际请求共享 120 秒截止时间。预算不足不继续，重发前复查暂停与租约，等待期间可中止。
- 已等满 120 秒的免费模型调用不会自动再等 120 秒。本轮不解决模型长期慢或不可用的问题。
- 中断请求可能已被供应商处理和计费，无法保证供应商恰好执行一次。没有 usage 就保留未知。

协议修正携带新的校验反馈，计作新的逻辑调用；Provider 重发属于同一逻辑调用。两层预算分别生效：允许一次协议修正的阶段，最多两次逻辑调用、四次实际请求。任务总超时及执行许可仍约束整个流程。

## 测量与验证

`logical_model_turn_count` 记录逻辑调用，`model_request_count` 记录实际发送（含失败/重发）。每条 `model.request` 和 Langfuse generation 带 `logical_call_id`、`attempt`、独立 `request_id`；重发产生另一条 generation，不覆盖第一次记录。未知用量不填 0，部分合计标记 `usage_incomplete`。模型请求耗时不含退避，任务耗时包含等待。旧日志没有逻辑计数时报告未知/不完整，不倒推。

代码标识默认 `retry-v1`；若现有 `.env` 显式设置了 `METRICS_CODE_VERSION=fusion-v1`，会覆盖默认值，做对比前请手动更新该标签。对比 Fusion 开关时使用相同 retry 策略、供应商、模型和初始条件。此前两次调用、约 44 秒、未进入 Build 的设计失败保留为设计阶段故障样本，不纳入 Build 性能对照。

```bash
cd /home/brilliant-tai/idea-to-app_v0.75/app/worker
npm test
npm run check
npm run metrics:compare -- /tmp/forge-baseline.log /tmp/forge-fusion.log
```

本轮以模拟模型、数据库和沙箱验证原配色一次通过、存储错误分类、控制错误不吞、重发上限/共享预算、暂停/租约阻断、逻辑/物理计数、命令超时不重放。没有调用真实模型、Daytona 或 Langfuse Cloud，真实成功率和成本收益仍待验证。

## 当前限制与后续

浏览器首次验收失败仍停止，由用户决定是否继续；累计验收次数上限不变。通用 shell 命令尚无自动结果核对协议，COMMAND_UNCERTAIN 后需人工核对沙箱日志与操作结果再决定继续。“恢复任务”不代表已证明可以安全重放命令，文件写入的 reconcile 不覆盖任意 shell 副作用。

下一阶段才按真实证据调整 Agent Repair，不能仅因代码文本改变就无限修复，也不放宽已批准验收。ObservationPack、模型 fallback、小模型替换未在本轮实现。

## 智谱 JSON 模式兼容

用户对照测试已复现 glm-4.5-air 在 response_format=json_object 下输出错误文件名 package.，不带该字段时正常。auto 因此对 glm-4-plus / glm-4.5-air 不发送 response_format，保留提示词 JSON 要求和协议校验，temperature 不变。显式 ZHIPU_JSON_MODE=on 会强制启用，部署请使用 auto 或 off。此例外只针对已确认模型，不推断其他模型同样存在问题；真实任务的整体成功仍需复验。
