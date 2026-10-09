# Main Stage B operational proof — STOP / NO-GO

> 最新状态（2026-10-09）：DEFAULT ACL 只读对比已完成。supabase_admin 的 3 组 baseline 等价，可作为精确省略候选；postgres 的 3 组真实不等价，按用户规则 STOP，未生成 derived execution plan 或重试 restore。Main 仍 frozen，sealed T0 recovery hash 未变。


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

## T0 database backup + legacy sidecar（2026-10-08）

用户正式处置：Main DB 的 10 文件是当前持久化事实；physical 的第 11 文件 package-lock.json 仅作为 legacy sidecar 保留。没有写入 ita_files，没有创建 revision/changeset，没有 resume/cancel task，也没有实现 legacy reconciliation。

### Recovery attachment 与 integrity

Recovery set：`main-T0-20261008-01`，位于 ignored `app/worker/.cutover/backups/main-T0-20261008-01/`。`paused-legacy/` 包含完整 physical/db manifests、独立 package-lock.json、identity.json、原 preservation result 和 attachment-manifest.json。内容在本地独立复制，不以 archived sandbox 为唯一副本。

Attachment 显式记录 DB 10 files / legacy 11 files、两个 code hashes、唯一 extra lockfile 的 content hash，以及 project/task/sandbox identity。所有 payload files 按固定相对路径绑定 SHA256；bundle hash 使用稳定 canonical 对象，不受 property insertion order/filesystem mtime 影响。

DB manifest 引用 attachment 的相对路径、manifest SHA256 和 bundle hash；attachment 引用同一个 recovery_set_id 与 `../manifest.json`。外层 recovery-manifest 同时绑定实际 DB manifest hash、全部 DB archive/SQL payload hashes 和 attachment hash，避免相互嵌套 hash 的循环。Validation/diagnostic logs 不属于 immutable recovery payload，不被用作数据库备份。

- Sidecar bundle hash：`cfa7faada5a6fe1fb2ca778fdcf6f82004558532cac801882c9c2a1cc3194cce`
- DB manifest SHA256：`14f2c9dec9017177f6bc4090bcfc3d1e3f67e89ecae78aa46de88ad72db40b78`
- 整体 recovery bundle hash：`d6bededed2e6f4df391db11f4bde42dad55f351592eb6e37622f649669f2f065`

Prepare → seal → verify 均 PASS；真实失败 restore 后再次 verify PASS。额外 lockfile 的完整内容/hash 仍匹配，DB manifest 中 paused source 始终为 10 files，legacy_lockfile_in_db=false。

### 实际 T0 backup

T0 前再次做两次 observation（2026-10-08T14:28:28.969Z / 14:28:54.110Z）：producer/lease/heartbeat/active work/journal 均 0，9 个 sandbox stable stopped/archived。Main ingress frozen；paused task 无 execution/worker/lease。

PG17 客户端从显式 Main env + 严格 CA/hostname 校验连接，Main repeatable-read/read-only transaction export 一个 snapshot，public custom archive 与 Auth data archive 共享它。Manifest 完成时间 `2026-10-08T14:30:41.940Z`。7 个 DB dump/TOC/SQL payload files 全部完成并 hash 绑定。Main 0006 尚未执行。

源 inventory 40 张表；实际备份 public 13 + Auth data 26 = 39 张表。平台管理的 auth.schema_migrations 不复制，目标保留自己的版本历史；平台 schema/roles/password 不重建。当前 Storage/Vault/custom-role 范围沿用 preflight 的 empty 结论。关键 source rows：projects 10、tasks 24、plans 10、messages 22、files 79、snapshots 1；包含 paused project 的 10 files 和 plan/messages/history。

Structured recovery catalog 复用已确认 comparator：逐项比较 function identity/return/language/volatility/null behavior/security/parallel/leakproof/proconfig/owner/EXECUTE/body，保留 SQL literal 语义；表/列 ACL、RLS policies、constraints/NOT NULL 和 triggers 单独比较，不靠 raw rendering hash 或删除 whitespace。新增 sidecar/cross-reference/corruption 和真实 catalog 差异回归与现有 regression 合计 19/19 PASS（本地）。

