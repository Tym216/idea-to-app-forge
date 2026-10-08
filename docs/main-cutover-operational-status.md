# Main cutover operational status — NO-GO

> **2026-10-08 artifact update：NO-GO。**当前 0006 已收紧 Forge table-management privileges；新版 hash 为 `5bea628f986f6953f7aac77d05911a5a3a6cfac735c39c169a15ba84b501a782`。旧 `b4fd…` rehearsal PASS 仅作历史记录，不验证新版。Fresh migration/authority/concurrency/Daytona rehearsal 尚未执行，见 [新版验证记录](workspace-privilege-hardening-validation.md)。


核对日期：2026-10-06。主项目 `vfzyimhapttcdxeabvur`；disposable 为 `forge-cutover-test / dfixexlufeyrdublqcxu`。本记录区分已执行验证和待执行步骤。**未执行主环境 0006、冻结、部署、push 或 Phase 3。**

## 已完成的本地 checkpoint 与 artifact

- Phase 1：`533f9086d7e588910d39482eeb5e4d7960613c57`。
- Phase 2：`9e99e4c434c8077fd5a3c82eede88ec4267aed57`。
- Real rehearsal、validation scripts、runbook、只读 preflight：`08ac0807e73c134b1c33f13586b1d78c1d09cb59`。Gate scripts 与本记录另作本地 operational checkpoint；最终 HEAD 用 `git rev-parse HEAD` 确认。
- 无本地 GitHub workflows 不代表没有托管平台自动部署；实时远端状态及 Render/App/hooks 尚未确认，按可能自动部署处理，禁止 push。
- 独立 Worker artifact：`.cutover/artifacts/08ac0807e73c134b1c33f13586b1d78c1d09cb59/worker-source.tar`（相对 `app/worker`）。仅来自 tracked `app/worker`，不含运行密钥。
- Archive SHA256：`cf61b1716b6008e93cb62e24ab39f2198a779ada9ce6e1fefca13f9603b86a14`；lockfile SHA256：`d653669961927aae1e1c5fdd2dd4362f5fd7571e305c25959a3227c689c92c34`。
- 独立展开后的 `npm ci --ignore-scripts`、192/192 离线测试、`npm run check` 均通过；`artifact.json` 和完整离线输出保存在 ignored artifact 目录。**只证明本地 artifact 可安装/测试，不证明主环境配置或启动已通过。**后续 operational commit 不改变这些 Worker 字节。
- 0006 SHA256 与 disposable 通过版本一致：`b4fd0818d33d7bcb2036ad3d1833d05c27583cbec301d27bdbea58e9020869e0`。

## Paused task：保留，禁止自动恢复

Task `e0d9c783-7de6-4a02-a219-50a24b7e55c5`；project `93a2f63a-9ec6-4194-b962-4e68dbeea80d`；sandbox `9394813e-2d8d-4ccf-8642-5c9e95e0f570`（archived）。Task execution/worker/lease/heartbeat 均为空。DB 源码 10 文件，无 lockfile，候选 manifest hash `2596fb9972332c1fc0db96b6b211e58bbec51541b160950657b19d1c9be49b8a`。DB unresolved legacy journal 为 0。

已批准计划 v1 的 4 条验收有 steps，但没有 severity；新版默认值不能被当成旧验收语义已确认兼容。Task 记录 tool_steps=31、fix_rounds=5，末期为 verify 失败及读取代码后暂停。不能默认新的 execution 可以继续复用其预算/验收结论。

不 resume、不取消、不重写旧计划或 task 状态。正常 claim 不领取 paused task，但**主环境 resume/retry 尚未冻结**，因此“持续禁止恢复”的 operational closure 仍未完成。维护窗口先关闭这些入口；解除冻结前，要么保留对应权限关闭，要么先完成另外批准的兼容审查与任务处置。不能仅靠 UI 不点击。

