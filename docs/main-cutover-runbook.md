# 主要环境 Phase 2 cutover runbook — 待确认，未执行

核对日期：2026-10-06。主项目 `vfzyimhapttcdxeabvur`；保留的 rehearsal 项目 `forge-cutover-test / dfixexlufeyrdublqcxu`。本文件是批准前的执行计划，不是执行记录。不得将 disposable 的连接、脚本或固定 ref 改一下就直接用于主要环境。

## 1. 当前已确认与未确认事实

| 项目 | 本轮只读结果 | Cutover 判断 |
|---|---|---|
| HEAD | `9e99e4c434c8077fd5a3c82eede88ec4267aed57` | Phase 2 核心已提交 |
| Phase 1 | `533f9086d7e588910d39482eeb5e4d7960613c57` — diagnostics/local capture | 本地 checkpoint |
| Phase 2 | `9e99e4c…` — workspace contract/implementation/blocker fixes/deletion harness | 本地 checkpoint |
| Working tree | **不干净**：6 个 tracked 文件修改；真实验证 scripts/记录尚未提交；reviewer 文件仍未跟踪 | 执行前整理明确 allowlist 的 validation/docs commit，排除 reviewer、凭据、debug；固定最终 RELEASE_SHA |
| Branch | 本地 main；缓存 origin/main 为 `839465e…`，本地 ahead 2 | 实时远端查询失败，不把缓存当 GitHub 当前状态 |
| CI/CD | 本地无 `.github/workflows` 或明确自动 migration 配置；有 Worker Dockerfile、Render 部署说明 | Render/GitHub App/hooks/其他平台状态未能确认，**按可能自动部署处理** |
| Task | queued 0、running 0、paused 1 | 不自动 resume/cancel paused task |
| Paused task | `e0d9c783-7de6-4a02-a219-50a24b7e55c5`；project `93a2f63a-9ec6-4194-b962-4e68dbeea80d`；execution/worker/lease 均为空 | 保留原记录、计划、代码和预算；旧项目另做 manifest 核对 |
| Preview recovery | queued/running 0；ready 7、failed 2 | 切换前再复读 pending 数量 |
| Deletion queue | pending/running/failed 均 0 | 不能因本次为 0 而省略冻结删除入口 |
| Legacy journal | 未确认 intent 0；完整扫描未发现匹配的历史 uncertain command 记录 | **不构成远程副作用已停止的证明** |
| Sandbox | 10 个项目、9 个引用；6 stopped、3 archived、0 started | 本轮没有唤醒/扫描文件系统；实际源码与 DB 差异仍未知 |
| Worker | 当前 WSL 未发现 `node src/index.js` 进程 | 未证明 Windows/其他 WSL/Render/容器/其他主机全部停止 |
| Migration | API 上 0001–0005 的关键表/字段/RPC 存在，0006 workspace 表/字段不存在 | API prerequisite surface PASS；完整 DDL、FK/index/trigger/ACL 和执行历史尚待 PostgreSQL/SQL Editor 核对 |
| Backup | 未创建主库备份；未提供主库直接连接/管理权限；本机未发现 pg_dump/psql/Supabase CLI | 恢复点尚未成立，**当前 NO-GO** |

上述是一次只读快照；实际操作前必须重新核对。可在 WSL 的 `app/backend/tests` 运行 `node main-cutover-readonly.mjs`，该脚本只 GET/read，不调用 mutation RPC、ensure/start/stop、备份或部署；catalog 检查草稿见 [main-cutover-preflight.sql](main-cutover-preflight.sql)。Migration 文件 `0006_workspace_contract.sql` SHA256：

`b4fd0818d33d7bcb2036ad3d1833d05c27583cbec301d27bdbea58e9020869e0`

## 2. 批准后仍必须满足的 Go / No-Go 门槛