### 真实 restore：FAIL / STOP

Restore 前确认 target `zynvesyeqsoeqssgwubj` 与 Main `vfzyimhapttcdxeabvur` 不同；public/Forge/Auth data empty，TLS 与 FK/INSERT/trigger checks PASS。Restore 只向 pinned target 连接，在一个 PostgreSQL transaction 中按 pre-data → ordered Auth data → public data → post-data 恢复。没有 Main write connection；没有把 sidecar lockfile 写入数据库。

失败于 `public-post.sql:736`：

```sql
ALTER DEFAULT PRIVILEGES FOR ROLE supabase_admin IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
```

实际错误：`permission denied to change default privileges`。这是 dump 带入的平台角色 DEFAULT ACL，当前 restore 管理连接无修改该角色默认权限的资格。本轮没有增加角色权限、修改 default privileges、删语句或重跑以让结果通过。按 permission mismatch STOP 规则停止。

只读确认 rollback 后：target public tables=0、Forge functions=0、Auth users=0、全部 26 Auth data tables 总 rows=0。**不能声称整个平台状态完全未变**：PostgreSQL sequence setval 不具有 transaction rollback 语义，当前 auth.refresh_tokens_id_seq last_value=146；没有 reset 它。

Main 只读 post-check：13 张 public 表的 counts/content hashes 与 T0 全部一致，structured function/trigger/RLS/ACL/constraint catalog 与 T0 一致；frozen verifier PASS；旧 task 仍 paused，execution/worker/lease 空。Main 未被 restore 修改，0006 未执行。

Private failure evidence：`.cutover/native-errors/97a2180e-9593-4e26-8a5d-c0b8a6a6c8aa.stderr.log`；恢复后只读状态 `main-T0-20261008-01/restore-failure-validation.json`。未输出 SQL COPY 用户数据或 secret。

### 最终清单（本轮）

| 项目 | 状态 |
|---|---|
| Main frozen、只读 isolation | PASS |
| old Worker / approved lifecycle quiescence | PASS：T0 前重新观测 |
| paused source preservation/discrepancy disposition | PASS：DB 10-file truth + 独立 11-file sidecar |
| T0 DB backup created | PASS |
| DB backup manifest/hash verified | PASS |
| legacy sidecar/cross-reference/recovery hash verified | PASS |
| actual restore completed | FAIL：supabase_admin DEFAULT ACL 权限 |
| restored schema/data/hash/relationship validation | NOT COMPLETED：事务回滚，不能宣称恢复成功 |
| rollback point genuinely usable | NO：备份完整但未通过真实恢复验证 |
| revised 0006 artifact unchanged | PASS：`5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782` |
| matching Worker artifact ready | PASS：Worker src/package/lock 未变 |
| controlled canary path ready | PASS（procedure/权限）；未实际 canary |
| paused task final manual-resume policy | BLOCKED：独立 Main cutover/unfreeze blocker，等待明确决定 |

**整体 NO-GO，Stage B 到此 STOP。** T0 archive 与 sidecar 保留，不删除、不改写 sealed payload；Main 保持 frozen，不执行 0006、deploy/push、unfreeze 或 Phase 3。下一步应只核对 source/target 的平台 DEFAULT ACL 是否等价，再决定范围明确的 restore recipe；不能泛化跳过 ACL 或索取更高角色来绕过平台权限。最终 rollback point 必须以真实数据库恢复验证 + sidecar integrity 两部分均 PASS 为准。

## Platform DEFAULT ACL / sequence 只读 proof（2026-10-09）

本轮只对 Main 与 restore target 执行 READ ONLY PostgreSQL catalog/state 查询，以及本地读取 sealed archive/SQL；没有 GRANT/REVOKE/default privilege/sequence reset/restore 操作。未重建 T0 backup，未修改 sealed payload。原 recovery hash 仍为 `d6bededed2e6f4df391db11f4bde42dad55f351592eb6e37622f649669f2f065`。

