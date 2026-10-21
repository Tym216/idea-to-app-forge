# 历史资料索引

这些文件保留原有路径，供理解此前的迁移和验证过程；不是当前 Demo 的安装清单或待办。Main production cutover 与 Demo delivery 是分开的工作，不能照历史 runbook 操作 Main。历史 artifact 的验证结果也不能用于不同版本的 SQL。

## Main baseline 与 operational proof

- [Baseline reconciliation](main-baseline-reconciliation.md)
- [Operational status](main-cutover-operational-status.md)
- [Main runbook](main-cutover-runbook.md)
- [Stage A](main-cutover-stage-a.md)
- [Stage B](main-cutover-stage-b.md)
- [只读 catalog SQL](main-cutover-preflight.sql)

## Workspace 协议迁移证据

- [初版 disposable rehearsal](workspace-cutover-validation.md)
- [Privilege hardening 阶段记录](workspace-privilege-hardening-validation.md)
- [Revised 0006 fresh rehearsal](workspace-cutover-validation-v2.md)
- [0006 旧库切换流程](workspace-cutover.md)
- [早期 Action Fusion 契约](action-fusion.md)：其 journal 描述已有历史标识，当前源码协议以 workspace contract 为准。

各文件保留当时的细节和结论，不将过期的测试计数、运行状态或授权限制改写成新的验证结果。当前产品行为以根 README、当前代码和文档导航中的机制说明为准。
