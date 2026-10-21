# Build Resume: retained runtime writer recovery

A failed preview runtime can leave a retained `preview` writer even when all prior source changesets are committed. The Build entry previously always called source reconciliation, which deliberately rejects runtime operations. Repeated Resume therefore could not progress.

Build entry dispatches source/materialize/install-drift to their existing source reconciler and plain runtime writers to `Workspace.reconcileRuntime`. The latter still requires terminal prior execution, no conflicting active task/preview, no old live lease, confirmed Stopped/Archived lifecycle, and an exact canonical managed-source manifest match before the existing RPC may release authority. Source drift remains blocking; no direct state reset or source rewrite is introduced.

Only the current DB-confirmed running successor with a matching execution ID and valid lease can exclude itself from the active-task set. The previous execution must have a different ID. An active preview job blocks this path even if its lease expired; expiry alone does not establish quiescence. Lease checks precede lifecycle actions and are repeated before final reconciliation.

Projects with neither a prior preview/checkpoint nor a successful build do not have a preview to recover. Their recovery requests fail clearly before starting another runtime writer; retained authority is preserved for normal task Resume. This prevents repeated first-Build preview startup attempts from churning the sandbox while generation is incomplete.

This recovery path does not require direct task-status overrides, retry-count resets or model-budget increases. Normal Resume may stop/restart the same sandbox to clear old process memory; stored application data and confirmed source remain subject to the existing preservation contract.

Offline coverage: runtime task/lease authority, active preview rejection, Stop confirmation, lifecycle transitions, source-vs-runtime routing, existing exact-manifest reconciliation and zero-side-effect rejection of unfinished first-Build previews.