`pg_default_acl` 按 owner role、namespace/global scope、object type、grantee、逐个 privilege、grant option、grantor 比较，忽略 OID/rendering 排序差异。public 相关 DEFAULT ACL source 与 target 各 6 组，无 global-scope entry。枚举 sealed public.dump 的 6 个 DEFAULT ACL TOC entries 与 public-post.sql 全部 18 条 ALTER DEFAULT PRIVILEGES 语句，每一条的 source/target semantics、replay capability、分类完整保存于 ignored `restore-plans/main-T0-20261008-01-default-acl-01/readonly-proof.json`。

| Owner / public object type | Source vs target | Classification |
|---|---|---|
| supabase_admin / sequences | 完全等价 | platform baseline、target already satisfied、restore role 无权重放、精确省略候选 |
| supabase_admin / functions | 完全等价 | 同上 |
| supabase_admin / tables | 完全等价 | 同上 |
| postgres / sequences | 不等价 | app/restore-role-owned；必须完整恢复，不能跳过 |
| postgres / functions | 不等价 | 同上 |
| postgres / tables | 不等价 | 同上 |

Restore role=postgres、非 superuser、对 supabase_admin 无 owner privileges。T0 的 Forge authority objects 全部 owner=postgres（13 tables / 34 functions），因此 supabase_admin 的 3 条 TOC group（12 个 GRANT statements）不是 Forge-owned authority；它们只是 eligible omission candidates，**未执行 filter 或跳过全部 DEFAULT ACL**。

失败项 `supabase_admin/public/sequences → postgres` 的 SELECT/UPDATE/USAGE、grant option=false、grantor=supabase_admin 与 target 完全一致。其他平台语句同样等价。

但 postgres/public 有 3 项真实差异（grantor/grant option 一致，差异是权限集合）：

- Sequences：target 向 anon/authenticated/service_role 多授予 SELECT、UPDATE、USAGE；source 该 schema-specific default ACL 没有这些 grant。
- Functions：target 向上述三角色多授予 EXECUTE；source 该 schema-specific default ACL 没有这些 grant。
- Tables：target 向上述三角色多授予 SELECT、INSERT、UPDATE、DELETE；source 只保留 REFERENCES、TRIGGER、TRUNCATE、MAINTAIN。postgres 自身权限一致。

原 SQL payload 对这些 app-owned DEFAULT ACL 是 additive GRANT，不会自动撤去 target 多出的权限。因此仅过滤 supabase_admin 的失败语句，最终 DEFAULT ACL 仍不会与 Main 相同。按照“source/target 不等价则 STOP”的要求，没有推定额外对齐权限，没有生成执行用 derived filter/plan，也没有实际 restore retry。

### Sequence facts / 边界

Stage A 的 restore preflight/native connection/Auth compatibility/rights records **未保存 target 失败前 last_value/is_called**。原值 UNKNOWN，不能猜成 1。

Sealed T0 中只有两条 setval：

```sql
SELECT pg_catalog.setval('public.ita_audit_log_id_seq', 69, true);
SELECT pg_catalog.setval('auth.refresh_tokens_id_seq', 146, true);
```

当前 target 在 public/auth restore scope 内只有 auth.refresh_tokens_id_seq，last_value=146、is_called=true，结构与 source 兼容；public tables=0/Auth users=0。失败 attempt 创建的 public audit sequence 随 DDL rollback 已不存在。该 Auth sequence 是唯一已知持久残留，值已等于 immutable T0 的明确 setval；没有 reset 或略过 sequence 验证。

Main 当前 Auth sequence 已为 148，不能把它当作 T0 最终值；原因本轮没有调查或归因，也没有改它。真正重试必须以 sealed T0 的 146/true 和 audit 69/true 为依据，而不是读取当前 Main 后替换 recovery payload。因 DEFAULT ACL proof 不通过，尚未批准或执行 sequence retry precondition/实际 restore。

### 当前结论

- 平台 supabase_admin DEFAULT ACL exact equivalence：PASS，3 个 TOC groups / 12 statements 为候选。
- postgres/app-owned DEFAULT ACL equivalence：FAIL，3 个实际差异。
- 原始 sequence baseline：UNKNOWN（证据缺失）；当前残留与 T0 setval 一致，记录但未重试。
- 原 sealed T0 + legacy sidecar integrity：PASS，原 hash 未变。
- derived execution plan / real restore / rollback-point proof：NOT RUN / NOT PASSED。
- paused task manual-resume/reconciliation：保持后续独立 blocker，不处理。

