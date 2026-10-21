# Demo 快速验证与状态连续性

## 临时跳过浏览器验收

`BROWSER_VERIFICATION_ENABLED=false` 只在当前 Demo Worker 的显式 env 中启用。默认 true，恢复 true 后使用现有浏览器流程。快速模式继续构建、启动/复用服务和 HTTP/入口脚本检查，不安装 Chromium、不执行 A1…交互检查。

HTTP evidence 使用独立 fingerprint，绑定源码 revision/hash、build basis 和原计划 checks；不会冒充旧浏览器通过证据。通过快速检查只得到 inconclusive / 带标记 App Version，功能、真实渲染与浏览器 runtime 未验收。编译失败、HTTP 不可用/入口错误、工具无可靠结果仍阻止发布。已对相同源码/完整 basis 证明的 blocker 不因切换快速模式而消失，需实际修复；原计划 acceptance 不被删除或降低；User Apply 仍零 LLM，旧完整或 health basis 与新 HTTP basis 可识别，但不混用结果。没有修改 0006 或现有 schema。

## 默认保留业务状态

生成指导在 Initial Plan、action 和 Build 上下文中统一要求持久化完整业务状态，而非仅保存最高分。新任务提供：

- `src/forge-persistence.ts`：稳定 environment/project/collection namespace、schema-aware read/write 和显式 reset。
- `src/forge-use-app-state.ts`：React useAppState，同步保存后才更新界面；支持函数式 setter、异常状态提示和显式 reset。

生成应用需提供「重置业务数据」入口，确认后只重置自己的集合，不使用 localStorage.clear。游戏恢复完整局面并先暂停计时，继续操作后再推进。真正的临时 UI 状态不强制保存；兼容代码版本沿用同一 namespace。坏 JSON/未知 schema/存储失败不能在 mount 时覆盖原数据。

这是生成机制与契约，不是已经改写所有历史应用。历史应用若只使用 useState，无法从 iframe 外部自动恢复未保存的内部状态，需正常迭代接入。已有 helper 无 reset 时，新 hook 可显式 write 初始值；坏数据仍不得绕过旧保护自动清除。

当前 Vite 预览已接入可信 Forge 父页面的 localStorage 桥接，按 environment / Supabase / account / project 保存，兼容代码版本和 Daytona 代理域名变化不切换业务数据空间。换浏览器、清除站点数据及未保存的内存状态仍无法恢复；未引入云同步或业务数据库。完整边界见[版本与平台数据](app-version-and-platform-state.md)。

## Preview

Preview 使用独立的只读项目读取结果，先加载保存 URL，编辑器仍等待 revision-bracketed files 数据；不会把旧文件配给新 revision。正常重进不启动 sandbox、不签新 URL；CORS/短暂不可观察结果保留旧 URL。

顶部刷新只重载 iframe，明确 healthy 时不 enqueue；用户主动检查时遇到 HTTP 失败或无法观察，可走现有受控恢复。自动恢复只由明确失败触发，pending 去重；恢复后即便 URL 未变也会重新检查，避免复用缓存的 false。

右侧切换页签不销毁 iframe。后台 recovery/status 读取不能遮住已经可用的 URL；健康的 retained preview writer 不在 mount 时自动 reconcile。未确认源码 mutation 仍受 fencing 阻止，不自动解锁。

Demo 现有 DAYTONA_AUTO_STOP_MINUTES=120 保留。休眠后的冷启动仍需要平台恢复；不承诺无限在线，不使用 busy-loop。

## 本地验证

Worker unit/regression、真实 HTTP recipe 的离线 fetch fixture、generated helper TypeScript consumer、本地 Chromium 的 persistence/Preview/actual Workspace 组件测试、frontend lint/build。UI fixture 的所有外部请求被拦截。

没有为验证新增真实 LLM 生成、运行生成 App 的 A1-A4 浏览器验收、修改任何业务数据、迁移 Main/restore-test，或强行释放 uncertain writer。公开环境的模型实际生成质量与持久化接线仍由正常任务测试。
