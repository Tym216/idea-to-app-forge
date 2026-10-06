# Phase 2 Workspace 收口契约（已确认，Phase 2 实施契约）

范围：统一现存 managed source 写路径、revision、可核对的 Change Set 和 checkpoint。保留 task/execution control 与现有工具入口，不建立通用分布式事务框架。Conversation intake、App Version UI、用户编辑 UI 属于后续阶段。

## 0. Canonical managed-source manifest

三类操作独立处理：A) write/apply/delete/用户 Apply 是 logical source mutation，走 Change Set；B) materialization 把 confirmed revision 写入沙箱，不增加 revision，结束后核对完整 manifest；C) install/build/start_dev/preview recovery/command 是 runtime operation，默认不是 Change Set，但必须检测 managed source drift。

首版 managed source 是项目目录内的普通 UTF-8 文本文件，包含 package.json、package-lock.json、Vite/TS 配置、HTML、src、文本 assets、README 等。package-lock.json 属于源码；安装改变它必须显式记录并提交源码变化。二进制/NUL/无效 UTF-8 或无法完整扫描时拒绝生成 manifest，不静默漏存。

排除：任意层 node_modules、.git、.forge-*；根目录 dist/build/out/.vite/.cache/.next/.turbo/coverage/logs/tmp/temp/test-results/playwright-report/screenshots/videos；真实 .env/.env.*（.env.example 保留）。排除目录不继续扫描。managed 路径上的 symlink/非普通文件及 symlink 父路径拒绝；runtime/excluded 目录内的链接不进入 manifest。

path 采用区分大小写的 POSIX 相对路径；规范化 ./ 与重复斜线，拒绝绝对路径、反斜线、控制字符、.. 段和规范化后重复路径。不对 Unicode/大小写/换行作隐式改写。内容 hash 是原 UTF-8 字节 SHA-256。

路径上限为 240 UTF-8 字节；manifest 按规范化 path 的 UTF-8 字节序排序，整体 code hash 为 SHA-256(JSON.stringify([[path, content_hash], ...]))。不包含时间、task、execution、文件表 version 等瞬态值。删除文件从当前 manifest 消失；Change Set 保留 delete、before hash 与 after hash=null；数据库用 tombstone 保存历史。DB 与 sandbox 使用同一规范化/hash算法，比较完整路径集合和内容 hash，不能只比较文件数或前 N 个文件。扫描上限触发显式失败，不返回截断 manifest。

## 1. 三个状态概念

- `workspace_revision` 是最后一个已确认、持久化源码清单的整数编号，由提交 RPC 维护。它不等于 task execution、Plan version、文件时间戳或每次远程上传次数。
- 当 workspace 为 `applying / partial / uncertain / conflict` 时，沙箱可能已有未提交变化。此时显示「last confirmed revision=r，存在待核对修改」，不能声称当前物理目录完整等于 r。
- `code_hash` 标识按路径排序的完整 managed source 内容；它与 revision 含义不同。相同源码可能有不同历史路径，不用全局 hash 唯一约束替代版本身份。

Workspace 状态：

| 状态 | 含义 | 新的正常写入 | checkpoint |
|---|---|---|---|
| uninitialized | 旧 files 尚未核对或新项目尚未 materialize | 先核对/恢复；不可正常写入 | 禁止 |
| confirmed | 沙箱与持久化源码已经核对；可标识 revision/hash | 可尝试获取 writer | 满足证据条件后允许 |
| applying | 已保留 writer，正在处理既定修改 | 仅原操作 | 禁止 |
| partial | 确认部分路径已修改，原组尚未完整提交 | 禁止新目标；先 reconcile | 禁止 |
| uncertain | 操作结束/真实内容尚无法确认 | 禁止；先只读核对 | 禁止 |
| conflict | 实际源码无法与基线/既定目标对应 | 禁止自动覆盖 | 禁止 |

Change Set 状态：`prepared → applying → committed`，失败可进入 `partial / uncertain / conflict`。核对后允许 `committed / not_applied`，或继续恢复同一个不可变请求；取消未执行请求为 `cancelled`。

