> **历史记录**：本文保存当时环境、artifact 与验证结果，不是当前 Demo 的操作指令。请先阅读[当前文档导航](README.md)和[历史资料说明](history.md)。

# Main cutover · Stage A readiness（2026-10-08）

**结论：NO-GO。** 本轮只完成连接、只读检查、工具与待执行程序准备。Main 未 freeze、未 backup、未 restore、未执行 0006。未 push/deploy，Phase 3 未开始。Stage B 仍需用户批准。

## 已确认的事实

- Main 固定为 `vfzyimhapttcdxeabvur`；restore target 固定为 `forge-main-restore-test / zynvesyeqsoeqssgwubj`。Main/restore 分别显式加载 `.env.main-cutover` / `.env.main-restore`，没有其他 env fallback。
- Restore target：严格 CA 校验通过，Node PostgreSQL 连接和原生 PG17/libpq 连接都通过；原生只读事务 PID `8915`。CA 来自 `app/worker/.main-restore/prod-ca-2021.crt`。没有修改证书或关闭验证。
- Restore target PG `17.11`，public table / Forge function / Auth user / Storage object 均为 0；当前适合作为恢复验证目标。正式恢复前必须再次检查所有 Auth 数据表、Storage buckets、public schema 是否仍空。
- Main PG `17.6`，只读事务检查通过，0006 尚未安装。已确认的 Main baseline compatibility 沿用 revised artifact 的真实验证记录，不再调查已解释的 rendering 差异。
- 两端 26 张 Auth 数据表列类型兼容，外键一致且无循环；target INSERT 权限满足，启用的非 FK Auth trigger 为 0。两端均无 `SET session_replication_role` 权限。恢复采用正常 COPY + 外键顺序，不关闭约束、不提升权限；保留 restore target 的 `auth.schema_migrations`。
- Main queued/running task `0/0`，paused `1`；preview/deletion 无 queued/running 工作；未发现 unresolved legacy journal 或 uncertain command 标记。现有 9 个 sandbox 为 5 stopped、4 archived、0 started。
- WSL 未发现 `node src/index.js`。用户确认只有 WSL 手动 npm start，无 cloud/systemd/pm2/Docker 或自动重启。push/merge 的外部自动部署行为仍 UNKNOWN，因此本轮禁止 push/deploy。
- Secrets、证书、`.cutover*`、`.main-restore`、local records/tools/archive 都不纳入 Git。

Private records：`app/worker/.cutover/stage-a-2026-10-08/`。包含 restore preflight、Main operational metadata、Auth compatibility/rights、原生 TLS 只读查询及 Main gate SQL preview；不是备份。

## Paused task：保留，不能假定迁移后可 resume

Task `e0d9c783-7de6-4a02-a219-50a24b7e55c5`；project `93a2f63a-9ec6-4194-b962-4e68dbeea80d`；sandbox `9394813e-2d8d-4ccf-8642-5c9e95e0f570`（archived）。Execution/worker/lease/heartbeat 为空，最后工具为 read_file。Plan 为已批准 v1，4 条旧 acceptance 缺少 severity；本轮不修改任务、计划或 journal。

持久化来源为 `ita_files` 中 10 个文件，code hash `2596fb9972332c1fc0db96b6b211e58bbec51541b160950657b19d1c9be49b8a`。该 project 无 snapshot，DB 文件中无 package-lock。保留 task、plan、messages、logs、DB files 和 sandbox。

Claim RPC 仅领取 queued 或过期 running，Worker 没有自动 resume paused 的路径。但是普通用户目前仍有 resume/retry RPC EXECUTE 权限。Freeze 会关闭这些入口；完整 unfreeze 会恢复捕获的权限，**不会自动建立旧任务永久隔离**。最终解冻前需要明确此旧任务的继续隔离/取消处置，不能直接假定旧任务兼容新版。

**尚未确认：** archived sandbox 的实际源码 manifest、DB 之外的 lockfile/资源及历史 upload/command 收尾。当前不唤醒、不扫描、不导出该 sandbox。Stage B 中先确认旧执行真正收尾，再受控保存实际 managed source，比较 DB 来源；其他引用 sandbox 也检查不可重建内容。差异或旧副作用无法确认时保持 NO-GO。

## 待执行 freeze / canary / unfreeze

以下命令从 repo 根目录执行。**本轮没有执行。** `--ack-main-maintenance` 是目标防误操作参数，不能代替用户批准。

