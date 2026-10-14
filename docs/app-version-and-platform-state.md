# App Version identity and platform App state

## Restore semantics
0013 is additive; 0006 and prior immutable snapshots remain unchanged.
The current technical checkpoint remains ita_projects.checkpoint_id, binding the current revision/hash/build/verify evidence.
active_app_version_id is the user-facing numbered App. A restore creates an unnumbered technical checkpoint referencing the selected immutable App, only when its confirmed source hash exactly matches that historical source.
No-op selection requires current confirmed evidence; source drift cannot be mislabeled as the original App.
A subsequent real edit allocates the next unused App number under the project lock, with the selected App as parent.
Legacy checkpoints are not rewritten or renumbered. Completion-key repeats reuse the checkpoint.
Direct client/service-role writes to the new authority fields remain forbidden.

## Platform App data
The trusted Forge parent stores data by environment + Supabase project + account + Forge project, independently of App version, task, revision, sandbox, or proxy URL.
A controlled Vite runtime plugin hydrates a virtual localStorage before generated App modules execute. Old raw-localStorage apps and the existing Forge persistence helper use the same bridge without changing historical source.
A stable /preview/:projectId page hosts standalone previews. Direct signed previews redirect to that owned Forge page.
Only the bound iframe window/origin and current session channel can use its project store. No Auth token, service role key, or Daytona preview header token is passed to the generated App.
Web Locks and revision CAS prevent stale concurrent previews from overwriting confirmed state. Corrupt data or unavailable storage blocks boot instead of silently starting with empty replacement data.
Explicit Reset clears only the current account/project business data, preserving code, versions, editor drafts, and other projects.

This does NOT reconstruct arbitrary unsaved RAM, React useState, canvas state, sessionStorage or IndexedDB. Durable business state must be written to localStorage/the provided SDK. Games must persist their complete resumable snapshot and reopen paused.
The bridge acknowledges writes asynchronously; saved means the parent has committed browser storage. Abrupt closure before acknowledgment cannot be claimed lossless. This is same-browser storage, not cloud/cross-device sync or protection from deliberate browser-data clearing.
A schema migration/reset is separate from code restoration. Incompatible App-data schemas retain their original payload; they require an explicit supported migration or reset.

## Runtime activation
Generated managed source is untouched by the wrapper in excluded .forge-preview.
Only the supported Vite module recipe is adapted; executable classic scripts fail explicitly.
Local verifier execution is isolated from real user data. HTTP mode remains inconclusive for features; no stronger verification claim is added.
The runtime recipe is part of verification validity, with known old fixed acceptance bases accepted for an explicit revalidation. Existing same-source core blockers remain blockers.
A healthy current platform runtime is reused. A legacy runtime needs one explicit upgrade (or a normal Build/start): hold the workspace operation, stop the owned sandbox, confirm Stopped, start it, and launch the wrapper. No session deletion is treated as detached-process quiescence proof. Timeout/unknown lifecycle retains uncertainty.
React remount and healthy refresh do not request recovery or restart.

## Deployment boundary
Local tests cover SQL authority/completion, original App identity, next real edit numbering, exact-source drift rejection, cross-origin browser storage, ownership, runtime upgrade and UI controls.
This change is not yet active remotely. Demo activation requires additive 0013, matching Worker and frontend, followed by a bounded manual state/restore smoke. Main/restore are excluded.
Do not start the new Worker on an un-migrated target: schema preflight rejects missing active App fields before task claims.
