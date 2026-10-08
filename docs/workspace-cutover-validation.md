# Disposable cutover rehearsal — 2026-10-06

> 最新状态：revised 0006 的 **fresh v2 rehearsal 与 Main 只读 baseline compatibility 均 PASS**；以下旧记录保留历史上下文。整体仍 NO-GO，见 [新版真实验证记录](workspace-cutover-validation-v2.md)。


> **2026-10-08 artifact update：NO-GO。**当前 0006 已收紧 Forge table-management privileges；新版 hash 为 `5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782`。旧 `b4fd…` rehearsal PASS 仅作历史记录，不验证新版。Fresh migration/authority/concurrency/Daytona rehearsal 尚未执行，见 [新版验证记录](workspace-privilege-hardening-validation.md)。


结论：Step 1–4 通过。仅操作 `forge-cutover-test / dfixexlufeyrdublqcxu`；主要项目 `vfzyimhapttcdxeabvur` 未迁移、未部署，Phase 3 未开始。

## 前置检查

- `.env.cutover` 显式 file-only 加载，拒绝主要项目、跨项目 key/ref、重复配置与身份错误。没有继承主要环境的 Supabase 请求目标。
- PostgreSQL 使用用户下载的 `prod-ca-2021.crt`，保持 `rejectUnauthorized: true`，TLS stream 确认 authorized/encrypted。
- 两条同时保持的只读连接 PID 为 `17862 / 17865`；public schema 迁移前为 0 张表。
- Public-key sanity 使用 `apikey`-only 的 `/auth/v1/settings` 和不存在表的 Data API 探针（预期 `404/PGRST205`）。OpenAPI root 只用于管理员检查；原先用 root 判 anon 无效的测试逻辑已修正。

## Step 1 — 正式 migration

按仓库原文件执行 `0001_init → 0002_plan_review → 0003_deletion_retention → 0004_task_pause → 0005_preview_recovery → 0006_workspace_contract`，六个事务均成功，没有近似 schema 或手工补建。

核对：14 张业务表 RLS/FORCE RLS；10 个 workspace/completion RPC 单一签名、SECURITY DEFINER、安全 search_path、service-only execute；private helpers 对客户端关闭；checkpoint UPDATE/DELETE trigger 存在。Projects/changesets/legacy changesets 均为 0。真实 PostgREST 对 impossible execution 的 read RPC 返回预期 LEASE_LOST，确认缓存已经解析新 RPC。

不要求整套 migration 可重复执行。`cutover-migrate.mjs` 要求 public schema 为空；当前 rehearsal 环境已经迁移，不应重新运行该入口。已有环境不重跑 0001–0005。

## Step 2 — 真实 API 权限与协议

使用 disposable 的真实 Auth 用户/session、service-role 与 anon，通过 PostgREST：

- 三种身份 direct files INSERT/UPDATE/DELETE 均返回 SQLSTATE 42501 permission denied；service-role 的保护来自 ACL，非 RLS。
- Service-role 对八个 workspace authority 字段的直接 PATCH 全部被 ACL 拒绝，合法 workspace RPC 正常运行。
- Cross-project execution 返回 LEASE_LOST；跨所有者删除 RPC 被 ownership guard 拒绝。另一个用户读不到项目则为 RLS 空行 projection，和 ACL 拒绝分开记录。
- Snapshot files/revision/hash/basis/evidence/completion fingerprint 的 direct UPDATE 与 DELETE 被 ACL 拒绝。数据库 owner SQL 的 UPDATE/DELETE 也触发 CHECKPOINT_IMMUTABLE，验证了 trigger 本身。
- 同完成 identity 返回同 snapshot；不同 build/verify basis、basis_id、summary 返回 CHECKPOINT_IDEMPOTENCY_CONFLICT。只生成 1 个 snapshot 和 1 条 completion message。
- Blocker/tool_error 禁止完成；warning 可完成为 done_with_warnings。正常 request/claim/complete deletion RPC 的 checkpoint/changeset cascade 成功。

本步 evidence 是明确标为 protocol_smoke_only 的合成协议 fixture，不是浏览器执行证明。

## Step 3 — 真实 PostgreSQL 并发

独立 backend PID `21395 / 21397`；通过现有任务 fail/resume/claim 流程更换 execution，不改 authority、租约或绕过单项目活动任务唯一约束。

