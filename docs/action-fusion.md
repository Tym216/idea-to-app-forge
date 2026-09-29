# Action Fusion v1：先测量，再减少模型往返

本轮只改 Worker，没有新增数据库迁移、依赖或前端功能。默认关闭 Fusion；请求指标在关闭时也会记录。没有接入小模型或完整的上下文压缩。

## 1. 本轮执行契约

模型可在一次调用中提交一组完整文件修改：

```json
{
  "tool": "apply_changes",
  "args": {
    "changes": [
      { "operation": "write", "path": "src/App.tsx", "content": "完整文件内容" },
      { "operation": "write", "path": "src/index.css", "content": "完整文件内容" }
    ],
    "after": "build"
  }
}
```

- 首版只支持 `write`，可创建或替换文件；不支持 patch、rename、delete 或 create 专用语义。默认最多 8 个文件、总内容 128 KiB。
- 全组输入、重复路径、大小和写入预算先校验，再按顺序执行。每个实际写入、构建、启动和验收分别消耗工具额度；暂停和租约检查在操作之间继续生效。
- `after` 只允许 `none` / `build`，是首版过渡字段。后续步骤来自 Worker 的 runtime policy，不继续扩展这个字段为任意工具序列。
- 当前 web policy 仅在 Fusion 开启且任务已绑定保存的 Plan/action 验收 steps 时自动推进：构建成功 → 启动 → 执行固定验收。手动 policy 不自动启动。今后增加任务类型时应由其 policy 决定验证步骤。
- 构建失败不启动；验收首次失败立即停止，不自动改代码重试。保留原来的手动恢复、两次验收上限和批准版本检查。验收定义有误需修订 Plan，Build 不能更改断言。
- 批量写入没有跨服务事务或整组回滚。结果区分 `succeeded / failed / uncertain / not_run`；已成功的文件保留，不能把部分完成报告为全部成功。

## 2. 不确定操作先核对，再恢复

单文件 `write_file` 与批量修改都使用同一套日志。每次写入前先把 operation ID、原沙箱 ID、目标内容及修改前/目标 SHA-256 保存到该项目现有任务的 `steps` JSON；成功后另追加确认事件，不覆盖意图记录。

如果写入超时、数据库同步失败或确认记录未保存，停止后续操作。在恢复或同项目新 Build 的任何模型调用、快照恢复之前，Worker 先核对该项目未确认的操作：

| 核对结果 | 处理 |
|---|---|
| 沙箱已是目标内容，数据库仍是原内容或目标内容 | 必要时只补数据库记录，然后确认；不重写沙箱 |
| 沙箱和数据库均保持操作前版本 | 标记未执行；本次核对不自动写文件 |
| 出现其他版本，或原沙箱不可访问 | 保持 `CHANGE_UNCERTAIN` 并停止，要求核对；不创建替代沙箱来掩盖问题 |

这解决的是文件写入的确认与恢复，不保证任意 shell 命令、外部 API 或整个任务恰好执行一次。路径校验是词法校验，不是新增的操作系统权限边界。原沙箱被删除或无法读取时，自动恢复仍可能被阻塞。

## 3. 指标与隐私边界

每次真实发送的模型请求记录 `model.request`，包含 request/task/execution ID、供应商、模型、purpose、耗时、结果、供应商返回的输入/输出 tokens，以及实际发送内容的字符构成：instructions、plan_and_acceptance、memory、initial_code、history、other。字符分类用于定位重复内容，不能当作各部分的精确 token 数。

每次领取的执行记录 `task.metrics`：

- logical model turn 数、model request 数（含失败和重发）、真实 token 部分合计、模型耗时、执行耗时；
- 首次可用预览与首次验收通过的时间、build/verify 次数和通过数；
- task/execution/project、模式、恢复信息、Fusion 开关、代码标识、结果和失败原因；
- tool call / operation 数作为解释指标，不作为主要优化目标。