写入前 base revision 不匹配属于当次请求的 `conflict/not_applied`，不会把一个原本 confirmed 的工作区制造成未知状态。实际沙箱内容发生未知漂移才是阻断 workspace 的 conflict。历史已终止的冲突请求不永久阻断后续 checkpoint。

无源码变化：Change Set 仍记录确认结果，但 `resulting_revision=base_revision`。有变化：整组确认后 revision 仅增加一次；不能给每次上传或一次 model turn 增加 revision。

## 2. 最小持久化

新增一张 `ita_changesets`，包含：

- id、project_id/user_id（复合归属约束）、actor=`agent|user|system`、origin。
- request_id（调用者生成的幂等键）、task_id/execution_id（可空，但 agent 必须具备有效执行；只作 provenance，不进入 evidence validity）。
- base_revision、resulting_revision、status。
- 不可变请求：路径、write/delete、原 hash、目标 hash/内容；runtime operation 在项目 guard 中保存 before manifest/hash 与 command 标识；只有检测到真实源码变化才记录 drift/Change Set。首版拒绝任意会改源码的 shell，安装只自动接纳已确认的 lockfile 变化。
- 每路径实际结果、远端 operation/command 标识、核对结论；这些是结果，不反向覆盖原请求。
- writer token、持有者、时间，以及 legacy operation_id（导入旧 journal 时去重）。

首版只覆盖完整 write 和受管理文件 delete。创建文本文件由不存在路径的 write 表达。不给 patch/rename/自动 merge 增加新协议。

项目增加 workspace_revision、workspace_state、active changeset/writer 引用、当前源码 hash 和最新 checkpoint 引用。writer token 是执行资格，不是另一个源码 revision。Task 记录开始与当前上下文所对应的 revision。

`ita_files` 继续保存当前已提交源码。文件表、项目 revision、Change Set 终态通过同一个 DB 事务更新；不会把沙箱逐文件成功即时混入已提交的数据库源码。

`ita_snapshots` 继续保存完整源码，不新增重复的 version 表。增加 revision/hash、basis 引用、build/verify 结论、来源执行与幂等完成键。本轮只加入 kind；number/parent 留到 Phase 4 的同一创建事务扩展，版本编号在创建时分配，不能先创建 immutable checkpoint 后覆盖成另一个源码版本。快照创建后，源码、revision/hash、basis 和证据不能再被更新；项目删除的正常级联清理仍允许。

## 3. RPC 契约与事务边界

以下为实现后的最小持久化接口；全部复用现有 owner/lease/execution 校验。Worker 写接口仅 service_role；未来用户提交入口只能保存请求，不能伪造结果。

| RPC | 输入 | 输出 | 幂等/事务边界 |
|---|---|---|---|
| `ita_workspace_read` | project/task/execution | 完整 committed manifest、revision/hash、writer、证据、pending | 只读核对；不是截断 files 查询 |
| `ita_workspace_prepare` | project/task/execution、request_id、actor/origin、base_revision、changes 或 before manifest | changeset_id、prepared/conflict、current_revision | unique(project_id, request_id)；同 key 不同 payload 拒绝。项目行锁下校验归属与记录请求；无沙箱写入 |
| `ita_workspace_acquire` | project、changeset 或受控 validation operation、worker/task/execution、operation_id | granted + writer_token，或 busy/reconcile_required/conflict | 原 operation 重复获取返回原 token；不能仅因租约过期给新 execution 新写权限 |
| `ita_workspace_result` | changeset、writer token、operation_id、实际路径 hash/结果/command ID | accepted + 当前 state | 重复同结果幂等；校验持有者；只记结果，不提升 revision |
| `ita_workspace_commit` | changeset、token、expected base revision、已核对完整 source manifest/hash | committed/noop、resulting_revision/hash | 原子更新 files/tombstones、revision、状态并释放 writer；同请求重复返回原结果，不再次增 revision |
| `ita_workspace_reconcile` | 原 changeset、当前有效任务/恢复执行、原沙箱核对证据 | committed/not_applied/safe_to_continue_recorded/blocked | 先确认旧操作已结束且路径为原基线或既定目标；不创建新目标。无法证明时仍 blocked |
| `ita_workspace_evidence` | task/execution、validation operation、revision/hash、basis、build/verify 实际结果 | accepted/stale | DB 检查 current revision/hash；失配不能变成有效证据 |
| `ita_workspace_finish_operation` | 当前 token、核对后的 source hash | confirmed | runtime/materialization 收尾；不产生 revision |
| `ita_complete_build_checkpoint` | task/execution、completion_key、expected revision/hash、basis、摘要 | snapshot_id、confirmed task outcome | 事务内核对证据、创建快照、更新项目/任务并插入现有完成消息。重复请求读取原结果；超时先按 key 查询，不重新生成/发布 |