```bash
# Stage B 批准后，重新捕获当时 ACL；文件不能覆盖。先审阅生成的 SQL。
node app/backend/tests/ops-ingress-gate.mjs --target main --mode capture --snapshot app/worker/.cutover/main-ingress-final.json --ack-main-maintenance
node app/backend/tests/ops-ingress-gate.mjs --target main --mode freeze --snapshot app/worker/.cutover/main-ingress-final.json --ack-main-maintenance
node app/backend/tests/ops-ingress-gate.mjs --target main --mode verify --snapshot app/worker/.cutover/main-ingress-final.json --ack-main-maintenance
node app/backend/tests/ops-ingress-gate.mjs --target main --mode canary-only --snapshot app/worker/.cutover/main-ingress-final.json --ack-main-maintenance

# 最终 migration/匹配 Worker/doctor/schema check 后才运行实际 LLM canary。
node app/backend/tests/ops-canary-enqueue.mjs --target main --mode plan --user <EXISTING_AUTH_USER_UUID> --project <NEW_PROJECT_UUID> --prompt-file app/worker/.cutover/canary-prompt.txt --ack-main-maintenance
node app/backend/tests/ops-canary-enqueue.mjs --target main --mode approve --user <SAME_USER_UUID> --project <SAME_PROJECT_UUID> --plan <PLAN_UUID> --version <APPROVED_VERSION> --ack-main-maintenance

# 真正稳定且旧 paused task 处置确认后，另外批准精确解冻。
node app/backend/tests/ops-ingress-gate.mjs --target main --mode unfreeze --snapshot app/worker/.cutover/main-ingress-final.json --ack-main-maintenance
```

Gate 关闭普通 anon/authenticated 的 Forge row/column DML 和 RPC EXECUTE，保留 SELECT；管理连接的受控 canary 不给普通客户端重新授权。Main 当前可捕获 32 项 grants，SQL 仅生成 preview。Gate 已有 disposable 真实验证；本轮未改它的逻辑。它不阻止 service-role/管理员后台操作，也不冻结 Supabase Auth 注册，所以不能代替停 Worker 与导出一致性检查。

## Quiescence：真正 backup 前的门槛

1. Freeze 验证成功；停止 WSL 的旧 npm start，确认 `/proc/*/cmdline` 没有对应 Worker，用户确认没有其他手动实例或启动源。
2. 重跑 `node app/backend/tests/main-stage-a.mjs`，核对 tasks/lease/heartbeat、preview/deletion queue、legacy journal 与 workspace writer；不是只看 lease 是否过期。
3. 核对每个引用 sandbox 的真实 session/command exit 状态和待上传写入，确认旧进程/请求不能迟到写入。stopped/archived 的状态只是线索，不单独充当 upload 收尾证明。
4. 保存必要 physical managed source、lockfile、未入 DB 的文件/资源；证明它们可重建或有独立封存来源。**未确认旧 writer 停止时不授予新 writer；不通过删 journal 或手改 state/revision 解锁。**

目前 process/DB/sandbox 状态已知；远程副作用 quiescence 与 physical source 完整性仍 UNKNOWN。这两项必须在 Stage B 闭环，不应在本报告中冒充 PASS。

## Backup → restore-test 的实际程序

原生工具已准备：PG17.11 pg_dump/pg_restore/psql，来自验签和 SHA256 校验过的 PGDG 包，解压到 ignored `.cutover/tools/pg17/`，没有 system install、Docker 或本地数据库服务。`ops-pg-client.mjs` 固定目标 ref、显式 env、CA/hostname 校验；清除继承的 PG 配置，用 0600 临时 pgpass，不把口令放在 argv/log。Main native connection 默认 read-only；仅允许 Session/direct 5432，不使用 transaction pooler。

**仅在用户批准 Stage B 且 freeze + Worker stopped + remote quiescence 已确认后：**

```bash
mkdir -p app/worker/.cutover/backups
node app/backend/tests/ops-backup-main.mjs --directory app/worker/.cutover/backups/main-T0-<UNIQUE_TIME> --ack-stage-b-quiesced

# 必须重新验证空 target 与 Auth schema/rights；检查 backup manifest 和所有 archive hash。
node app/backend/tests/restore-stage-a.mjs
node app/backend/tests/auth-restore-compatibility.mjs
node app/backend/tests/auth-restore-rights.mjs
node app/backend/tests/ops-restore-main-backup.mjs --directory app/worker/.cutover/backups/main-T0-<SAME_TIME> --ack-stage-b-restore
```

