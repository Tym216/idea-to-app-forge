# Generation reliability and runtime latency

## Bounded action-planning context

Only new lightweight action briefs use a deterministic source index: file paths, lengths, exported symbol names and literal data-testid values, up to 6000 characters with explicit omission notices. User intent, project description, memory and generic instructions remain present. This is a model view, not a canonical manifest or a stored code replacement. Normal Build still gets the existing code context and can read complete files. Initial Plan and already-approved Plan execution are unchanged. No summarization model call or automatic timeout/budget increase is added.

This reduces a known avoidable input cost; it does not prove that an earlier no-headers timeout was caused by prompt size rather than networking or provider latency.

## Runtime work remains revision fenced

Workspace dependency checks use the already-confirmed complete manifest rather than reading every source file through Daytona again. Runtime preflight still compares actual sandbox source against that manifest.

`activate_scan` combines fence activation and the complete initial source scan under the existing flock. It removes one spec upload and one command round trip per runtime operation. The monotonic writer fence, base-hash comparison, symlink/type/source limits, post-operation complete scan, drift handling and DB confirmation all remain. No truncated file inventory can establish a checkpoint.

Independent Node/environment and npm-version reads run concurrently; the resulting build fingerprint fields are unchanged. A failed probe still fails the basis check. No sandbox mutation is parallelized with these probes.

`workspace.runtime_timing` logs preflight, command, confirmation and total milliseconds using a monotonic clock. These measurements can separate actual Vite compilation from remote orchestration. No new production latency claim is made before another real task supplies measurements.

## Optional fast pure-logic tests

New applications with business rules are guided to separate pure `.mjs` logic and add `src/**/*.test.mjs` using `node:test` and `node:assert/strict`. A managed root `forge.checks.json` explicitly opts in: `{"version":1,"tests":["src/rules.test.mjs"]}`. No test is discovered/executed merely because it exists in an older project. Invalid opt-in declarations are reported as tool faults before any test command. The runner executes explicitly listed managed files, without package scripts or new dependencies. Its child has an 8-second limit and bounded output. Tests must use memory-only pure functions, without file/network/process/background side effects. This is not a general shell command facility or a security sandbox inside Daytona.

Applications without the opt-in declaration have zero additional test commands and keep their previous validation flow. Existing generated apps are not rewritten and no checks are silently backfilled.

For apps that opt in, pure tests run inside the existing revision-fenced `verify` operation. Actual source drift after tests still blocks confirmation; timeout remains uncertain until reconcile, even if the immediate test runner returned. An assertion failure is a blocker. A test syntax/import/runtime fault is a tool error. Missing/skipped tests remain inconclusive. Passing tests never upgrade HTTP-only or missing browser evidence to fully verified.

Supplemental results record their own recipe + canonical source fingerprint in verification evidence. Cached results are reused only when this identity remains applicable. Fixed approved browser acceptance is retained; source tests cannot replace it. These are supplemental tests authored with the app, not an independent proof that the model understood every rule correctly. More reliable domain fixtures and test coverage can be expanded later.

For classic Sokoban, guidance calls for equal box/goal counts, one player, a known solvable move sequence and no premature victory. It does not claim exhaustive deadlock solving.

No schema migration, App Version update, storage reset, additional LLM call, automatic task Resume, or frontend deployment is required by these local Worker changes. The existing checkpoint transaction and version-completion semantics are unchanged.


## Bootstrap and mutation preflight consolidation

`build-bootstrap.js` computes one logical bootstrap target: missing scaffold files, missing persistence helpers, and intentional design-token changes. It preserves existing application/package/helper content and the existing iteration-design rules. An empty project now needs one recorded bootstrap ChangeSet instead of four. This is not a claim of cross-system or multi-file atomic rollback: normal partial/uncertain/reconcile rules still apply. Repeating an identical bootstrap is a no-op.

After that ChangeSet commits, the Agent rebuilds its normal bounded Build context and character attribution from the latest confirmed manifest. It does not change the approved Plan/acceptance, add a model call, or remove the model's ability to read full relevant files. The earlier context remains used for planning before bootstrap; ReAct no longer receives the pre-bootstrap empty-project description.

Materialization, Agent mutation, and User Apply now use the already-tested `activate_scan` operation for their preflight, removing one private spec upload + gateway command round trip each. Existing source-drift comparisons, fenced promotion, full post-write target verification, DB commit and error retention remain. Reconciliation was not rewritten.


Offline regressions cover fenced drift detection, no-op mutation, partial recovery, bootstrap context, evidence reuse and blocker/tool-error checkpoint prevention. Reductions in operation count are testable; production latency, generation success and provider cost still require comparable real-task measurements.