1. 明确部署目标、服务名、入口、所有 Worker 实例及其自动重启来源；核对 GitHub workflows/App/webhooks 与托管平台。无法证明 push/merge 安全前，禁止 push/merge。先关闭自动 Worker deploy、自动 migration 和相关定时任务，并确认没有已排队的部署。
2. 本地 validation/docs 整理入单独 commit，工作区排除纯本地 reviewer 文件；记录最终 RELEASE_SHA、依赖锁文件和 0006 hash。完整新版 Worker 的准备/安装/离线检查在主库变更前完成。旧版本源码/镜像仅作为备份，不是迁移后的默认启动方案。
3. 提供主库只读检查/备份与执行途径：优先经过严格 TLS 的直接连接或 session pooler；SQL Editor 可完成只读 catalog 检查，但 API JSON 导出不能代替可恢复的 DDL/ACL/数据备份。实际 ref 必须仍为 `vfzyimhapttcdxeabvur`。
4. 核对 0001–0005 所需 columns、FK/index、RLS/FORCE RLS、RPC signatures/security/search_path、trigger 与 grants。SQL Editor 手工执行过的迁移未必有 migration history，不能只凭一个版本号断言正确；不得重跑 0001–0005 补齐未知差异。差异先 review，未解释前 STOP。
5. 明确冻结与 canary 通道，并证明旧页面/直接 API 不能新建任务、批准/修订计划、重试/恢复、请求 preview recovery 或删除项目；可只读访问。**当前没有现成全局 maintenance 开关，关浏览器/停 Worker/UI 灰按钮都不满足这条。**
6. 已有可用备份及隔离 restore 检查；所有远程副作用已确认收尾。缺任一项，不执行 0006。

## 3. 冻结方式：操作门闸，不新增 Phase 2 domain model

推荐维护窗口：前端显示 maintenance/read-only，同时由 DB 权限对实际 ingress 生效。实施时先捕获精确 ACL，生成可审阅的 freeze 与 unfreeze SQL；本文件不执行这些 SQL。

- 禁止 authenticated/anon/PUBLIC 对 ita_tasks 的任务 INSERT；同时撤回表级与**列级** INSERT（现有授权是 project_id/user_id/mode/prompt 列级，仅 revoke 表级不够）。
- 暂时关闭 authenticated 的 approve/revise/retry/resume、preview recovery、request deletion 入口。按 catalog 的实际签名处理，例如 approve(uuid,integer)、revise(uuid,integer,text,jsonb)、retry(uuid,text)、resume(uuid)、request_preview(uuid)、request_delete(uuid,text)。
- 全站维护时，一并冻结其他普通客户端写入口，避免备份点后的聊天/偏好/项目修改在整库恢复时丢失。必要的 pause/cancel 仅在收尾阶段保留，完成 quiescence 后关闭普通用户写入。所有 service-role 持有者/后台 job 也必须纳入停机清单。
- 不改 task status/lease 来假装任务结束，不改 project deletion_state 或 workspace state 来充当 maintenance flag，不使用 RLS 来阻挡 BYPASSRLS service-role。
- Freeze grants 必须在 0006 之后仍保持关闭；只恢复批准的 ingress ACL delta，不能重新赋予旧 service-role direct source/authority 写权限。

严格冻结期间的 canary 由受信任管理员通道提交：新 canary project/account，合法 queued task，经现有 business command/approval RPC 入队。审批调用带该 canary 用户的受控数据库用户上下文；不向所有 authenticated 恢复 EXECUTE，不伪造运行状态/lease/revision。该通道验证真实 Worker/模型主流程，**不是冻结期间普通用户 API 的端到端身份测试**。解除冻结后立即复验普通用户入口。

如果只能用普通 UI 做 canary，必须先落实仅操作者可进入的真实网络/身份门闸；不要为了 canary 临时全局开放 authenticated。这项操作方案和精确 ACL SQL须先 review，再执行。

## 4. 备份与可恢复点

在写入口已冻结、所有旧 writer/上传/命令已确认结束后建立 T0。

### 数据库

