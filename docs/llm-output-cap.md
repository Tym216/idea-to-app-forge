# 可信模型输出上限

输出上限由 Worker 的可信配置确定，在 provider adapter 和原生 options 处理后最终应用。用户消息、工具参数或 native options 不能提高、移除或重复覆盖它。它限制单次回复，不代表整个任务的费用封顶。

## 配置和用途

| 配置 | 对应 purpose |
| --- | --- |
| `LLM_MAX_OUTPUT_TOKENS` | 未单独配置用途时的默认值 |
| `LLM_MAX_OUTPUT_TOKENS_PLAN` | `plan` |
| `LLM_MAX_OUTPUT_TOKENS_MEMORY` | `memory_extraction` |
| `LLM_MAX_OUTPUT_TOKENS_BUILD` | `build_decision` |
| `LLM_MAX_OUTPUT_TOKENS_DESIGN` | `design` |
| `LLM_MAX_OUTPUT_TOKENS_ACTION_PLAN` | `action_plan` |
| `LLM_REQUIRE_OUTPUT_CAP` | true 时，每次生成必须找到有效上限 |

上限必须是 1–131072 的整数；这是配置合法范围，不是模型能力声明。用途专用值优先于默认值。空值且非 required 时保留原行为；required 下缺值在 HTTP 前报错。所有已填字段都校验，包括本次没有使用的字段。

`doctor_probe` 不继承 Plan/Build 专用值；只读 GET `/models` 不是生成请求，不需要输出额度。格式修正和代码修复仍使用原 purpose，没有另一条可绕过上限的通道。

## 当前已实现的映射

- OpenRouter：最终发送 `max_tokens`，移除 `max_completion_tokens`，并要求路由支持参数。
- 阿里云 capability 表内的已确认模型：发送 `max_completion_tokens`，移除 `max_tokens`。支持列表见 `app/worker/src/aliyun-capabilities.js`，不自动套用到其他模型。
- 其他 adapter：显式设置可信上限但没有确认映射时，报 `LLM_OUTPUT_CAP_UNSUPPORTED`，不静默丢弃保护。没有设置该功能时不改变其旧行为。

Provider retry 复用同一序列化请求与共享 deadline，最多两个物理请求。协议修正会增加逻辑调用，因此“每次最多两个物理请求”不是整个任务的调用次数上限。

回复达到输出上限时，Build 不执行残缺动作；详见[截断处理](llm-output-truncation.md)。输出/推理 token 的供应商计费语义需要逐模型确认；本地映射测试不能独立证明上游实际强制执行。完整费用保护见[费用准入](llm-build-cost-admission.md)。
