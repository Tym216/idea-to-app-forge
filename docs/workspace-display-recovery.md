# Workspace display recovery hotfix

Observed: the reported Demo project retained a valid completed initial Plan. Reopening it under the same account rendered normally with no captured browser error. A localhost replay using its saved response, real CSS and Home → Workspace navigation also rendered normally. The original exception has not been captured; its root cause is not claimed fixed.

The existing workspace started a refresh on entry, on submission, and every four seconds without in-flight deduplication. These reads could overlap under slow metadata responses. A single in-flight refresh now serves concurrent callers.

A project-scoped React error boundary now contains render failures and performs one automatic re-read/remount. Recovery removes the initial prompt query parameter before remount, so it does not submit another generation task. A persistent failure stops automatic retries and retains explicit reload/back controls rather than emptying the root.

Local diagnostic records contain error identity/component stack and project ID, without collecting request payloads or credentials, and are capped at five entries. They are visible under the existing developer diagnostics after recovery and are not uploaded.

Regression exercises actual Home creation and queued → running → Plan updates, slow metadata deduplication, an injected recoverable rendering error, and a persistent rendering error. It verifies one task submission, bounded recovery, usable navigation, local diagnostic visibility, and no remote requests. Existing preview/persistence/version/editor tests, lint, app typecheck and build also pass.

This is a frontend resilience hotfix, not proof that the original intermittent exception is eliminated. Next occurrence should leave the component error in local recovery records for a targeted root-cause fix. No DB migration, Worker restart, LLM call, new remote project, or browser acceptance run is needed for rollout.