**STOP / NO-GO。** Main frozen；未执行任何 default ACL 对齐、sequence reset、restore retry、0006、deploy/push/unfreeze 或 Phase 3。建议后续仅授权 restore target 的 postgres/public 三组 DEFAULT ACL 按 source 精确对齐，再生成包含平台 exact omission 和 sequence preconditions 的 derived plan；原始 archive/SQL继续不改写。

## Restore-target DEFAULT ACL alignment / real retry（2026-10-09）

本轮按用户 narrow approval，仅修改 restore target `forge-main-restore-test / zynvesyeqsoeqssgwubj`。Main `vfzyimhapttcdxeabvur` 全程只读，保持 frozen；未执行 Main 0006、deploy/push/unfreeze 或 Phase 3。没有重建 T0 backup，没有修改任何 sealed archive、SQL payload、manifest 或 legacy sidecar。

### Baseline alignment 与派生计划

修改前完整 `pg_default_acl`（所有 owner/schema/global/object type/grantee/privilege/grant option/grantor）快照 hash：`0bf3f9cc4d7508617058b3909937a500d234c3a6ab3770588c43a2c1abff36d9`。快照、9 条精确 REVOKE 和对应 inverse SQL 均保存到独立 ignored plan directory。Inverse 只恢复 restore-test 自身原 baseline，本轮没有执行 inverse。

仅撤回 postgres/public sequences/functions/tables 中已授权的 24 项 extra privileges；没有 REVOKE ALL、没有修改 supabase_admin、global 或其他 schema。事务中确认 public/global DEFAULT ACL 与 source 完全等价，其他 protected scopes 未变。public alignment hash：`d0a57fe198cf1097a1e543f2de8c10e4f9678c936d585b481275d1c5d1615eed`。

新 derived plan：`main-T0-20261008-01-derived-02`；hash `5ca7d021a28e775a386adbe0c4ac5efebfba43f7cb34ec9a3ca66e04f577b88e`。执行器校验 plan hash、original recovery identity/hash、所有 derived file hashes 和 exact omission；过滤结果必须与原 post-data 去掉那 12 条语句后的内容逐字一致。只省略 supabase_admin/public 三个已证明等价且不能由 postgres 重放的 DEFAULT ACL TOC groups（12 statements）；postgres/app-owned 六条 DEFAULT ACL statements 和其他 post-data 完整保留。

原 recovery bundle hash 仍为 `d6bededed2e6f4df391db11f4bde42dad55f351592eb6e37622f649669f2f065`；原 DB manifest hash 仍为 `14f2c9dec9017177f6bc4090bcfc3d1e3f67e89ecae78aa46de88ad72db40b78`；sidecar bundle hash 仍为 `cfa7faada5a6fe1fb2ca778fdcf6f82004558532cac801882c9c2a1cc3194cce`。

### Retry preconditions / 真正恢复

再次确认 target public tables/functions=0、Storage objects/buckets=0、26 张 Auth data tables 总 rows=0；restore-scope 唯一 sequence 为 auth.refresh_tokens_id_seq=146/true，public audit sequence 不存在。原第一次失败前 sequence state 继续记录 UNKNOWN，未伪造，也未 reset 已等于 T0 的值。没有额外 residue，Auth 非 FK active triggers=0，target postgres 非 superuser 且无 supabase_admin owner privileges。Main pre-check frozen/paused isolation/public T0 hashes/catalog 均 PASS。

使用严格 TLS、固定 restore identity，在一个真实 PostgreSQL transaction 中执行原 pre-data → 原 ordered Auth data → 原 public data → derived post-data。**事务成功提交**。没有提权，没有关闭 FK、RLS 或 TLS。新 driver 和 validation evidence 在 derived plan directory，原 T0 files 保持 byte-for-byte 不变。

### 完整验证：存在真实 object ACL mismatch，STOP