DB 不可能自行检查 Daytona 文件内容，manifest/hash 是受控 Worker 在正确 writer/fence 下取得的实际证据；不能把客户端上传 hash 当作核对完成。

共享锁顺序统一为项目 → task/changeset → plan/snapshot。旧 approve/pause/save_plan 等必要触点也要核对锁顺序。新增 RPC 采用 FORCE RLS、固定 search_path、显式 GRANT/REVOKE 和复合归属 FK；迁移后禁止旧 direct files 写入绕过提交 RPC。

## 4. Writer fencing

任务租约不直接授予 workspace 写权限。正常 writer 至少要求：有效 execution、project 未删除、base revision 匹配、没有未核对 source operation。

两层保护：

1. DB writer 记录串行化项目操作，并保留未确认操作；到期表示需要核对，不表示沙箱副作用已结束。
2. 沙箱写 gateway 在稳定的项目锁下验证 fencing token 与单调 writer epoch（epoch 不是源码 revision）。helper、锁和 staging 放在 App 目录的同级私有 .forge-workspace-<root hash>，不放进 Vite webroot。完整请求先上传到 operation 专属 staging，独立核对目标 manifest hash，逐文件核对 staging 内容 hash，再检查 token/原 hash 并替换 managed 文件。旧执行迟到的 staging 上传不能直接覆盖正式源码。delete 同样经过该 gateway。arbitrary shell/detached process 无法获得同等 staging 保证，首版限制这类命令。runtime 操作使用单独的 guard/实际 drift 检查，不机械地创建 Change Set。

Forge 自己控制的文件写入建议使用沙箱侧 file lock + operation marker + staging/原子替换的小脚本，实施时先确认运行环境支持；不能在不支持时悄悄退回仅有 DB lease 的保护。锁文件不能被重新创建成另一个 inode，也不能用清理目录绕过正在持有的锁。

- writer 仅在确认提交、确认 not_applied 或已完成安全核对后释放。
- partial/uncertain 时，新 execution 可以取得 reconciliation-only 资格，读取状态；不能取得正常写资格或调用新目标的 LLM。
- 只有证明旧命令已结束、文件匹配原基线/既定目标，才允许恢复同一个记录中的 not-run 路径。它是原请求的核对后接续，不是盲目重放整组写入。
- 已到目标的文件不重写；发现第三种 hash 时停止，不自动 merge，也不以数据库覆盖未知沙箱内容。
- 任意 shell 的 detached writer 或范围外副作用不能由通用进程名推断结束；无法确认则停止。首版不试图恢复支付/API/数据库等外部副作用。
- 暂停会保留未确认操作。resume/lease takeover 必须先核对，不能因为用户点了继续就解除 fence。

build/verify 阶段也需与 source writer 互斥，且在记录证据前后检查源码。preview recovery 不应在另一个执行正在改变源码/启动进程时并行修改同一个沙箱。

## 5. 现存写路径迁移清单

