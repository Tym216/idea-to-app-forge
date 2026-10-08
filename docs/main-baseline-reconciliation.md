# Main baseline reconciliation — 2026-10-08

> 最新状态：revised 0006 的 **fresh v2 rehearsal 与 Main 只读 baseline compatibility 均 PASS**；以下旧记录保留历史上下文。整体仍 NO-GO，见 [新版真实验证记录](workspace-cutover-validation-v2.md)。


> 后续状态：0006 已本地修正，旧 hash / 未修改描述是本次历史 reconciliation 的记录。新版仅离线 PASS，fresh real rehearsal 仍 pending，见 [新版验证记录](workspace-privilege-hardening-validation.md)。


**Main baseline: FAIL / NO-GO。**函数、RLS 与约束表示差异已消除；真实 table privileges 留下 protocol bypass，旧 0006 未处理。仅 Main SELECT / read-only transaction、本地 PGlite 和代码检查；没有 Main migration/freeze/backup、restore 连接、push/deploy 或 Phase 3。

## Functions

- cosmetic/rendering only: **34**
- operational metadata difference: **0**
- semantic difference: **0**

逐项比较 identity arguments、包括 default arguments 的完整 arguments、return type、language、volatility、strict、security definer/invoker、parallel、leakproof、kind/returns_set、proconfig/search_path、owner、direct EXECUTE ACL（grantee/grantor/grant option）、effective EXECUTE 以及 prosrc body。

Main 的 34 个 body 均为 CRLF，本地均为 LF；34 个 body 在安全 EOL 规范化后相同。整个 pg_get_functiondef 也有 **34/34** 个仅转换 CRLF/LF 后完全相同。本次没有需要提交的 semantic body diff，也未发现 PostgreSQL formatter 引入其他逻辑差异。

新 fingerprint 使用结构化字段和 body，raw rendered hash 只作诊断。body 不删空白或注释，不合并 token；单引号、双引号、dollar-quoted literal 内的字节保留。之后若 body 仍不同，保存 whole-body unified diff 与属性差异，而不猜测为 cosmetic。owner/EXECUTE 的变化也不能静默忽略。

| Function | Classification |
|---|---|
| `ita_approve_plan(p_plan_id uuid, p_version integer)` | cosmetic/rendering only |
| `ita_audit(p_actor uuid, p_action text, p_result text, p_request_id text, p_metadata jsonb)` | cosmetic/rendering only |
| `ita_block_deleting_project()` | cosmetic/rendering only |
| `ita_cancel_task(p_task_id uuid)` | cosmetic/rendering only |
| `ita_claim_preview_recovery(p_worker_id text)` | cosmetic/rendering only |
| `ita_claim_project_deletion(p_worker_id text, p_lease_seconds integer)` | cosmetic/rendering only |
| `ita_claim_task(p_worker_id text, p_lease_seconds integer)` | cosmetic/rendering only |
| `ita_complete_project_deletion(p_project_id uuid, p_worker_id text, p_attempts integer, p_ok boolean, p_error text, p_request_id text)` | cosmetic/rendering only |
| `ita_control_task(p_task_id uuid, p_action text)` | cosmetic/rendering only |
| `ita_heartbeat_task(p_task_id uuid, p_worker_id text, p_execution_id uuid, p_lease_seconds integer)` | cosmetic/rendering only |
| `ita_owns_project(p_project_id uuid)` | cosmetic/rendering only |
| `ita_pause_task(p_task_id uuid)` | cosmetic/rendering only |
| `ita_plans_audit_approval()` | cosmetic/rendering only |
| `ita_projects_guard_deleting()` | cosmetic/rendering only |
| `ita_projects_guard_runtime_fields()` | cosmetic/rendering only |
| `ita_purge_audit_log(p_retention_days integer)` | cosmetic/rendering only |
| `ita_request_id(p_request_id text)` | cosmetic/rendering only |
| `ita_request_preview_recovery(p_project_id uuid)` | cosmetic/rendering only |
| `ita_request_project_delete(p_project_id uuid, p_request_id text)` | cosmetic/rendering only |
| `ita_resolve_memory_suggestion(p_id uuid, p_accept boolean, p_request_id text)` | cosmetic/rendering only |
| `ita_resume_task(p_task_id uuid)` | cosmetic/rendering only |
| `ita_retry_task(p_task_id uuid, p_kind text)` | cosmetic/rendering only |
| `ita_revise_plan(p_plan_id uuid, p_version integer, p_feedback text, p_answers jsonb)` | cosmetic/rendering only |
| `ita_set_memory_enabled(p_memory_id uuid, p_enabled boolean, p_request_id text)` | cosmetic/rendering only |
| `ita_submit_task_feedback(p_task_id uuid, p_category text, p_note text)` | cosmetic/rendering only |
| `ita_tasks_assign_round()` | cosmetic/rendering only |
| `ita_tasks_force_initial_state()` | cosmetic/rendering only |
| `ita_update_preview_recovery(p_project_id uuid, p_worker_id text, p_execution_id uuid, p_phase text, p_url text, p_error text)` | cosmetic/rendering only |
| `ita_upsert_memory(p_scope text, p_key text, p_value text, p_project_id uuid, p_weight integer)` | cosmetic/rendering only |
| `ita_worker_check_lease(p_task_id uuid, p_worker_id text, p_execution_id uuid)` | cosmetic/rendering only |
| `ita_worker_save_plan(p_task_id uuid, p_worker_id text, p_execution_id uuid, p_kind text, p_content jsonb)` | cosmetic/rendering only |
| `ita_worker_suggest_memory(p_task_id uuid, p_worker_id text, p_execution_id uuid, p_key text, p_value text)` | cosmetic/rendering only |
| `ita_worker_update_task(p_task_id uuid, p_worker_id text, p_execution_id uuid, p_patch jsonb)` | cosmetic/rendering only |
| `ita_worker_upsert_memory(p_task_id uuid, p_worker_id text, p_execution_id uuid, p_scope text, p_key text, p_value text, p_weight integer)` | cosmetic/rendering only |

