# Revised 0006 privilege hardening — pending fresh rehearsal

日期：2026-10-08。**NO-GO。**Main、restore-test、旧 disposable 均未操作；未 freeze/backup/deploy/push，Phase 3 未开始。

## Artifact identity

- Revised 0006 SHA256：`5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782`。
- Historical 0006 SHA256：`b4fd0818d33d7bcb2036ad3d1833d05c27583cbec301d27bdbea58e9020869e0`；旧 disposable PASS 只验证旧 artifact。
- 新版真实验证状态：**PENDING**。没有用旧已迁移数据库叠加新版 0006，也没有挪用 restore-test。

## Narrow change

0006 事务末尾扫描当前 `public.ita_` 字面前缀的 ordinary/partitioned tables，显式 REVOKE TRUNCATE/TRIGGER/REFERENCES。API roles 中 PUBLIC/anon/authenticated/service_role 均关闭这三项管理权限，避免 PUBLIC 授权成为 service-role 的继承旁路；SELECT、允许的 row DML 和 RPC execute 不变。

没有 ALL TABLES IN SCHEMA public，没有 ALTER DEFAULT PRIVILEGES。`itax_non_forge` 不匹配字面前缀，测试确认其原授权不变。新建 Forge 表必须由对应 migration 显式收紧，不能依赖 0006 对未来表的授权。

## Permanent invariant

`forge-table-privileges.mjs` 对所有当前 Forge tables 调用 has_table_privilege(service_role,…)，三项权限默认必须 false；code-only allowlist 当前为空，未来例外必须有明确表名、权限及说明，不能 env 覆盖。

专项测试显式模拟 Supabase default ALL table grants，再执行正式 0001→revised 0006。扫描 14 表 / 42 privilege checks；源码/checkpoint/authority 的实际 SQL TRUNCATE 被权限拒绝。测试保留 Worker SELECT、metadata/message row DML、SECURITY DEFINER RPC execute 与调用、project deletion cascade。创建一个未来 Forge 表而不硬化权限会使 invariant fail，证明 default ACL 泄漏不会被静默跳过。

专项测试会自动加载后续编号 migration。Invariant 也接入现有 workspace/deletion regression、real migration inventory 和 authority smoke。真实 authority smoke 使用 service_role + SAVEPOINT 发起实际 TRUNCATE，要求 SQLSTATE 42501；全部探针处于事务内并 rollback，即使存在授权错误也不保留清空副作用。

## Executed offline checks

| Check | Result |
|---|---|
| 0001 RLS SQL regression | PASS，51 reported cases |
| Plan SQL regression | PASS，55 reported cases |
| Pause SQL regression | PASS |
| Preview recovery SQL regression | PASS |
| Deletion，实际加载 revised 0006 | PASS，51 reported cases |
| Workspace，实际加载 revised 0006 | PASS |
| Baseline comparator / privilege invariant / config / public-key offline tests | PASS |
| Changed real rehearsal scripts syntax / diff-check | PASS |

完整离线输出与 hash 绑定记录位于 ignored `app/worker/.cutover/revised-0006-offline/5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782/`。这些结果不是 real PostgreSQL concurrency、Daytona 或模型生成的验证。Worker 业务源码未改，未重复无关的 frontend/Worker suites。

```bash
cd app/backend/tests
npm run test:privileges
```

## Fresh disposable required — user operation

当前 Free 配额由 Main 与 restore-test 使用，旧 cutover 项目已暂停。用户按配额需要暂停 forge-main-restore-test，再创建一个独立 fresh disposable（例如 forge-cutover-v2-test），不能 reset Main、不能改 restore-test 作为 rehearsal。

将新项目四项 CUTOVER_* 填入 ignored app/worker/.env.cutover，回复 project name/ref 并确认尚未执行 Forge migration，不发送 secret。现有 common target guard 仍锁定旧批准 ref；只有新 ref 由用户确认后才定向更新 guard，不能删掉保护或自行猜测目标。Main / restore 的 identity 都需拒绝成为 rehearsal target。

随后先严格 TLS、public/service role、target identity 和 fresh schema guard；fresh guard 要求 public base tables=0 且没有任何旧 Forge functions/views/sequences。保留 Main/restore 不动。按以下顺序逐步执行，任何 FAIL 停止：

```bash
node app/backend/tests/cutover-migrate.mjs
node app/backend/tests/cutover-authority.mjs
node app/backend/tests/cutover-concurrency.mjs
node app/backend/tests/cutover-concurrency-mutation.mjs
node app/backend/tests/cutover-daytona.mjs
```

Migration rehearsal 记录六个文件 hash、fresh guard 和 privilege scan。并发脚本保留双连接 writer/reconcile/completion 路径。Daytona fixture 仍为带 lucide-react 的 Vite Todo，真实 materialize→mutation→controlled install→build→verify→checkpoint，**不调用真实 LLM**，只清理本次自行创建资源。

所有真实步骤 PASS 后才建立新版综合 rehearsal record，再重跑 Main 只读 baseline。届时将“观察到的 pre-migration extras”与“新版迁移已验证能处理的 known grants”分开：实际 Main 权限保持原状，只有未被验证覆盖的 unsafe grants 才作为 unresolved gap。当前不能提前把这个 gap 置零，也没有运行 Main comparator。

## Current status

- Local fix / invariant / offline regressions: PASS。
- Fresh disposable migration/authority/concurrency/Daytona: PENDING_USER_CONFIGURATION。
- New hash verified by real rehearsal: NO。
- Main baseline prerequisite: NO-GO，等待新版完整真实验证，不提前修改 Main ACL。
