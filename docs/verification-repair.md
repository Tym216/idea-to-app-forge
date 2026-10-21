# 一次受限的验收修复

用户界面将可继续处理的验收停止呈现为“有待完善项”，同时保留源码、预览地址及原始诊断；技术失败状态不被改写，也不伪造 checkpoint。

只有 Agent Build、confirmed 且无 writer 的 workspace、已保存的 blocker、剩余验收机会，并且任务尚未开始过该修复，才允许进入。准入标记先写入 task.steps，再调用模型；pause / resume / Worker 重启不会刷新这次自动修复额度。User Apply / Restore、工具故障、未确认副作用、丢失租约和单纯证据不足不进入模型修复。

限制为最多 **4 次额外逻辑模型调用**（包括协议修正）、共享 **90 秒决策/派发预算**，同时保留已有费用保护和同一任务最多两次验收。请求 timeout 只能缩短为剩余时间，不能扩大配置额度。工具和自动 pipeline 在安全边界检查预算；已发出的远程操作仍要等待并核对，因此不承诺整个恢复墙钟时间严格小于 90 秒。任意 run_command 不在短修复允许范围内。

模型依据实际失败证据做小幅修正，不能改已批准的 acceptance、删失败检查或重复验收无变化源码；规则冲突需请求修订。再次 blocker 或耗尽额度就停止。固定检查得到可发布结论后直接进入正常 checkpoint，不再多调用一次模型 finish，并跳过可选记忆抽取，避免附加长请求。warning / inconclusive 如实标记，blocker / tool_error 仍不发布。

实现见 `verification-repair.js`、`agent.js` 及对应离线测试；这是一项执行机制，不是对生成应用质量或真实耗时的保证。
