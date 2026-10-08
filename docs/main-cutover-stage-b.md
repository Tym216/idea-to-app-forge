# Main Stage B operational proof — STOP / NO-GO

> 最新状态：narrow gate repair 已 PASS；Main 只读访问恢复、mutation 仍冻结。Stage B 在远程 quiescence 查询不可用处再次 STOP。下面原 freeze 回归结果保留历史，当前清单以末尾更新为准。


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

## Narrow ingress-gate repair 与继续检查（2026-10-08）

Root cause：旧 gate 把所有 Forge function EXECUTE 当成 mutation RPC，连 SELECT policy 所调用的归属 helper 一起关闭。只验证 project GET 没有触发 task/files 的这条 RLS 依赖，导致原 smoke 漏检。

实际 Main `pg_depend` 已遍历所有 Forge policy：仅依赖平台 `auth.uid()` 和 Forge `public.ita_owns_project(uuid)`；函数体确认是只读 exists 查询，没有额外 helper。明确 allowlist **只有 `public.ita_owns_project(uuid)`**。不按 STABLE/SECURITY DEFINER 自动放行；同名 text overload 和其他 STABLE/SECURITY DEFINER 函数仍撤权。新 verifier 同时确认 helper authenticated/service_role EXECUTE 存在、anon 不具备 EXECUTE，其他 Forge RPC 与 table/column mutation 权限为 0；发现未 review 的 policy 函数依赖直接失败。

永久回归 `ops-ingress-gate-rls.test.mjs` 在两个独立 PGlite 数据库分别加载正式 0001–0005 / 0001–revised0006：两用户各有项目、任务、计划、文件、消息；冻结后五类真实 authenticated SELECT 成功，跨用户读取为 0；project/task/message/source mutation、Build enqueue、resume/retry/approve、preview/deletion、worker writer/claim 都返回 42501。也覆盖 helper 被撤权时 verifier 失败、未知 policy helper 拒绝、同名 overload 不放行以及 exact unfreeze 回归（仅本地）。2 个集成回归 PASS，另 6 个 env/native-client regression PASS。原真实 disposable smoke 也补齐五表读取/跨用户/写拒绝覆盖，但暂停的 disposable **本轮未连接或重跑**。

Main 只恢复了本次 freeze 前实际 `main-ingress.json` 记录的一个 grant；沒有猜 role、没有恢复其他 mutation RPC：

```sql
GRANT EXECUTE ON FUNCTION "public"."ita_owns_project"(p_project_id uuid) TO "authenticated";
```

在同一个管理事务内执行 grant 和修复验证，全部通过才 COMMIT。验证用真实 PostgreSQL、两个已存在 Auth user ID、SET LOCAL ROLE authenticated 与 user claims；**不是 service-role bypass，也不是浏览器登录测试**。五类读取 10 组全部等于 owner baseline；foreign rows 均 0。26 次 mutation/RPC 尝试全部 SQLSTATE 42501，每次用 savepoint rollback；没有修改业务数据、task status、revision、journal 或 sandbox。管理员 enqueue/approve 权限保持 true。独立 frozen verifier 再次 PASS。

证据：ignored `stage-b-2026-10-08/policy-dependencies.json`、`narrow-gate-repair.json` 和 `quiescence-inspection.json`。原冻结前 ACL 与旧 disposable 证据保持不变。

### Stage B 恢复执行到 quiescence 后再次 STOP

2026-10-08T13:02:42Z 重查：本地旧 Worker process 0，active task 0，preview/deletion active 0，unresolved journal 0，uncertain command marker 0。Paused task 保持 paused，execution/worker/lease/heartbeat 为空，未自动恢复。

9 个引用 sandbox（5 stopped、4 archived）均实际调用只读 `process.listSessions()`：全部 HTTP 400。stopped 返回 SANDBOX_NOT_RUNNING，archived 返回 BAD_REQUEST。没有可用的 session/command 结果，没有取得 upload 完成证明，**不能把这解释为 session/command/upload 为 0**。没有 start/stop/archive/upload 或 physical source 读取操作。

按照“未确认远程旧副作用停止就 STOP”的规则，不再继续试接口或唤醒；不导出 paused source，不创建 T0 backup，不写 restore-test。需要 Daytona 控制台/平台侧能够证明没有 pending/running command/upload/生命周期操作，以及旧副作用不会在恢复 sandbox 后继续或迟到写入的证据。若控制台无法提供，应先决定经批准的替代 quiescence 核对方案；不能直接放宽为“stopped 所以安全”。

| 当前项目 | 状态 |
|---|---|
| ingress actually frozen | PASS |
| read-only RLS access / ownership isolation | PASS |
| all known old Workers stopped | PASS（WSL 重新检查；用户已确认唯一运行位置） |
| remote side effects quiesced | UNKNOWN：9 个 session 查询不可用，upload 无完成证据 |
| paused physical source preserved / discrepancy | UNKNOWN：尚未读取 |
| T0 backup created / manifest/hash verified | NOT RUN |
| restore completed / schema/data/hash validated | NOT RUN |
| rollback point genuinely usable | UNKNOWN |
| revised 0006 artifact unchanged | PASS：原 SHA256 未变，未执行 Main 0006 |
| matching Worker artifact ready | PASS：Worker 源码及依赖未变化，既有 artifact/测试证据有效 |
| controlled admin canary path ready | PASS（权限）；未创建真实 canary task |

**总体 NO-GO。Main 保持 frozen，但普通用户读取已恢复。未 backup/restore、0006、deploy/push、unfreeze 或 Phase 3。**