| 验证项 | 结果 |
|---|---|
| 39 张备份表 counts/content hashes | PASS |
| 34 functions：identity/body/attributes/owner/EXECUTE | PASS：semantic=0、metadata=0 |
| 13 triggers、RLS/policies、constraints/NOT NULL、column ACL | PASS |
| postgres/public 与 supabase_admin platform DEFAULT ACL、其他 scope | PASS：完整 target DEFAULT ACL 与已对齐 precondition 完全等价 |
| Auth sequence | PASS：146/true |
| public audit sequence | PASS：69/true |
| sequence structure/owner、target Auth schema_migrations 保留 | PASS |
| project → tasks/plans/messages/files/snapshots、task → plan | PASS：无 orphan/project mismatch |
| paused DB 10-file state + plan/messages | PASS：没有导入 lockfile，没有 resume |
| legacy physical 11-file sidecar/content/hash | PASS |
| Main restore 前后全部 inventory counts/hash、catalog、DEFAULT ACL、sequence、paused isolation | PASS：unchanged；frozen verifier PASS |
| 所有 sealed recovery payload / cross-reference hashes | PASS |
| public table object ACL | **FAIL：13 张 Forge 表各有 8 项 extra grants** |
| rollback point genuinely usable | **FAIL：object ACL 未忠实恢复** |

只读 failure evidence 确认：13 张表中 anon、authenticated 各额外具有 `MAINTAIN / REFERENCES / TRIGGER / TRUNCATE`，合计 **104 项 extra grants**；没有 missing grants；table owner/RLS flags 等其他字段完全一致。涉及 `ita_audit_log / ita_files / ita_memories / ita_memory_suggestions / ita_messages / ita_plan_feedback / ita_plans / ita_preview_recoveries / ita_project_deletions / ita_projects / ita_snapshots / ita_task_feedback / ita_tasks`。

DEFAULT ACL 等价与现有对象 ACL 等价是不同判据：恢复时 CREATE TABLE 会应用 target 已对齐的 source default grants，sealed post-data 的对象授权没有把这 104 项 inherited extra grants 撤回。**不能因为 DEFAULT ACL 或数据正确就忽略 TRUNCATE 等真实权限差异**。本轮授权只允许 DEFAULT ACL 对齐，没有授权额外 object ACL repair；没有执行精确 table REVOKE、inverse、再次 restore、清库或新 backup。

Ignored evidence 位于 `app/worker/.cutover/restore-plans/main-T0-20261008-01-derived-02/`：`derived-plan.json`、`target-default-acl-before.json`、`inverse-target-baseline.sql`、`target-default-acl-aligned.json`、`restore-retry-preconditions.json`、`restore-validation.json`、`table-catalog-diff.json`、`main-before-restore.json`、`main-after-restore.json`。原失败 evidence 和 T0 均保留。

新增本地 regression 5/5 PASS：精确 24-permission alignment/inverse、protected scope invariants；exact omission/identity/filter、禁止扩大 omission/伪造 equivalence/替换文件；恢复 bundle/sidecar integrity；structured catalog semantics/permission/RLS/constraint detection。`node --check` 和 `git diff --check` PASS。Worker/runtime/frontend 未修改；未重跑无关检查。

### Stage B final GO / NO-GO

| 项目 | 状态 |
|---|---|
| ingress actually frozen | PASS：真实 Main verifier |
| old Worker / remote quiescence | PASS：沿用 T0 lifecycle/producer proof；本轮未启动 Worker/sandbox |
| paused physical source preserved / discrepancy disposition | PASS：DB 10 + 独立 sidecar 11，final resume policy 另列 blocker |
| T0 backup / manifest / sidecar intact | PASS |
| actual restore transaction | PASS：已提交，target 不再是 empty retry target |
| restored complete schema/data/hash/ACL validation | **FAIL：104 extra object grants** |
| rollback point genuinely usable | **FAIL** |
| revised 0006 unchanged | PASS：`5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782` |
| matching Worker artifact / controlled canary path | PASS：准备状态未变，未部署/运行 canary |
| paused final manual-resume / legacy reconciliation policy | BLOCKED：独立后续决定，本轮未处理 |

