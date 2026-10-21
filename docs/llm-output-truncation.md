# Build output truncation

Build consumes the existing normalized response (`text`, `finishReason`) rather than discarding completion metadata. Provider `length`/`max_tokens` is not an executable action, even when the returned text parses. No partial file or guessed JSON repair is written.

The existing shared protocol repair allowance remains one additional logical call: on truncation it asks for smaller complete modules, not another copy of the same oversized response. No partial output enters history and no token limit is raised automatically. A second truncated response stops with `LLM_OUTPUT_TRUNCATED`; ordinary syntax/schema errors retain `LLM_FORMAT_STALLED`. Every physical request still passes the same execution-cost admission.

An operator can explicitly configure a larger cap, for example `LLM_MAX_OUTPUT_TOKENS_BUILD=8192`, for larger complete files. It increases each call's possible output exposure, not its guaranteed billed usage. Changing the output cap does not automatically change the execution cost ceiling. Plan/design/memory caps are unchanged. Restart the Worker after a setting change; failed tasks are not automatically resumed.

Confirmed no-op source writes warn immediately. Three consecutive successful no-op writes to the same file/change path set stop with `AGENT_STALLED`. Actual changes or intervening operations reset this streak. Missing change evidence is not interpreted as no-op. Repeated edits that do change content remain ordinary work under the existing step/cost budgets.
