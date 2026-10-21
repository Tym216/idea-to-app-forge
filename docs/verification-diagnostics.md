# 验收结果与诊断

HTTP-only 模式不执行浏览器渲染或交互检查，acceptance 的 `inconclusive` 表示未得到证据，不是 assertion false，也不是功能通过。仅凭跳过这些检查不会阻断；真实 HTTP/入口错误和显式启用的纯逻辑断言失败仍会阻断。

`verify_report` 保存检查模式、基础证据、acceptance items、纯逻辑结果和工具故障。任务提示区分 HTTP、逻辑断言、浏览器检查及证据不足；详细 expected/actual 保留在开发者诊断中。旧报告缺少逻辑结果时，UI 可读取既有 `logic_check.result`，但不修改历史任务或证据。

浏览器模式下，核心流程的明确 assertion failure 是 blocker；细节偏差可以是 warning；缺少可靠证据才是 inconclusive。模型编写的补充逻辑测试失败，首先表示代码与测试不一致，还需要核对测试前置条件、输入和产品规则，不能直接推断测试一定正确，更不能删断言或弱化已批准的 acceptance 来通过。

结果与发布边界：

- passed：当前检查实际通过，仍不表示应用不存在其他缺陷。
- warning / inconclusive：可以创建带标记版本，不能显示“全部功能已验收”。
- blocker / tool_error：不发布可用 checkpoint，保留源码及诊断。

Agent 的明确阻断问题可按[一次受限修复](verification-repair.md)继续；User Apply / Restore 保持确定性、零 LLM。离线回归覆盖历史报告兼容、跳过浏览器检查、实际 blocker 的证据传播，以及失败时不进入正常版本发布。