**STOP / NO-GO。** Main 保持 frozen；恢复目标保留本次已提交的恢复状态用于核对，不自动重跑 empty-target recipe。后续若获授权，最小范围应为 restore-test 对象 ACL 的精确 source-vs-target 差集修复及完整只读复验；不要改 sealed T0、不要修改 Main、不要把该差异判为 comparator noise。

## Restore-target exact table object ACL normalization / final revalidation（2026-10-09）

本轮用户单独批准 restore-target-only exact object ACL repair。仅向 `forge-main-restore-test / zynvesyeqsoeqssgwubj` 执行表 REVOKE；Main `vfzyimhapttcdxeabvur` 连接全为只读事务，保持 frozen。未清空 target、未重新 restore、未改 sealed T0、未执行 Main 0006、deploy/push/unfreeze 或 Phase 3。

### 不可变实际 repair input

执行前重新读取 sealed T0 catalog 和实际 restored target catalog；以 set difference 生成输入，不从预期列表猜修复项。确认与上一轮已保存的 `table-catalog-diff.json` 完全相同：missing=0、extra=104、affected tables=13，grantees 恰为 anon/authenticated，privileges 恰为 MAINTAIN/REFERENCES/TRIGGER/TRUNCATE，grantor=postgres、grant option=false。其他 table metadata 及完整 recovery pre-validation 均无额外差异。

保存完整 target table ACL snapshot/hash、actual diff、104 条 exact REVOKE、对应 inverse SQL 和 immutable repair manifest。没有 REVOKE ALL、schema-wide operation、service_role ACL mutation、DEFAULT/function/sequence/column ACL mutation。Inverse 只用于撤销本次 restore-test repair，本轮未执行。

| Identity / hash | 值 |
|---|---|
| Original recovery set | main-T0-20261008-01 |
| Original bundle hash | d6bededed2e6f4df391db11f4bde42dad55f351592eb6e37622f649669f2f065 |
| Original DB manifest hash | 14f2c9dec9017177f6bc4090bcfc3d1e3f67e89ecae78aa46de88ad72db40b78 |
| Prior derived-plan hash | 5ca7d021a28e775a386adbe0c4ac5efebfba43f7cb34ec9a3ca66e04f577b88e |
| Pre-repair table ACL hash | 7bc8de31709c8c84f09db6d84573da012cc791243a96cedb9ce88956192e7037 |
| Repair manifest hash | b872e1980e7fff46d5020d0447d2b36866fbe624a3280bc76ba026b84320b842 |
| Expected / actual post-repair ACL hash | 25c6157122025145ba189c422062321c0dd52d5bdd0de5863e6b13fc3643d29f |
| New derived-plan hash | 97d68043266fa6ecd579240515a2a94db8ec3764172e7b88968ad32f590dc534 |

独立 plan directory：`app/worker/.cutover/restore-plans/main-T0-20261008-01-derived-03-object-acl/`。其中 `repair-manifest.json` 绑定原 bundle、DB manifest、prior plan、actual diff evidence、pre-repair snapshot、exact SQL/inverse SQL hashes 和 post-repair expected hash。`derived-plan.json` 链接原 recipe，明确增加 **restore → DEFAULT ACL semantic validation → exact table object ACL normalization → complete catalog/data validation**。原 archive/SQL 和 prior derived plan 均不改写。

### 正式 recipe 实现与事务边界

`ops-table-acl-repair.mjs` 提供实际 ACL delta、stable hash、strict authorization check、SQL generation 和 normalization；它只接受当前已经明确批准的 13-table/104-extra/0-missing 集合。未知/减少/新增差异、service_role extra、grant option 或 owner/RLS metadata drift 均停止；不会泛化成“所有权限都修”。

`ops-derived-table-acl-repair.mjs` 是 recipe continuation，不是手工 SQL patch。它校验原 recovery bundle/parent plan 的完整性，保存输入后，对固定 restore identity 开启事务；按 canonical table order 获取 transaction-scoped locks，重新校验 actual ACL/hash，执行 manifest 中 104 条逐表/逐角色/逐 privilege REVOKE。完整 structured table ACL missing=0/extra=0 且其他 catalog、DEFAULT ACL/sequence 均未变时才 COMMIT；任一不符 ROLLBACK/STOP。