- 保存 roles、schema、data：必须涵盖所有 ita_* 表、FK/index、RLS policies、grants、函数、triggers，以及它们依赖的 auth 用户数据。若已有 supabase_migrations history，另行保存；自定义 auth/storage 对象也要单独核对。
- 使用匹配服务器版本的 pg_dump/恢复工具，或 Supabase 官方 CLI 的 roles/schema/data backup 流程。CLI 流程需要 Docker；也可使用原生 PostgreSQL 工具，不因 Worker 本身无 Docker 而跳过备份。
- 不在命令行/日志粘贴含密码的完整 URL。执行脚本从 ignored 配置/受限 PG service/password 文件读取，保持 CA 验证；不用 `set -x`。
- 如果账户实际有可用平台 backup/PITR，再记录已确认的 restore point/time；不假设当前计划免费提供或已启用。若使用逻辑备份，必须有隔离恢复验证，且恢复所需的 Auth/扩展/权限兼容问题已处理。
- 校验文件 SHA256、退出码、行数/对象数量与关键数据完整性；加密并离线保存，0600 权限、Git ignored。单纯 files/snapshots JSON 或“导出命令成功”不是完整 rollback point。
- 恢复演练使用**额外隔离目标**，不覆盖保留的 forge-cutover-test。隔离 Worker、cron、数据库 webhook 和外部连接，防止恢复出来的配置访问主要系统。