| 现存路径 | 当前行为 | 新契约 |
|---|---|---|
| `agent.runTool(write_file/apply_changes)` | 逐文件 steps journal、沙箱写入、direct upsert | 保留工具形状，内部委托 workspace service；逐路径结果归 changeset |
| `delete_file` | `rm` + DB deleted 标记 | 同一 mutation contract 的 managed delete，核对基线/hash |
| `run_command` | 任意命令；超时 COMMAND_UNCERTAIN；无 source 同步 | 首版仅开放受控 install；明确源码改写命令拒绝，未来隔离执行后提取 diff。未隔离命令的 timeout/副作用不确定时保持 uncertain，不能以 DB token 推断旧进程停止 |
| build 内 `npm install && npm run build` | 安装可生成 lockfile，build scripts 也可能改源码 | 安装后先核对/提交源码变化，再构建；构建前后源码变化使该次证据失效，不能假装仍是旧 revision 的成功 |
| `hydrateSandbox` 的 scaffold 补写 | 写沙箱再 upsert | 有新增逻辑源码时为 system changeset |
| `hydrateSandbox` 的恢复/覆盖 | 每轮把 DB files 写回；不移除旧多余文件 | 已确认 revision 的 materialization；同内容不增 revision。先处理 pending 操作，不覆盖未知漂移；受管理清单需完整对应 |
| design tokens 写入 | executeTask 直接写沙箱/DB | system source change，包含 revision/hash/结果 |
| 旧 reconcile 的 DB 补写 | 从 steps 找 pending，核对原沙箱后 upsert | 迁移到 service；只能根据原请求核对结果提交 |
| preview recovery / `start_dev` | 执行 npm dev、重启 session/进程 | 默认 runtime operation，不创建 Change Set；guard + source drift 检查。未预期变化进入 drift/reconcile；未知进程结束状态时禁止新 source writer |
| Daytona.ensure 的重建绑定 | catch 多类异常后 create | 仅确认沙箱不存在且没有待核对副作用时可重建；连接/权限错误不能当不存在 |
| verifier runner/screenshots | 写 `.forge-verify` 内部文件 | 明确排除 managed source；仍绑定验证时 revision/basis |
| 将来的用户 Apply | 尚不存在，CodeExplorer 只读 | 保存用户 draft/request，Worker 同一 service 提交；stale → conflict/review diff/reapply |

内部 staging/verify 文件、node_modules 和 dist 不属于源码 revision；源码清单必须完整且稳定排序。当前 listFiles 的 head-300 不能用于完整 checkpoint 证明。首版继续支持受管理文本源码；未支持的二进制/超限扫描须明确报错，不能悄悄漏存。

## 6. Evidence 与 checkpoint

Build validity = workspace_revision + code_hash + build_basis_fingerprint。Verify validity = workspace_revision + code_hash + verification_basis_fingerprint。task/execution/request/worker/time/retry 仅作 provenance，不能进入 fingerprint；resume 或 Worker 更换本身不使 evidence stale。

build fingerprint 使用稳定排序 JSON 的 SHA-256，只包含实际构建 recipe、Node/npm/平台版本和当前 Vite recipe 的 NODE_ENV/NODE_OPTIONS/VITE_* 和 .env 配置摘要（敏感配置只存 hash；不把 hostname/Worker 环境等 provenance 纳入）；源码/lockfile 已由 code_hash 覆盖。verify fingerprint 只包含实际 immutable checks、core/detail/external 分类、runner/Playwright 版本、viewport/timeouts/isolation，以及应用的 build basis 等执行条件，不包含 Plan 数据库 ID/序号、签名预览 URL 或执行 ID。

旧证据保留在 checkpoint、任务验证日志及提交 Change Set 的 previous_evidence；project 字段仅指向当前候选证据。当前 validity 由 revision/hash/对应 fingerprint 匹配决定，发布资格再判断真实 status。当前 execution 只在完成 RPC 中校验执行资格；它可以引用先前执行产生的有效 evidence。恢复任务先加载并复用有效证据，仅检查/唤醒 runtime，不无故重新 build/verify。

任何确认的源码 revision 变化立即使旧 build/verify 当前有效性失效；开始未确认修改时，也先禁止沿用旧证据发布。纯 no-op 不提供新 revision，也不能凭它获得第二次 verify 机会。

发布前置条件全部由 RPC 校验：

- source confirmed，沙箱与 DB manifest 匹配 expected revision/hash。
- 没有关联当前 workspace 的未解决 partial/uncertain/conflict，也无未收尾 writer。
- 当前 revision/hash/build fingerprint 的 build 成功。
- 当前 revision/hash/verify fingerprint 的 verify 已得到结论且没有 blocker；tool_error 不合格。
- warning/inconclusive 保存在 snapshot 与完成状态中，不能显示成全部通过。
- 当前 execution 有资格完成；completion key 幂等。

