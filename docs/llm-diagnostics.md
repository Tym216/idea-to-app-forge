# LLM 请求诊断与本地 capture

每个 physical request 在 fetch 前写 `model.request_started`，结束时写 `model.request`。通过 `request_id` 关联，重发共享 `logical_call_id` 和有效 payload hash，但拥有独立 request ID。现有逻辑/物理调用计数和共享 deadline 不变。

日志记录 provider/model/purpose、timeout、消息数、input chars/context breakdown、requested/effective temperature/JSON/reasoning 与安全的原生参数摘要。记录 headers/body 完成时间、HTTP status、供应商返回的 request ID、finish reason 与实际返回的 usage。没有首个 body chunk 的计时，也不能据此区分供应商内部的排队与 thinking。

- `request_phase=fetch` 且 `headers_received=false`：尚未拿到响应头。
- `request_phase=body`：拿到响应头，正文尚未读完。
- `request_phase=protocol`：正文读完，解析或响应协议校验失败。
- `request_phase=completed`：模型响应成功。

`LLM_TIMEOUT` / `LLM_NETWORK` 错误附带 request ID、phase 和 headers 标记；暂停/租约错误仍保持原分类。缺少的 timing/usage 保持 null。`LLM_TIMEOUT_MS=240000` 已在现有配置范围内，但仍受整个任务的 timeout 约束，重发不会重置模型 deadline。

## 本地 capture（可选）

在 Worker `.env` 显式设置：

```ini
LLM_DEBUG_CAPTURE_REQUEST=true
```

重启 Worker 后，保存到 `app/worker/.forge-debug/llm/`：

- `<request-id>.request.json`：adapter 后实际发送的 JSON body，保留原字节内容。
- `<request-id>.response.json`：读取到的原始响应文本；供应商返回错误或损坏 JSON 时，文件也可能不是合法 JSON。

不保存 Authorization/配置 API Key 等请求头；body 本身可能包含源码、用户需求以及用户写进内容的敏感数据。仅用于本地调试，默认关闭，不因开启 capture 而上传 Langfuse，也不改变独立的 `LANGFUSE_CAPTURE_CONTENT` 设置。路径仅写入本地日志；新诊断字段上传的只有安全 metadata。

每份文件最大 2 MiB，超过时跳过并记录 `size_limit`，不会生成伪装成完整内容的截断文件。保留最近 100 个 request ID 的 capture 对，只清理本工具的 UUID 文件；可手动删除该目录释放空间。新文件权限为 0600、目录为 0700（支持 POSIX 权限的系统），`.forge-debug` 已 gitignored。

正文 timeout 时通常只有 request 文件。目录不可写、文件超限或清理失败只记 warning，不改变模型返回结果。debug 模式增加本地文件 I/O，不增加模型调用。

离线测试使用 fake HTTP/隔离临时目录，覆盖 headers 前 timeout、正文 timeout、实际 payload capture、错误 JSON、重发关联、隐私边界与暂停。尚未通过真实供应商请求验证新的阶段诊断。
