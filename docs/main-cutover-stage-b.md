# Main Stage B operational proof — STOP / NO-GO

> 最新状态：narrow gate repair 和经批准的 lifecycle quiescence proof 已 PASS。Paused source 完整保存后发现 DB 外 package-lock.json，已重新 archive 并 STOP；Main 仍冻结，未 backup/restore。之前的 session-400 阻塞保留历史，当前清单以末尾更新为准。


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

## Approved lifecycle alternative → paused preservation（2026-10-08）

本轮用户明确批准使用 lifecycle-based alternative proof，并仅临时启动 paused sandbox 读取源码。没有为了取得 sessions=[] 启动其他 8 个 sandbox。

### 最终采用的 operational quiescence 判据

原 listSessions 方法属于 runtime/process API，inactive container 无 runtime 可供查询；先前 stopped 的 SANDBOX_NOT_RUNNING / archived 的 BAD_REQUEST HTTP 400 均保留记录，现分类为 **not applicable to inactive runtime**，不再解释为可能存在 active session。官方 [lifecycle](https://www.daytona.io/docs/en/sandboxes/) 与 [persistence](https://www.daytona.io/docs/en/persistence/) 说明 stop 清除 process memory，archive 保存 filesystem 到 object storage。此次所有对象实际都是 container，没有把 VM paused/hot memory resume 混入此判据。

producer side：Main frozen；WSL 旧 Worker process=0；queued/running tasks=0；future lease=0；最近一小时 heartbeat=0；active preview/deletion=0；unresolved journal=0；uncertain command marker=0；paused task execution/worker/lease/heartbeat 都为空。

execution side：2026-10-08T13:48:23.660Z 和 13:48:49.899Z 两次只读 control-plane observations 间隔约 26 秒。9 个 sandbox 均保持 5 stopped / 4 archived；state、desired state、updatedAt、lastActivityAt、backup state 与 error 标记全部相同。没有 started/starting/stopping/restoring/archiving/snapshotting/deleting/error 状态，没有观测到新 activity。

Worker producer 核对：daytona.js writeFile await SDK fs.uploadFile；SDK uploadFiles 为 await 的直接 FormData HTTP 上传，没有 presigned source queue、独立上传 worker 或外部 source-write job。workspace private helper/spec 上传和 gateway execution 也由 Worker await。runAsync 只用于 sandbox 内 dev-server runtime；stop 生命周期清除该进程状态。当前 Worker 只在 WSL 手动运行的事实由用户确认。因此在冻结入口、无本地 producer/DB active execution、全部 executor inactive 下，确认没有已知 Forge-controlled producer/executor 能继续迟到写入 managed source/Main DB。**此结论不承诺平台内部绝对不存在任何不可观测事件。**

Evidence：ignored `lifecycle-observation-1.json`、`lifecycle-observation-2.json`、`lifecycle-quiescence-proof.json`。旧 `quiescence-inspection.json` 中 400 没有被覆盖。

### Paused sandbox 的受控 preservation

只操作 `9394813e-2d8d-4ccf-8642-5c9e95e0f570`；起始 archived/container，auto-delete=-1，auto-stop=120。Main 仍 frozen，paused task 不 resume，不授予 writer。

临时 start 后 sessions=[]。先执行进程检查，再在源码读取前重新检查：只有 Daytona daemon、code interpreter REPL、computer-use/DBus 基础设施、空闲 shell/tail/sleep 及本次 ps。按精确 command/path 分类，不按所有 python/node 进程自动放行；没有 App/npm/Vite/旧任务进程或非预期 session。平台服务分类参考 [Daytona architecture](https://www.daytona.io/docs/en/architecture/) 及 [sandbox code interpreter](https://www.daytona.io/docs/en/python-sdk/sync/sandbox/)，并保存实际进程列表。没有恢复旧 process memory。

完整 scan 重用 Forge canonical managed-source manifest 定义：规范化路径、完整递归、排除 runtime/依赖/`.forge-*`、拒绝 symlink/截断、验证文本/内容 hash；binary resource 单独保存并视为待处置差异。Scanner 以内存中 data-URL Node module 执行，没有上传脚本或写 managed source。结果在本地重新计算 hash 后保存完整内容。

**真实差异：DB 的 10 个文件全部匹配；sandbox 多一个 package-lock.json（59,167 bytes）。没有其他文件差异或 binary resource。**

| Manifest | Files | Code hash |
|---|---:|---|
| DB ita_files | 10 | `2596fb9972332c1fc0db96b6b211e58bbec51541b160950657b19d1c9be49b8a` |
| Physical managed source | 11 | `e620dd2295e21d9942f56edfd7e51bfbac7d1cfffbe1919549337887bb8fbddb` |

Extra lockfile hash：`b408286f50406056e24f00c7488f1510bdf5f82700cb486045560e5935c47307`。package-lock.json 在当前 contract 中属于 managed source，所以不能自动忽略。

保存于 ignored `app/worker/.cutover/stage-b-2026-10-08/paused-source/physical-manifest.json`（全部 11 份完整内容）和 `db-manifest.json`（DB 10 份内容），以及 `paused-preservation-result.json`。这些是明确的旧 workspace source preservation evidence，**不是 T0 database backup，也不是把 debug logs 充当 DB backup**。

2026-10-08T13:56:27.455Z scan 保存后，执行 stop → archive，最终 control-plane state=archived，cleanup PASS。没有修改 managed source、覆盖 DB、吸收差异成 revision、修改 paused task/journal 或授予 writer。其他 8 个 sandbox 未唤醒。

按照“physical 与 DB 有差异就保存并 STOP”等待用户决定的规则，**没有创建 T0 backup，没有连接 restore-test 做恢复，也没有执行 Main 0006**。

### 当前最终 GO / NO-GO

| 项目 | 当前结果 |
|---|---|
| ingress actually frozen / read-only isolation | PASS：维持窄修复后的 frozen invariant |
| all old Workers stopped | PASS：两次 producer-side observations 都为 0 |
| remote side effects quiesced | PASS：限定已知 Forge producer/executor 的 approved lifecycle proof |
| paused physical source preserved | PASS：完整内容/hash 保存，cleanup 回到 archived |
| paused physical source == DB | DISCREPANCY：额外 package-lock.json，等待用户处置 |
| T0 backup created | NOT RUN |
| backup manifest/hash verified | NOT RUN |
| restore completed | NOT RUN |
| restored schema/data/hash/relationships validated | NOT RUN |
| rollback point genuinely usable | UNKNOWN：还没有实际恢复验证的 T0 |
| revised 0006 artifact unchanged | PASS：仍为 `5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782` |
| matching Worker artifact ready | PASS：Worker src/package/lock 未修改，既有固定 artifact 测试证据有效 |
| controlled canary path ready | PASS（权限/程序）：未创建真实 canary task |

**总体 NO-GO。** 需用户决定如何处置 preserved physical lockfile 与 DB source 的差异后，才可继续原 Stage B。Main 保持 frozen；不自动执行 backup/restore、0006、deploy、push、unfreeze 或 Phase 3。