[Supabase 官方 backup/restore](https://supabase.com/docs/guides/platform/migrating-within-supabase/backup-restore)。数据库备份不包含 Storage 实际对象；若项目使用 Storage，另保留对象及设置。[备份边界](https://supabase.com/docs/guides/platform/backups)。

### 源码和运行状态

- 保留当前运行的旧 Worker artifact、锁文件、配置密封副本、启动方式、版本及日志；禁止把 .env/密钥提交 Git。
- 按 project/sandbox ID 保存 DB files、snapshots、task steps/legacy intents、approved plan 与 feedback 的关联。密封原始备份保留完整数据，报告只输出 ID/hash/状态。
- 对仍需保留的现存 workspace，保存完整实际 managed-source manifest、源码内容、hash，以及 lockfile；核对 DB 候选 revision 0 与实际源码。不能用 head-N 文件列表证明完整。
- 保留未入 DB 的 shell/source 变化、symlink/binary/超限情况和 runtime basis/config 说明。node_modules/dist/cache 可重建，不作为源码真相；不可重建资源和 Storage/外部数据库必须另存。
- 当前 6 stopped/3 archived 沙箱尚未扫描。若需唤醒导出，必须在维护窗口、所有旧 Worker 停止后受控进行；再次检查进程/上传及差异，导出后回到已确认静止状态。
- 任一 unknown drift 或 pending side effect 都 STOP；保留原沙箱/差异。不删除 lockfile/journal，不用新空沙箱掩盖未持久化修改，不以租约失效推断远程进程已停止。

## 5. 严格执行顺序

| 顺序 | 动作 | 进入下一步的证据 |
|---|---|---|
| 0 | 用户确认 runbook；固定 RELEASE_SHA；禁用/核对自动部署与 migration；准备完整新版 artifact、备份工具、维护 ACL 和 canary 通道 | 所有前置 Go 门槛满足；未 push/merge 触发未知部署 |
| 1 | 冻结新任务和其他普通用户写入口，停全部旧 Worker 与自动重启来源 | 旧页面/API 被实际阻断；所有实例停止；paused task 保留 |
| 2 | 确认 SDK 上传、同步/异步命令、detached writer、recovery/deletion 操作收尾；复读 task/queues/journals | 无未确认副作用；不能确认则 STOP，不给新 writer |
| 3 | 创建 T0 DB backup/restore point 与必要 workspace 导出；核对 prerequisite DDL/ACL | 备份及隔离 restore 验证通过；0001–0005 差异已解释 |
| 4 | 仅执行已核对 hash 的完整 0006 事务 | Schema/ACL/RPC/trigger 符合预期，cache 就绪；legacy pending 与冻结时清单相符；未重跑旧迁移 |
| 5 | 部署与 0006 匹配的完整新版 Worker artifact/config/锁文件 | 无旧实例并行；普通用户 gate 仍关闭；没有混合旧/new 源码 |
| 6 | 先运行只读 schema compatibility 与 doctor，再启动单个受控新版 Worker | Schema check 不领取任务；doctor 的最小真实模型调用明确计入消耗；queued/recovery/deletion 为 0，没有启动即意外修改旧项目 |
| 7 | 通过批准的 canary 通道跑新小型项目：Plan→Approve→Build→Verify→checkpoint | 真实模型、Daytona、browser conclusion 与完成事务有证据；不手工编辑 authority 或削弱断言 |
| 8 | 核对 changeset/revision/manifest、build/verify fingerprint、checkpoint 与完成消息；核对 pause/source-changing/evidence stale 边界 | Confirmed source；无 unresolved partial/uncertain/conflict；warning/inconclusive 真实标记；blocker/tool_error 无 checkpoint |
| 9 | 再复读所有实例/任务/queues/journals；核对 paused 旧项目的恢复计划；满足稳定观察窗口后按 ACL delta 解冻 | 队列/lease/权限一致；不误恢复旧 source grants；按实际日志判断稳定，不以固定等候时间代替证据 |
| 10 | 普通用户 API/UI 最小复验；记录 RELEASE_SHA、T0、0006 hash、canary IDs、证据与剩余限制 | 无新 blocker；自动部署是否重新开启另行确认；Phase 3 仍不启动 |

当前 paused task 不纳入自动 canary，继续保持 paused。其真实源码/DB 基线核对通过后，才能另行批准恢复。

## 6. 失败分支：默认 forward-fix，禁止旧 Worker 硬回滚

### 0006 未提交或提交结果不明

- 保持冻结及全 Worker 停止。确认连接/事务实际状态；事务失败要验证已 rollback，网络断开不能直接猜测失败或重跑。
- 若确定未提交且 schema/ACL 仍是冻结后的旧基线：可取消窗口，但恢复旧服务需重新验证 T0/schema/source 和精确 ingress grants，由用户决定，不是自动 fallback。
- 若结果未知：只读 catalog/cache 与 DB 事务核对，未确认前 STOP。

### 0006 已成功，新 Worker 启动/doctor 失败

1. 保持 0006、保持入口冻结，停止失败的新实例；**不重启旧 Worker，不恢复 service-role direct files/authority grants**。
2. 优先修部署 artifact、依赖安装、Node/config、网络/cache；使用与 0006 兼容的已批准修复 artifact，重跑 schema/doctor/canary。若需数据库修复，另 review 狭窄的后续迁移，不改 authority/revision 或删 journal。
3. Source/runtime 已发生不确定副作用时，先确认实际进程/上传收尾并 reconcile；不能确认就持续隔离，不靠加预算/重试强行运行。
4. 如果必须撤回 0006：只有全新 writer 已停止、T0 备份及实际 workspace 恢复可验证、迁移后写入的处理方案已批准，才做明确的 DB+runtime 协同恢复。不是仅 git revert，也没有未经验证的 0006 down migration。
5. 有迁移后 canary/用户写入时，整库恢复可能丢数据；先保存新产生的 changesets/checkpoints/evidence 和对应源码，明确接受损失或制定回放方案，不能无声覆盖。
6. 恢复旧 DB 不会恢复 Sandbox/Storage/外部业务数据库。若选择回到 T0，必须同时恢复/重建明确基线的 runtime/source，再验证旧 artifact/schema 的配对；新旧 writer 仍不能并行。

### 统一 STOP 条件

Unexpected workspace state、permission/signature mismatch、unknown drift、partial/uncertain/blocking changeset、未确认 command/upload、重复 completion fact、source 与 evidence basis 不匹配或 checkpoint 出现 blocker/tool_error 时，都停止切换/解冻。通过现有合法 reconcile 或经 review 的修复处理；不得手改 revision/state、删 journal、降低验收标准来解锁。

## 7. 当前等待确认的事项

- 用户确认本 runbook。
- 外部 CI/CD 与所有 Worker 实例清单/停止和重启控制。
- 主库 catalog 检查结果或严格 TLS 连接、备份/恢复权限与工具，以及独立恢复目标。
- 精确冻结/unfreeze ACL、受控 canary 通道与旧 paused 项目的 workspace 保存/恢复计划。

Disposable Supabase 保留，不清空、不删除，供后续 Phase 3 transactional/concurrency validation 使用。本轮不执行上述主要环境动作。
