> **历史记录**：本文保存当时环境、artifact 与验证结果，不是当前 Demo 的操作指令。请先阅读[当前文档导航](README.md)和[历史资料说明](history.md)。

# Revised 0006 fresh rehearsal — 2026-10-08

**Fresh rehearsal 全部 PASS；Main baseline prerequisite PASS。整体 cutover 仍为 NO-GO。** 本记录绑定新版 artifact，不能替代冻结、旧副作用收尾、实际备份/恢复验证和用户最终批准。

## Identity / artifact

- Fresh target：用户确认的 `forge-cutover-v2-test / vtevambqlnezprpezqyf`。与 Main `vfzyimhapttcdxeabvur`、restore `zynvesyeqsoeqssgwubj`、旧 disposable `dfixexlufeyrdublqcxu` 不同。
- Revised 0006 SHA256：`5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782`。执行前/验证记录均绑定此 hash，六个正式 migration 的 hash 另存 manifest。
- Old `b4fd0818d33d7bcb2036ad3d1833d05c27583cbec301d27bdbea58e9020869e0` 的 PASS 仅为历史证据，见旧 [rehearsal record](workspace-cutover-validation.md)。
- `.env.cutover` 显式加载。`.env` 仅取 Main ref 作禁止目标核对，不提供 cutover credentials fallback。Main/restore env、CA、`.cutover` 和 `.cutover_OLDD` 未 track；用户原有 `.gitignore` 修改保留且不混入本轮 commit。
- 现有 CA 固定路径 `app/worker/.cutover/prod-ca-2021.crt`，没有新增 env schema。X509 CA/期限与真实 TLS 验证通过，rejectUnauthorized=true。

## Step 0 — Non-destructive preflight PASS

URL、service-role JWT、anon JWT、DB routing 同为新 ref。Service API OpenAPI 200；anon apikey-only Auth settings 200 与不存在表探针 404/PGRST205；没有把 anon 当 user session JWT。两条严格 TLS 的同时只读连接 PID `15246 / 15247`。

Public base tables=0，Forge functions=0，Forge relations/views/sequences=0。随后 migration 再重复 fresh guard，无手工近似 schema、reset SQL 或重放旧迁移。

## Step 1 — Formal migration PASS

按原文件 `0001 → 0002 → 0003 → 0004 → 0005 → revised 0006`，六个事务成功。14 表 RLS/FORCE RLS；10 个 workspace/completion RPC 的 single signature、security definer、search_path 和 service-only execute 正确；checkpoint UPDATE/DELETE trigger 存在；legacy imports=0。PostgREST 以预期 LEASE_LOST 响应确认新 RPC cache 就绪。

永久管理权限 invariant：**14 tables / 42 checks / 0 violations**。

## Step 2 — Authority / protocol PASS

- 对 14 张 Forge 表实际执行 service_role TRUNCATE 探针，全部 SQLSTATE 42501 permission denied。探针有 savepoint、外层 rollback，不保留任何清空副作用。TRIGGER/REFERENCES 的 effective privilege 同为 false。
- Service/authenticated/anon 的旧 direct files INSERT/UPDATE/DELETE 均被 ACL 拒绝；service 的八个 authority 字段 PATCH 被拒绝；checkpoint source/revision/hash/basis/evidence 的 UPDATE/DELETE 被拒绝。拒绝不能被误记为仅 RLS。
- 数据库 owner 的 checkpoint UPDATE/DELETE 仍由 immutable trigger 拒绝。
- 合法 workspace RPC、SELECT、fixture 所需 row DML、SECURITY DEFINER 执行、cross-project guards 和正常 project deletion cascade 均工作。
- 相同 completion identity 幂等返回同 snapshot/message；不同稳定 identity 拒绝。Blocker/tool_error 不创建 checkpoint；warning 可为 done_with_warnings。

这一步使用合成 protocol fixture，不是浏览器验证；真实浏览器另见 Step 4。

## Step 3 — Real PostgreSQL dual connections PASS