执行耗时从 Worker 领取开始，不包含队列等待。恢复是一次新的 execution，失败和恢复都计入；这是执行成功率，不是按项目计算的最终成功率。首预览时间表示开发服务已启动并写回 URL，不等于页面功能通过验收。预览耗时只对产生过预览的执行报告，并同时给出样本数，不能忽略失败率只比较速度。

本地 `task.metrics` 在终态写回后记录：写回无法确认记为 `unconfirmed`，不会计为成功。Langfuse 根 observation 的 `outcome_scope=executor` 表示执行代码结果，终态数据库写回结果以本地 `outcome_scope=terminal_write` 记录为准。

供应商没返回的用量为 null；只合计已返回的部分并标记 `usage_incomplete`，失败请求也可能产生未能确认的费用。没有维护价格表，本轮不估算费用或把未知费用记为 0。新增指标不记录 prompt、代码或原始错误内容。原有 `LANGFUSE_CAPTURE_CONTENT` 调试开关保持原行为；完整写入意图只保存在用户项目数据中，项目删除时随之清理。

写入日志复用现有 steps JSON，会增加任务记录大小和数据库传输量；它是首版的可靠性成本，并非免费的压缩方案。长期记录规模增大时需再评估存储方式，本轮不迁移数据结构。

## 4. 收集 baseline 与对比

先停止旧 Worker（Ctrl+C），保持单执行器，保留已有 `.env`。在 `app/worker/.env` 手动配置：

```ini
ACTION_FUSION_ENABLED=false
FUSION_MAX_FILES=8
FUSION_MAX_BYTES=131072
METRICS_CODE_VERSION=retry-v1
```

第一轮使用关闭 Fusion 的同一版本，收集 baseline：

```bash
cd /home/brilliant-tai/idea-to-app_v0.75/app/worker
npm start 2>&1 | tee /tmp/forge-baseline.log
```

用少量固定任务，例如待办、计数器、游戏和已有应用的局部修复。固定供应商、模型、配置与需求；尽量使用独立项目、相同初始状态。Plan 与 Build 分开比较，保留失败与恢复记录。真实运行仍会调用你的模型和沙箱，本轮开发没有替你执行这些实验。

停止 Worker，改为 `ACTION_FUSION_ENABLED=true`，用同样任务收集另一组日志：

```bash
npm start 2>&1 | tee /tmp/forge-fusion.log
```

离线对比，不读取 `.env` 或访问外部服务：

```bash
npm run metrics:compare -- /tmp/forge-baseline.log /tmp/forge-fusion.log
```

输出按供应商、模型、Plan/Build、开关和代码标识分组，列出请求总数、已报告 tokens、执行成功率、全部执行的耗时中位数、预览耗时及有效样本数、构建/验收次数、失败原因。日志里可能包含原有调试内容，应作为内部材料保管。默认关闭组也已采用本轮的安全写入日志，是同版本对照，不是此前旧版的性能数据。

先看成功率、失败原因和总耗时，再看 model turns 与 tokens。两组结果不够时继续收集，不能从一条任务或离线测试推断生产收益。

## 5. 验证与下一阶段

本轮回归用可控工具与模型响应验证：同样两份文件修改的 Build 流程，模型调用从 6 次变为 2 次；实际操作数、工具预算和固定验收一致。它证明减少了指定路径的往返，不代表真实模型生成质量、延迟、成本或成功率。

Worker 测试覆盖输入预检、部分写入、写入已发生后的超时、租约丢失、暂停、核对冲突、原沙箱不可访问、预算、固定验收、修改后的失效和指标缺失。没有执行真实模型、Daytona、Langfuse 上报或生产端到端对比。

最终 `npm test`：120/120 通过；`npm run check`：exit 0。前端及迁移没有修改，未重复运行它们的检查。

ObservationPack 本轮只定边界：未来压缩仅影响发给模型的视图；保留原始 observation 的可恢复引用、来源 operation/request ID 和截断标记。在既定保留期内不能用压缩结果覆盖原始记录，项目删除和保留期规则仍有效。完整压缩及小模型替换实验尚未实现。