## Privileges

以下 12 表按 has_table_privilege 实测；每项均有效，direct ACL grantor 都为 postgres，grantee 都为 service_role，grant option=false。

| Table | TRUNCATE | TRIGGER | REFERENCES | Direct grant |
|---|---|---|---|---|
| `ita_audit_log` | true | true | true | `postgres` → `service_role` |
| `ita_files` | true | true | true | `postgres` → `service_role` |
| `ita_memories` | true | true | true | `postgres` → `service_role` |
| `ita_memory_suggestions` | true | true | true | `postgres` → `service_role` |
| `ita_messages` | true | true | true | `postgres` → `service_role` |
| `ita_plan_feedback` | true | true | true | `postgres` → `service_role` |
| `ita_plans` | true | true | true | `postgres` → `service_role` |
| `ita_project_deletions` | true | true | true | `postgres` → `service_role` |
| `ita_projects` | true | true | true | `postgres` → `service_role` |
| `ita_snapshots` | true | true | true | `postgres` → `service_role` |
| `ita_task_feedback` | true | true | true | `postgres` → `service_role` |
| `ita_tasks` | true | true | true | `postgres` → `service_role` |

- service_role 没有父角色继承，且不通过 owner 权限获得这些能力，不能将结果归因于“检查时使用了 postgres”。查询显式指定 service_role。
- postgres/public 与 supabase_admin/public 当前 default table ACL 均包含这些 service-role grants；Main 表 ACL 与它们一致。0001–0003 等部分旧迁移只对 service_role 增加 DML grants，没有撤掉既有默认额外 grants。本地模拟这个 bootstrap 能复现 Main 与旧 0006 的行为。
- Catalog 能证明当前 direct/default grants 与缺失 REVOKE，**不能证明每个历史 GRANT 的执行时间/来源**；不能伪称已有审计历史。来源与平台默认授权一致，也不能成为安全 allowlist。
- `ita_preview_recoveries` 是第 13 个现存表，同样有三项权限；0005 明确 grant all，所以它符合旧 baseline。Worker 没有这些管理权限需求，但这不解释/豁免源码与 authority 表的旁路。
- `ita_changesets` 在 Main 尚不存在。旧 0006 对它 revoke all 后只 grant select，本地复现中其 TRUNCATE=false；已有 files/snapshots/projects 的剩余额外权限才是这次发现的关键缺口。

### Worker needs / safety

当前 Worker 的 DB 通道是 Supabase REST 的行级读取/metadata 或 message 写入，以及 task/workspace/memory/deletion/recovery/audit RPC。定向搜索 src 未发现 SQL TRUNCATE、CREATE TRIGGER、DDL 外键或直接 PostgreSQL 管理路径。数据库 FK 定义和 owner SECURITY DEFINER RPC 不要求调用方 service_role 拥有 REFERENCES/TRIGGER；撤掉这些权限不应移除正常 row DML/RPC 所需授权。