实际 sandbox managed-source 尚未扫描；archived/stopped 和 lease 空值都不证明历史上传/命令已确认收尾。保留该沙箱及 DB 源码/快照/计划/steps；待全部旧实例停止后受控导出实际源码并核对。其他 8 个 sandbox 引用也需同样判断是否存在 DB 之外的不可重建源码/资源，不仅保存这个 paused 项目。

## Ingress gate：已在 disposable 实际验证，主环境未执行

Temporary ACL gate 对所有 `public.ita_*` 表/列客户端 INSERT/UPDATE/DELETE 和函数客户端 EXECUTE 捕获精确 ACL、事务性撤回，并验证 anon/authenticated 的有效写权限为 0。SELECT 和 service-role 权限不变；因此所有持有 service-role 或 DB 管理权限的 Worker/后台 job 仍必须独立停止。Supabase Auth 注册不是此 gate 的范围；若需冻结账号注册，另核对 Auth 设置，不能声称 ACL gate 冻结了整个 Supabase。

`ops-ingress-gate-test.mjs` 在真实 disposable 上通过：

- 普通 authenticated 新建 task、resume/retry、approve、preview recovery 和 deletion RPC 均收到 403 / 42501 privilege 拒绝；只读 project GET 仍成功。
- 实际调用 `ops-canary-enqueue.mjs` 创建 Plan task；Worker 合法领取/保存计划；管理员 approve 入队 Build；普通客户端权限全程仍关闭。未调用 LLM、未运行实际 Build。
- 精确解除冻结后 ACL 与 capture 相同；普通 authenticated task INSERT 恢复为 201；fixture 用户/项目/任务均清理。Disposable 已恢复原 ACL。
- Gate 不操作 workspace authority、revision、execution/lease，也不重新赋予 source direct DML。Grant drift 或 unfreeze mismatch 会 rollback 并停止。

下面命令从 repo 根目录执行。**仅为待执行 runbook；没有运行在 main。**先在 ignored `app/worker/.env.main-cutover` 配置 `MAIN_DATABASE_URL` 和 `MAIN_CA_FILE`。脚本限定主 ref，严格 TLS 校验证书，不接受 disposable DB 替代主 DB；CA 路径可绝对或相对 repo root。

```bash
# 1. 只读捕获精确 ACL；输出 ignored JSON 与可审阅的 freeze/unfreeze SQL
node app/backend/tests/ops-ingress-gate.mjs --target main --mode capture --snapshot app/worker/.cutover/main-ingress.json --ack-main-maintenance

# 2. 按已批准窗口冻结；随后再次独立核对
node app/backend/tests/ops-ingress-gate.mjs --target main --mode freeze --snapshot app/worker/.cutover/main-ingress.json --ack-main-maintenance
node app/backend/tests/ops-ingress-gate.mjs --target main --mode verify --snapshot app/worker/.cutover/main-ingress.json --ack-main-maintenance

# 3. Canary-only 仍保持全部普通客户端入口关闭
node app/backend/tests/ops-ingress-gate.mjs --target main --mode canary-only --snapshot app/worker/.cutover/main-ingress.json --ack-main-maintenance
node app/backend/tests/ops-canary-enqueue.mjs --target main --mode plan --user <CANARY_USER_UUID> --project <NEW_PROJECT_UUID> --prompt-file app/worker/.cutover/canary-prompt.txt --ack-main-maintenance
node app/backend/tests/ops-canary-enqueue.mjs --target main --mode approve --user <CANARY_USER_UUID> --project <PROJECT_UUID> --plan <PLAN_UUID> --version <PLAN_VERSION> --ack-main-maintenance

# 4. 最终稳定及 paused task 隔离处置已确认后，才允许精确解冻
node app/backend/tests/ops-ingress-gate.mjs --target main --mode unfreeze --snapshot app/worker/.cutover/main-ingress.json --ack-main-maintenance
```

Canary 只允许可信 DB 管理员执行；现有 Auth canary 用户必须存在。它用数据库事务中的业务用户上下文调用现有批准逻辑，不向普通用户恢复 EXECUTE；不是普通 UI/session JWT 身份链验证。实际主环境 canary 账号和管理连接尚待确认。Capture 文件禁止覆盖；秘密/完整连接串不进入输出。