独立 backend PID `15909 / 15907`，SET ROLE service_role。旧/current execution、writer CAS、uncertain/partial、stale token、reconcile/takeover 与完成并发均遵守现有 protocol。

| Race | Duration | Result |
|---|---:|---|
| retired/current execution acquire | 105 ms | only current granted |
| two eligible operation acquire | 101 ms | one writer |
| reconcile vs normal writer | 110 ms | only reconcile grants continuation |
| same-key completion | 110 ms | same checkpoint; one completion fact |
| actual mutation retired/current | 111 ms | one writer; revision 2 |
| actual mutation operation CAS | 106 ms | one writer; revision 3 |

代表路径无 deadlock，未靠扩大 timeout；lock timeout 仍 5000 ms。通过合法 fail/resume/claim 更换 execution，没有手改 authority 或破坏 active task 唯一约束。

## Step 4 — Real Worker/Daytona/Chromium fixture PASS

Sandbox `721d4b79-2140-444b-94e9-04fa59f0ce50`；checkpoint `4722b30e-0df2-40f0-b04f-3a2fea3bcbb7`（已随 fixture 清理）。预先编写的 Vite React Todo，带 `lucide-react@0.468.0`，**0 次真实 LLM 调用**。

- materialize revision 0；源码 mutation revision 1；controlled --ignore-scripts install 的 lockfile drift 经 changeset 提交到 revision 2。
- 真实 build→start_dev→Chromium 验收：核心添加逻辑坏的版本为 blocker，checkpoint=0。
- 修正 mutation 到 revision 3；第二次 build/browser 为 success_with_warnings（core verified / detail warning），checkpoint 为 done_with_warnings。
- execution 更换后 materialize/runtime recovery 复用同 revision/basis 的 build/verify：额外 build=0、verify=0。
- 共 **2 builds / 2 real browser runs**；证据对应 revision/hash/basis。实际 delete RPC + sandbox destroy 清理本次 sandbox、项目数据和 Auth fixture，不删除其他沙箱。

## Step 5 — Main read-only compatibility PASS

只有 Steps 1–4 全 PASS 后才调用：

```bash
node app/backend/tests/main-baseline-reconcile.mjs --validated-rehearsal
```

检查只使用 `.env.main-cutover` 并保持严格 TLS/READ ONLY。结果：semantic drift=0；34 functions cosmetic only；RLS/columns/constraints canonical 全匹配；unresolved unsafe authority privileges=0。

**Main 当前权限未改变**：仍观察到 39 项 Forge table management grants，其中 authority 子集 18 项。PASS 指它们是可由精确 revised 0006 安全处理的迁移前兼容 baseline，不表示 Main 已硬化。

判据不是平台 allowlist：检查完整 fresh target/步骤/当前六文件 hash，拒绝旧 artifact、缺步骤、失败 guard；对 Main 当前 ACL 在本地 PGlite 重放，再执行 revised 0006 并确认 14 表管理权限全 false。未知 table、owner/inherited powers、grant option/其他 grantor 或 remaining privileges 会失败。无 proof 的默认 comparator 仍拒绝这些危险权限。新增 4 项 proof regression 加原比较器 9 项，共 13 tests PASS。

## Current boundary / retained evidence

- `.cutover/fresh-v2-rehearsal/5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782/`：各阶段原始日志、JSON results、综合 validation-record；`.cutover/fresh-migration-rehearsal.json`：fresh guard 与六文件 hash。
- Main readonly evidence 和 compatibility-result 单独保存。所有记录 ignored，日志不输出 key/password/连接串/证书内容。
- Disposable schema 保留；本次 fixture 数据和沙箱已清理，restore-test 未恢复/修改，Main 无 migration/freeze/backup/DML。
- 未证明长期高负载、真实 LLM 生成成功率或全部网络故障恢复。未开始 Phase 3，未 push/merge/deploy。
- **整体 NO-GO**：仍须批准下一步 Main operational proof，包括 paused workspace 保存与收尾、实际 freeze、DB backup/restore validation、完整 Worker 准备及最终 canary。