**TRUNCATE 是 protocol-bypassing / must-fix。**尤其 files/snapshots 无法靠现有 UPDATE/DELETE 行触发器防住 TRUNCATE；tasks/plans/projects 等 source/evidence/authority 关联也不应保留无用的整表管理能力。TRIGGER/REFERENCES 没有发现 Worker 需求；不要把它们描述成必然能直接改现有 owner trigger，但应和 TRUNCATE 在明确的 Forge 表范围内显式收紧。

本地 PGlite（复制 Supabase-style default table grants，加载旧 0001–0006）实测：

- 旧 0006 后 files/snapshots/projects 的 service-role TRUNCATE=true，changesets=false。
- Owner 对合成 checkpoint 的 row DELETE 被 CHECKPOINT_IMMUTABLE 拒绝；service-role direct source UPDATE 也被拒绝。
- service-role TRUNCATE files/snapshots 成功，两表数据被清空，row guard 未阻止它。
- **仅在本地诊断**撤回三项权限后 TRUNCATE 被拒绝，仍可正常更新允许的项目 metadata。此诊断不是修正版 migration 的 authority/concurrency rehearsal。

分类：expected/platform-equivalent = 当前 default ACL 形态及 0005 preview grant all 可解释；unexplained but harmless = 无可据此放行的权限；protocol-bypassing/must-fix = source/checkpoint/authority 的 TRUNCATE，另有未被 Worker 使用的 TRIGGER/REFERENCES 需显式收紧。

## Comparator false positives removed

- 34 raw function-definition hash 差异：仅 CRLF/LF。
- 13 policy role-array 表示：PG driver name[] 字符串 vs PGlite 数组；roles、cmd、qual、with_check canonical 后全匹配。
- 105 NOT NULL catalog rows：Main PostgreSQL **17.6**，PGlite **18.3**。按每列 attnotnull 校验，并独立保留 PK/FK/UNIQUE/CHECK 等实际 constraint 定义。没有忽略真实 nullable 变化或其他约束。
- **152 条 false positives 消除**。原剩余 165 ACL records 是 36 table 权限差异与 129 派生 column REFERENCES 记录，不是 165 个独立漏洞。

Comparator regression 覆盖 formatter/EOL、literal 内容保护、实际 body/attributes drift、owner/EXECUTE drift、RLS predicate drift 与真正的 NULL/CHECK 变化。`baseline-comparator.test.mjs` 是纯离线测试，不访问 Main。

## Artifact / next validation boundary

- **Does 0006 need modification: YES.**需在 scope 明确的 Forge 表上显式撤回不需要的 TRUNCATE/TRIGGER/REFERENCES，最终用 effective privilege 再验证；不能只检查 ACL 文本，也不能只测 RLS 或 row DELETE。
- **Does disposable rehearsal need rerun: YES.**修改后需 platform-default-grant bootstrap 的离线 regression、真实正式 migration、authority（含 TRUNCATE/extra grants）、双连接 concurrency 与新 hash。当前 disposable 被用户暂停，本轮不启动/重建它，也不挪用 restore-test。先前 PASS 只对应旧 artifact。
- **0006 本轮未修改。**旧 hash 仍为 `b4fd0818d33d7bcb2036ad3d1833d05c27583cbec301d27bdbea58e9020869e0`；hash 相同不代表已覆盖新发现的安全边界。此报告不给未来修正版附加旧 PASS。
- Main baseline status: **FAIL**（安全权限缺口未修及重新验证），其余 readiness 项保持原状态。没有建议重跑旧 migration、手改 Main ACL 或继续 cutover。

## Reproduce / evidence

从 repo root：

```bash
node --test app/backend/tests/baseline-comparator.test.mjs
node app/backend/tests/main-baseline-reconcile.mjs
```

第二条显式使用 .env.main-cutover；只能读 Main，functions/policies canonical PASS 仍会因 unsafe authority privileges 返回 FAIL / 非零退出码。原 main-cutover-preflight.sql 仍可用于 raw catalog capture，但 raw definition_hash 不能单独作 semantic drift 判据。

完整逐函数 actual/expected 属性、body、grantor、default ACL 和 role membership 存于 ignored `.cutover/main-baseline-reconciliation-2026-10-08/evidence.json`；local TRUNCATE 诊断为 `truncate-probe.json`。记录不含 connection string/password/证书内容，也不是数据库 backup。