## Quiescence、catalog、backup：仍阻塞

- 只读 API 快照：queued/running task=0/0；paused=1；preview recovery queued/running=0/0；deletion pending/running/failed=0/0；未确认 legacy journal=0。9 个引用 sandbox 中 6 stopped、3 archived、0 started；当前 WSL 未发现旧 `node src/index.js`。这不是其他 WSL/Windows/Render/container/其他主机的停机证明，也不是远程副作用停止证明。
- 尚未取得所有 Worker 实际位置、自动重启/定时启动来源、托管平台 push/merge 部署行为及停机证据。未知 command/upload 必须保留 NO-GO；不能靠租约过期或删 journal 解锁。
- `app/worker/.env.main-cutover` 未提供。未建立主库管理连接，未运行 `main-cutover-preflight.sql`；API 能看到 0001–0005 surface 不能代替 catalog/signature/trigger/ACL/RLS 检查。若 catalog drift，STOP 列差异，不改状态强行迁移。
- 主库 backup/dump/restore point **未创建、未验证**。凭据、严格 TLS CA、备份工具及另一个隔离恢复目标尚待准备。不能用 API JSON 或本地 Worker artifact 冒充数据库备份，也不能覆盖保留的 disposable 验证项目。
- 恢复点应在入口冻结、全部远程副作用静止后的 T0 创建：roles/schema/data/Auth 依赖，hash/关键表数据核对，并在额外隔离目标验证可恢复；Storage 对象和实际 workspace 未入 DB 内容另保存。备份密封保存且 ignored。

若 0006 后 Worker 不能启动：保持冻结、停止失败新实例，优先 forward-fix artifact/config/依赖/网络或已 review 的窄迁移；不启动旧 Worker、不恢复旧 source/authority grants。最终 rollback 必须同时恢复 T0 数据库及匹配源码/runtime，并明确迁移后写入的保存/回放/损失处理；没有已验证 down migration，git revert 不是数据库恢复。

## 最终 GO checklist

| Gate | 当前结论 | 证据或未满足条件 |
|---|---|---|
| code clean | PASS（本地 checkpoint 后核对） | 正式 tracked 内容提交；review/secret/debug 排除；不 push |
| ingress frozen and verified | UNKNOWN / NO-GO | disposable PASS；main 未执行 freeze，也未核对主 ACL |
| paused task disposition resolved | UNKNOWN / NO-GO | 决定保留不自动恢复；入口隔离与实际源码保存尚未落实 |
| all old workers stopped | UNKNOWN / NO-GO | 当前 WSL 未见进程；其他实例/重启源未知 |
| remote side effects quiesced | UNKNOWN / NO-GO | 沙箱状态与 lease 不代替 command/upload 收尾证据 |
| main 0001–0005 catalog preflight passed | UNKNOWN / NO-GO | 未取得主库连接，SQL 未运行 |
| backup created and restore point verified | FAIL / NO-GO | 实际主库备份及隔离恢复检查未执行 |
| 0006 artifact matches tested disposable version | PASS | SHA256 与已通过 rehearsal 一致 |
| new Worker artifact ready | PASS（本地） | 独立安装、192 tests/check；主环境 config/启动仍未验证 |
| controlled canary path ready | UNKNOWN / NO-GO | scripts 在 disposable PASS；main canary 用户/权限未确认 |
| push/deploy behavior confirmed | UNKNOWN / NO-GO | 按可能自动部署处理，保持不 push/deploy |

**结论：NO-GO。任何 UNKNOWN 同样禁止 cutover。**需用户提供 ignored 主库连接/CA 配置、所有 Worker 与自动部署/重启信息，以及可用的独立备份恢复验证目标。补齐后从主库连接 preflight、catalog/gate 与停机收尾证据继续；0006 仍等最终清单全部 PASS 和用户确认，Phase 3 不开始。
