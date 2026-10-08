# Main Stage B operational proof — STOP / NO-GO

日期：2026-10-08。候选代码 `e8eaaa6e74c53176e9edc905639d274b832d86c5`。本轮授权范围仅 freeze → quiescence → paused source preservation → T0 backup → restore validation；0006/deploy/unfreeze/Phase 3 未批准。

## 实际执行与停止原因

1. Main `vfzyimhapttcdxeabvur` strict-TLS ACL capture **PASS**：32 项 authenticated grants，涉及 ita_memories/messages/projects/tasks 的写权限与 13 个 function EXECUTE。未包含 SELECT。
2. Main freeze、独立 verify、canary-only **PASS**。管理员通道保留，普通客户端 table/column mutation 与 ita RPC EXECUTE 已关闭。
3. 冻结后模拟真实 authenticated 用户读取，检查脚本返回 **42501**。按执行顺序，project count 已完成，task count 失败；后续 plan/file SELECT 尚未运行。
4. 定向查看捕获 ACL 与既有 0001 RLS 确认：`ita_owns_project` 也被 gate 撤回 EXECUTE；task/files/messages/memory 等 RLS 依赖这个只读归属检查函数。Gate 没有区分 mutation RPC 与 SELECT policy helper。原 disposable smoke 只验证 project GET（其 SELECT policy 没有这一依赖），未覆盖 task/files。

这是一项 **ingress gate/read-access contract mismatch**。按照批准范围的立即 STOP 规则，没有继续远程 session 查询、physical source 导出、备份或恢复。没有修改 gate 逻辑，没有补 GRANT，也没有执行 unfreeze。

**当前 Main 仍冻结。部分普通用户读取也会因 RLS helper EXECUTE 被撤回而失败。** 保持这个状态等待用户决定下一次窄修复授权；不能声称 read-only 功能已保留。

## 保存位置与数据状态

- ACL 恢复清单及对应 freeze/unfreeze SQL：ignored `app/worker/.cutover/stage-b-2026-10-08/main-ingress.json` 及同名前缀 SQL。未覆盖 Stage A 或 disposable rehearsal 记录。
- 仅本轮明确执行的 ACL freeze 改变了 Main 权限；没有修改任务、计划、源码、revision、journal 或 sandbox lifecycle。
- Paused task 仍不 resume、不修改；physical manifest 尚未读取，因此没有新增 preserved/matched 结论。
- Stage B inspector 在 DB 读取错误处停止，未到达本地进程扫描或 Daytona session 读取；Stage A 的 process=0/sandbox 状态不能冒充本轮 quiescence 证明。
- 没有 T0 backup、restore archive 或 restore result。Local logs/ACL capture 不是 DB backup。
- revised 0006 SHA256 保持 `5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782`，未执行 Main migration。

## 最终清单

| 项目 | 状态 | 证据/边界 |
|---|---|---|
| ingress actually frozen | PASS | capture/freeze/verify/canary-only 成功 |
| read-only access retained | FAIL | authenticated task SELECT 42501；RLS helper 被 gate 关闭 |
| all old workers stopped | UNKNOWN | 本轮检查尚未完成；Stage A 无进程不是当前重新验证 |
| remote side effects quiesced | UNKNOWN | 尚未查询 session/command/upload，不靠 stopped/archived 推断 |
| paused physical source preserved / discrepancy | UNKNOWN | 未读取；没有修改或恢复任务 |
| T0 backup created | NOT RUN | 前置条件未通过 |
| backup manifest/hash verified | NOT RUN | 没有 backup |
| restore completed | NOT RUN | 没有写 restore-test |
| restored schema/data/hash validated | NOT RUN | 没有 restore |
| rollback point genuinely usable | UNKNOWN | 尚无经过真实恢复验证的 T0 |
| revised 0006 artifact unchanged | PASS | hash 与已验证版本一致 |
| matching Worker artifact ready | PASS | Stage A 固定候选及 byte-identical Worker validation |
| controlled canary path ready | PASS（procedure） | 管理权限检查完成、gate canary-only 成功；没有创建 canary task |

**总体 NO-GO。** Main 保持冻结；没有 Main 0006、新 Worker deployment、push、unfreeze 或 Phase 3。

建议下一轮只修 operational gate：明确保留经验证只读的 `ita_owns_project(uuid)`，继续关闭所有 mutation RPC；调整 effective freeze verification；补 authenticated task/plan/files/messages 等真实读取和 mutation 拒绝回归。验证并获得窄 Main 修复授权后，再恢复这一 helper 的原有 EXECUTE，独立确认普通用户仍无法 build/resume/retry，同时只读查询已恢复，然后重新开始 Stage B quiescence。不要泛化开放所有 SECURITY DEFINER/STABLE 函数，不要为了恢复读取解除整个 freeze。
