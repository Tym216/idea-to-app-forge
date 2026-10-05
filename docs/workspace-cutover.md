# Phase 2 切换与验证

这是源码状态协议的切换，需要 0006 与新版 Worker 一起更新。前端本轮没有改动。真实 .env 不需修改，没有增加 npm 依赖。

## 切换顺序

1. 备份现有数据库 files/snapshots，以及需要保留的旧沙箱文件。停止全部旧 Worker；确认正在进行的上传、命令和后台写入已经收尾。只让租约过期不能证明远程操作已停止。
2. 在 Supabase SQL Editor 执行 `app/backend/migrations/0006_workspace_contract.sql`，前提是 0001–0005 已执行。不要重跑旧迁移。0006 在单个事务里建立协议、导入未确认旧 journal，并禁止 service_role 的旧直接 files/snapshot 写入。
3. 更新整个 `app/worker`。运行 `npm install`、`npm test`、`npm run check`。旧 Worker 与新 schema 不兼容，不可同时运行。
4. 运行 `npm run doctor`。Workspace 检查只读字段，并用不可能存在的 ID 验证 RPC 拒绝结果，不领取任务。原 doctor 的模型检查仍会发送一次真实最小请求。启动 Worker 前也会只读检查 0006。
5. `npm start`。先新建小型测试项目，Plan → Approve → Build。核对 changesets、project revision/hash、checkpoint；源码变更应增加 revision，no-op/恢复不应增加。

## 旧项目与不确定状态

旧 files 是 revision 0 的候选基线，不能仅凭数据库记录宣称沙箱已确认。原沙箱完整 manifest 相同后，才能 confirmed；确认不存在且无 pending 的沙箱可以重新创建并 materialize，不增加 revision。

若旧沙箱多出未持久化的 package-lock.json、shell 改动或其他文件，首版保留原内容并报 conflict。不要用新空沙箱、改 workspace_state/token 或删除 journal 绕过。先保留差异、确认旧操作已停止，再明确处理基线与变更；没有强制解锁/自动采纳未知 drift 的 CLI。旧 pending journal 有显式管理员核对出口，不能确认原操作停止或不能扫描原沙箱时继续 blocked。

新 gateway 的 partial 写入可以在任务恢复时核对原基线/既定目标，已到目标的文件不重写，第三种内容停止。运行命令 timeout/断连不能自动证明进程已停止，因此 runtime writer 保持 uncertain，需人工核对。

## 验证与实际边界

```bash
cd /home/brilliant-tai/idea-to-app_v0.75/app/worker
npm test
npm run check
cd ../backend/tests
node workspace.test.mjs
```

Worker 单测含真实 Linux flock/文件 rename、部分写入、迟到 token、UTF-8/BOM、完整 manifest 与 runtime policy 检查。Windows 环境需通过 WSL 执行这些测试。

workspace.test.mjs 依序执行 0001–0006，使用 PGlite 验证授权、no-op、partial、证据、不可变快照、完成幂等、级联和 legacy fence；service bridge 使用真实 SQL 与 Linux gateway，模型/构建/预览/浏览器端点使用明确替身。它不证明真实模型生成效果或 PostgreSQL 多连接并发安全。

尚未验证：真实 Supabase 迁移/权限/cache、真实 PostgreSQL 锁竞争/死锁、Daytona 的 flock/SDK stdout 完整性和网络中断联调、新协议下完整真实模型→浏览器→checkpoint 流程。部署前需复验；没有在开发过程中消费你的模型额度或删除真实沙箱。

App Version UI、用户 Apply、中途意图吸收与历史预览仍属于后续阶段。本轮创建的是 immutable 技术 checkpoint，不宣称已经实现这些产品功能。

删除测试 harness 已修正 p_attempts，并实际加载 0001–0006：PGlite 51/51 通过，覆盖旧 files/snapshot，以及新 changeset/checkpoint、retained writer 和跨项目隔离的删除级联。该结果不是 Supabase service-role 权限或真实 PostgreSQL 并发证明；真实 cutover validation 尚未执行。删除业务逻辑及 0003 均未修改。


## Imported legacy pending 的实际出口

1. 先备份并停止全部旧 Worker，人工确认每条原沙箱操作及其后台写入已结束。租约过期、Ctrl+C 或新 gateway 的 flock 本身都不构成旧远程上传已停止的证明。
2. 在 Worker 目录执行 `npm run admin:workspace-legacy -- --project <project-id> --sandbox <原-sandbox-id> --confirm-quiesced`。只使用 service-role/Daytona 配置，不调用模型，也不上传/覆盖 managed source。CLI 扫描完整原沙箱 manifest 后提交 service-only legacy reconcile RPC。
3. 核对输出 outcomes：committed / not_applied；项目在所有 unresolved legacy intents 同事务解决后才 confirmed。多个不同文件的 intent 可一起处理；第三值、无法证明的重叠记录、不同沙箱或不完整历史记录会拒绝，保持原数据和 writer。不要改 authority 或删除 journal 来绕过。
4. 再恢复任务或 materialize；没有 build/verify 证据的 confirmed source 仍不能直接创建 checkpoint。

常规 install 的 prepare/crash 恢复与 legacy 不同：已持久化 returned-command proof 的 install_drift changeset 能自动核对并 commit；未知/超时命令仍需人工确认，不能用 retry 代替核对。

## Disposable 真实验证必测项

按正式 0001–0006 建 schema。通过真实 service_role PostgREST 直接 INSERT/UPDATE/DELETE files、直接 UPDATE projects 的八个 workspace authority 列、直接 UPDATE/DELETE checkpoint 应被拒绝；authenticated 源码 mutation 亦拒绝，正常 deletion RPC 的 cascade 允许。重复 completion key 的相同稳定 identity 只能生成一份快照/消息，不同 build/verify basis、basis_id、summary 必须冲突。随后验证真实 PostgreSQL 双连接 writer/CAS/completion 并发与锁超时，再跑 fresh Daytona 的依赖 Vite install/build/start/verify/checkpoint。

本地 PGlite 与 Linux gateway 回归已覆盖上述协议反例及 install prepare 成功、commit 前 crash、新 execution reconcile 的路径；不替代真实 Supabase privilege、PostgreSQL 多连接或 Daytona 验证。主要环境 0006 尚未执行。