Phase 2 创建技术 checkpoint 并确立上述完成事务。Phase 4 的 App vN 直接扩展同一创建事务，编号/父版本在创建时生成，不能另起发布系统。名字先复用需求/已有摘要，不增加命名模型调用。

## 7. 复用、迁移和切换顺序

复用：task/execution control、工具协议、budget、hash 方法、基线/目标内容核对、verification 分类、ita_files 和完整 snapshot。task.steps 保留作为日志和旧恢复证据。

迁移：正式 mutation 状态/内容/原 hash/目标 hash 移入 ita_changesets；原 steps 不删除、不覆写。旧 pending operation 按 `(project_id, legacy operation_id)` 幂等导入；不能从旧逐文件事件猜出并不存在的整组事务。历史已完成 journal 不反推历史 workspace revision。

切换：

1. 开发小 service、RPC 和 gateway，用离线 fixture 验证；生产旧 writer 保持原样，新增入口不启用。
2. 停旧 Worker，确认沙箱命令收尾；执行 0006，导入未确认 journal 并核对。无法核对的项目保持 blocked，不用新的空沙箱假装恢复。
3. 从当前 files 建 revision=0 的 legacy baseline；只有核对/重新 materialize 的沙箱与此清单一致后才标 confirmed。没有 matched build/verify 证据，不自动给旧 snapshot/App 标 verified 或编号。
4. 所有 source 写路径都委托 service 后，启用新 writer，禁止旧 direct files 写入。读旧 steps 只用于迁移/兼容，不双写两个独立真相。
5. 同一版本内完成 snapshot/terminal RPC 接续；旧流程不得在 RPC 完成后再次分别写 succeeded/完成消息。
6. Phase 3 intake 和 Phase 4 编辑在这个边界稳定后开放。不能在旧 writer 尚在运行时放行新的编辑旁路。

后续 migration 只新增，不重跑 0001–0005。计划/任务/快照新 FK 要验证项目归属，删除级联要覆盖新表。Phase 3 再收紧 message 插入/删除与意图状态权限。

## 8. 独立验收与未实现边界

测试：write/delete/no-op revision；多文件 partial；超时发生在真实写入前后；旧 token 迟到 staging/rename；resume 与两 Worker takeover；shell lockfile/scaffold/materialization 同步；source 变化使证据 stale；不同 revision 的 verify 不可发布；completion 超时后的幂等查询；legacy journal 导入与不可访问原沙箱；RLS/归属/删除级联。

沙箱 gateway 的本地 Linux 锁/迟到操作测试之外，已补 disposable PostgreSQL 双连接的 writer/CAS/完成竞争及 fresh Daytona fixture 联调，见 [rehearsal 记录](workspace-cutover-validation.md)。这些有限样例不能证明所有并发顺序或长期负载安全；主要环境尚未切换。

Phase 2 已按此契约实现。切换和验证边界见 [workspace-cutover.md](workspace-cutover.md)。不实现 Conversation intake、用户编辑 UI、历史 worktree/preview、数据库回滚、Profile 分类器或复杂自动 merge。


## 9. 首版运行边界

- run_command 只接受受控 npm install；实际安装带 --ignore-scripts --package-lock=true。build/dev 只开放受控 Vite recipe（build 可先 tsc），npm run 同样忽略 pre/post lifecycle hooks。复杂 shell、native install hooks、非 Vite runtime 需后续隔离支持，不靠 DB token 假装安全。
- 完整 source manifest 首版限制 2,000 文件、单文件 1 MiB、总文本 8 MiB；UTF-8 BOM 和换行原样保留。它是明确的支持范围，超限/二进制不会被静默跳过。
- mutation/materialize 可通过稳定 flock、旧 token retire 和基线/目标逐路径核对自动接续。运行命令缺少可靠停止证明时保持阻塞；没有强制解锁/自动 merge 功能。
- 预览恢复只检查/唤醒；不会代替用户恢复暂停或未确认的 source mutation。
- genericProjectContext 是当前空的 generic context seam；没有 classifier、profile 表或额外模型调用。
- 阶段切换前停止旧 Worker 并确认远程操作收尾。旧直接上传没有新 gateway fence；导入旧 pending journal 不等于能证明旧上传已停止。