本次事务成功提交；提交后再次通过共享 `ops-recovery-validation.mjs` 进行完整只读验证。原 restore executor 同样复用该验证器，避免两套验证标准。这次没有重新运行原 empty-target executor；本次操作不能在已修好的 target 上盲目重复运行。

对应命令（本次已执行，记录用途，**不是要求重跑**）：

```bash
node app/backend/tests/ops-derived-table-acl-repair.mjs --ack-target-exact-table-acl-repair
```

### 真实最终验证

| 检查 | 结果 |
|---|---|
| 39 张 backed-up public/Auth 表 counts/content hashes | PASS |
| 34 functions identity/body/attributes/owner/EXECUTE | PASS：semantic=0 / metadata=0 |
| 13 triggers、RLS/policies、constraints/NOT NULL、column ACL | PASS |
| 13 张 table object ACL：完整 source-vs-target compare | PASS：missing=0 / extra=0 |
| postgres/public DEFAULT ACL 与 T0、supabase_admin platform DEFAULT ACL、global/其他 scopes | PASS：完整语义等价且 repair 未改变 |
| sequence values/owners/structure | PASS：Auth 146/true、audit 69/true |
| target Auth schema_migrations 历史 | PASS：保留 target 自身版本历史 |
| project → task/plan/message/file/snapshot、task → plan | PASS：无 orphan/project mismatch |
| paused DB 10-file truth、plan/messages/relationships | PASS：code hash 未变，无 lockfile 导入，无 resume |
| legacy physical 11-file sidecar/content/hash | PASS：独立保存，不写入 DB |
| 原 sealed recovery bundle/archive/SQL/manifest/sidecar hashes | PASS：byte-for-byte 未变 |
| Main repair 前后全 inventory counts/hash/catalog/DEFAULT ACL/sequence/paused isolation | PASS：unchanged；frozen verifier PASS |
| TLS / source-target identity / restore role | PASS：严格 CA，postgres 非 superuser，无 platform owner 提权 |
| rollback point genuinely usable | **PASS：真实 DB restore + sidecar integrity 均验证** |
| Stage B backup/restore operational proof | **PASS** |

完整 ignored final record：`...derived-03-object-acl/final-recovery-validation.json`；包含真实 restored counts/hashes、ACL delta/hash、catalog classification、sequence state、relationship checks、原 recovery/sidecar refs 和 Main pre/post comparison。`pre-repair-table-acl.json`、`repair-manifest.json`、`exact-table-revoke.sql`、`inverse-table-acl.sql`、`repair-commit.json`、`main-before-repair.json`、`main-after-repair.json` 均保留。历史失败记录不覆盖、不改成 PASS。

相关本地回归 **8/8 PASS**：exact defaults/inverse/protected scopes，exact derived omission/identity/filter，recovery/sidecar corruption，structured catalog differences，exact 104-object ACL repair/inverse/service-role/RLS/column preservation，stale/broadened/missing grant rejection，以及 post-write comparison failure 必须 rollback 所有 REVOKE。Syntax / diff-check PASS。未修改 Worker/runtime/frontend 或 revised 0006。

### 最终状态：Stage B PASS，Main cutover 仍 NO-GO / STOP

- Stage B T0 backup + 实际 restore + 完整 ACL/data/schema/sequence/sidecar revalidation：**PASS**。
- revised 0006 hash 不变：`5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782`；本轮未执行。
- Main ingress frozen；旧 Worker/remote quiescence 沿用已批准的 T0 proof，本轮未启动任何 Worker/sandbox。
- matching Worker artifact / controlled canary 准备状态未变，未部署、未运行 Main canary。
- **paused task 最终 manual-resume / legacy reconciliation policy 仍是 Main cutover/unfreeze 前的独立 blocker**，本轮没有实现、取消或吸收 legacy physical source。
- 没有 Main cutover 最终批准；没有 push/deploy/unfreeze 或 Phase 3。

**到此 STOP。** 本次 PASS 只证明可用的数据库 disaster-recovery restore point（T0 DB + legacy sidecar），不等于 Main 0006 已执行、真实 canary 已通过或 App Version/historical preview 能力已完成。