Backup 在 Main repeatable-read/read-only transaction 中 export 一个 snapshot；public 完整 custom archive 和 Auth data archive 共用该 snapshot，避免多次 dump 的时点不一致。保存函数/trigger/RLS/ACL、关键 row counts 和逐表内容 hash。Auth managed migration history 与平台 schema/roles/password 不复制；当前 custom roles、Storage objects/buckets、Vault secrets 为 0。若 Stage B 发现新增平台数据/角色/对象，应先 STOP 补范围，不能沿用“为空”假设。

Restore script 硬编码 Main source ref 与独立 target ref，验证 archive hash、空 target；**不建立 Main connection**。只在 target 用一个事务依次恢复 public pre-data → 拓扑排序的 Auth data → public data → public post-data（FK/triggers/ACL），失败 rollback。不 clean/drop 平台 schema、不执行 0006。恢复后比较 counts、全部被备份表的内容 hash（含 files/snapshots/paused 数据）、functions/triggers/ACL/RLS，以及 paused task→project/plan/files/messages/snapshots 关系。

当前工具已通过 offline guard/syntax checks 和原生 restore-target 只读 TLS 查询；**实际 dump/restore 未执行，因此恢复能力尚未验证。** 在 Stage B 实际 PASS 前不能把这些脚本当作已验证灾备保证。恢复后还需对照代表性文件/快照、检查 Main 只读审计/状态没有来自恢复脚本的写入；若 catalog rendering 有差异，做结构化比较，不通过删除空白或忽略 ACL 让结果通过。

## 新 Worker artifact 与失败边界

候选基线 `2f989110697d808c4109d247371ffc37fb6a0015` 包含 Phase 1 `533f908`、Phase 2 `9e99e4c`、blocker/validation fixes、privilege hardening `f9d199d` 和 fresh rehearsal `2f98911`。0006 SHA256 必须为 `5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782`。

Worker src/package/lock 与已独立 npm ci、192 tests/check PASS 的 `08ac080` artifact 完全一致；本轮没有重跑无变化的 Worker 大套测试。当前新增 operational helpers 单独离线检查。发布包从明确 commit 的 tracked 文件导出，排除 env、证书、review、debug 和 local backup；不复制带真实配置的目录。

0006 后 Worker 启动失败：保持冻结，停失败实例，先对匹配版本的 artifact/config/依赖/网络做 forward-fix；不启动旧 Worker，不恢复旧 direct source 权限。若必须 rollback，只有已实际恢复验证的 T0 数据库 + 匹配旧源码/runtime 才能成为恢复点，并处理 migration 后新增写入的保存/回放/损失。无已验证 down migration；git revert 不等于 DB rollback，restore-test 是验证目标，不替代 Main。

## Stage A checklist

| 项目 | 状态 | 边界 |
|---|---|---|
| code/artifact ready | PASS | 明确 commit 链；Worker 没变，独立测试证据可复用；用户 `.gitignore` 未提交修改单独保留 |
| Main identity confirmed | PASS | 固定 ref，严格 TLS，只读 |
| Main baseline compatible with revised 0006 | PASS | fresh revised rehearsal + Main compatibility 已确认；没有重跑调查 |
| restore target identity confirmed | PASS | Node + native PG 实际只读连接；target 与 Main 不同 |
| paused task safely isolated | UNKNOWN | 不自动领取；DB 源码保留，但 physical source/旧副作用及最终解冻后的手动 resume 处置未闭环 |
| all old Worker locations understood | PASS | 用户确认仅 WSL 手动启动；当前 process 0，Stage B 再复验 |
| quiescence procedure ready | PASS | 过程明确；真正 remote quiescence 尚未证明 |
| ingress freeze procedure ready | PASS | capture/verify/原子 ACL gate 已有 disposable 证据；Main 尚未应用 |
| controlled canary path ready | PASS | 管理通道、现存 Auth 用户已确认；实际主库 canary 尚未运行 |
| backup command ready | PASS（procedure only） | 原生 PG17、共享 snapshot、目标/TLS guard；未 backup |
| restore validation procedure ready | PASS（procedure only） | 空目标检查、正常 FK/COPY、hash/count/catalog/关系验证；未 restore |
| rollback/forward-fix boundary ready | PASS（procedure only） | 优先 forward-fix；最终 rollback 依赖 Stage B 实际验证的 T0 |
| revised 0006 hash confirmed | PASS | exact `5bea…a782`，未改 migration |
| push/deploy still disabled | PASS | 本轮未执行；外部自动部署触发行为仍 UNKNOWN |

**总体 NO-GO。** 此处 procedure ready 不等于 ingress frozen、remote quiesced 或 backup/restore validated。Stage A 到此停止，等用户批准下一步；在上述 actual proof 全部 PASS 前不执行 Main 0006。