有效 build evidence 复用与依赖目录恢复分开：新沙箱缺少 node_modules 时可用 pinned lockfile 执行 npm ci 恢复 runtime，不因目录重建重新编译/验收。若安装实际改变 lockfile，仍提交 Change Set，并使旧 evidence stale。自定义构建器、额外外部环境配置与复杂脚本不在当前 Vite recipe 的验证范围。


## Cutover review：收口补充

- **Authority ACL**：0006 撤回 service_role/PUBLIC/anon 对 projects 的表级 INSERT/UPDATE；service_role 仅保留非 authority 字段的列级授权。workspace_revision/state/hash/writer/epoch/build/verify/checkpoint_id 的 INSERT/UPDATE 对 authenticated、service_role、PUBLIC 均关闭，只能由 SECURITY DEFINER workspace RPC 修改。BYPASSRLS 不绕过 ACL。源码表与 snapshot 的直接 mutation 同样关闭。
- **Legacy 出口**：常规 reconcile 仍拒绝 unfenced legacy writer。管理员先停止全部旧 Worker、确认旧上传/命令/后台写入真正收尾，再用 `npm run admin:workspace-legacy -- --project <id> --sandbox <原id> --confirm-quiesced`。该 CLI 只扫描原沙箱完整 managed manifest，调用 service-only `ita_workspace_reconcile_legacy(project,old_token,sandbox,quiesced,files,hash)`，不重放写入。SQL 在项目行锁内核对每个未解决 legacy intent 的原 sandbox/database hash 与 intended hash：实际命中 intended 为 committed，实际及 DB 仍命中原基线为 not_applied；所有记录一次事务解决后才 confirmed/释放 writer，源码真实变化才增加一次 revision。存在第三值、未知 drift、缺失原 hash 字段、不同原沙箱，或重叠 intent 无法同时证明时保持 blocked。人工 attestation 是必要前提，新 flock/token 不能证明旧 SDK 上传停止。
- **多 pending 防线**：acquire/prepare/finish/commit/evidence/checkpoint 均检查 unresolved applying/partial/uncertain/conflict；不能靠只清理一个 writer 引用隐藏另一个 blocking changeset。没有实际副作用的旧 prepared 请求不属于 blocking 状态。
- **普通 reconcile 证明**：`ita_workspace_reconcile` 必须携带 p_files 与 p_hash；SQL 重算全量 manifest，并逐路径确认实际值是 DB baseline 或 recorded target（materialize 仅允许目标的相同子集）。第三值在换 token 前报错。Worker `Workspace.reconcile → gateway retire/scan → 路径核对 → RPC → activate/promote → commit` 也做相同检查；SQL 和 Worker 两层测试分别证明无继续资格。
- **Install crash**：只有受控 install 已返回且 post-scan 确认仅 lockfile drift，prepare 才能提交 p_observed_files。SQL 同事务关联 retained install writer、changeset 与 runtime_completed attestation。prepare 成功/commit 前 crash 后，新 execution retire/scan，核对 baseline/target 并提交原 changeset，不重新 install。timeout/未持久化 completion proof 的 runtime writer 不自动恢复；未知进程仍需人工核对。
- **Completion identity**：稳定 fingerprint 包含 project/task/completion_key、revision/hash、build/verify basis fingerprint、basis_id 与完整 summary。相同 key 但任一身份输入不同报 CHECKPOINT_IDEMPOTENCY_CONFLICT。execution/Worker/时间/签名 preview URL 不进入 identity；丢失响应后的原请求可在 task 已完成时读取同一 checkpoint，不重复消息。snapshot 持久化 fingerprint，禁止直接 UPDATE 或 DELETE；只有父项目已移除的正常 FK cascade 允许删除 checkpoint。

以上不是跨 Sandbox/Supabase 原子事务承诺。RPC 接受的 quiescence/returned-command proof 来自受信任 Worker 或显式管理员操作；无法证明远程进程停止时，继续保留 blocking authority。