| 竞争路径 | 结果 | 耗时 |
|---|---|---:|
| 退役 / 当前 execution acquire | 旧 execution LEASE_LOST，当前获得唯一 writer | 212 ms |
| 同一合法 execution 两个 operation acquire | 一个获得 writer，一个 RECONCILE_REQUIRED | 208 ms |
| reconcile / normal writer acquire | 原请求获得新 token，新目标仍被拒绝 | 222 ms |
| 同 completion identity 并发完成 | 两边返回同 checkpoint，snapshot/message 各 1 条 | 222 ms |

补充实际 `kind=mutation` Change Set 的竞争：退役/当前 execution 为 227 ms，两个合法 operation 的 CAS 为 233 ms；均只授予一个 token，获胜请求经 commit 形成 revision 2/3，测试 fixture 已清理。

额外验证：partial 与 uncertain 保持 fence，未 reconcile 前 normal acquire 被拒；旧 token 不能 commit。锁等待上限 5 秒，代表性路径未复现 lock timeout/deadlock。这是有限的真实多连接测试，不是所有调度顺序、扩容或长期负载的证明。

## Step 4 — Fresh Daytona

使用预写的 React/Vite/TS Todo fixture，真正依赖 `lucide-react@0.468.0`，复用现有 Workspace gateway、runtime policy、design-token 生成函数和 Playwright runner。没有模型调用，也不宣称模型生成成功率。

首次 harness 遗漏脚手架所导入的 `src/design-tokens.css`，构建返回 1，未进入浏览器或创建 checkpoint。保留了失败事实；仅修 fixture 生成并增加失败输出，未改平台架构或运行 contract。核对 owned labels 与 confirmed/no writer 后清理失败沙箱 `5469962d-f182-48d9-a328-78a1ef21f674`，再 fresh 重跑。

成功重跑 sandbox：`87b71181-15f4-4171-813f-bb4da7a5a8b5`。

- Fresh materialize revision 保持 0；managed source Change Set 变为 1；受控 install 使用 --ignore-scripts，lockfile drift 通过 Change Set 提交为 2。
- 两次实际 Vite build、两次实际 Chromium 检查。首个 fixture 的核心添加按钮没有实现效果，浏览器判 blocker，completion RPC 拒绝，snapshot 数量保持 0。
- 经正常 Change Set 修正核心交互，revision 变为 3，旧 build/verify evidence 清空；再次构建/验收后，添加→完成→删除均 verified，故意缺失的说明文案为 detail warning。
- 更换 execution 后重新 ensure/materialize/start runtime：revision/hash/两种 fingerprint 相同，原 evidence 保留，新增 build/verify 为 0。该测试没有人为停止整个 Sandbox，不作为长期自动唤醒可用性证明。
- Checkpoint `ef60784f-b8c3-4ff5-bbbc-126a04d35b0c` 绑定 revision 3、实际 code hash/build/verify fingerprints，任务 phase 为 done_with_warnings；重复完成不创建新快照。
- Inconclusive 可发布的协议语义已在 Step 3 用真实数据库验证；tool_error 禁止发布已在 Step 2 验证。没有额外注入真实浏览器故障，不冒充该场景的端到端验证。
- 测试生成过截图（失败 3 张、成功 2 张），未进行人工视觉审查；截图随临时 Sandbox 清理，不属于长期归档。

本轮创建的两个 Daytona 沙箱均已删除。成功项目通过正常两阶段删除队列清理，测试 Auth 用户也已删除；数据库保留正式 schema 与审计事实。只读收尾 inventory 确认 projects/tasks/changesets/snapshots/fixture users 均为 0。

## 入口与边界

在 `app/backend/tests` 运行：

```bash
node --test cutover-config.test.mjs cutover-public-key.test.mjs # 6 个离线检查
node cutover-config-check.mjs                               # 只读 preflight
node cutover-migrate.mjs                                    # 仅空白 disposable，不能重跑
node cutover-authority.mjs
node cutover-concurrency.mjs
node cutover-concurrency-mutation.mjs
node cutover-daytona.mjs                                    # 创建/删除真实临时沙箱，会消耗 Daytona 资源
```

真实 scripts 固定 approved disposable ref；config/CA 保持 Git ignored。不打印 key/password/完整连接串，不默认上传 prompt 或本地调试内容。

下一步仍是用户决定主要开发环境的切换时机：停止旧 Worker、确认远程副作用收尾、备份、执行 0006、完整新版 Worker、doctor 与小型 Plan→Approve→Build→Verify→checkpoint。此次 rehearsal 不代替主要环境备份或已有 legacy pending 的人工核对，也没有自动执行该切换。
