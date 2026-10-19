# Demo preview lifecycle

The Render service hosts Forge's frontend. It does not start the local Worker. The current Demo Worker runs manually in WSL Ubuntu-24.04, using an explicit environment file:

```bash
cd ~/idea-to-app_v0.75/app/worker
FORGE_ENV_FILE=.env.demo.aliyun npm start
```

Run only one Worker. If a background instance already exists, do not start another. Windows shutdown, WSL shutdown or stopping that process makes task/recovery requests wait; opening Forge cannot restart the operating-system process.

## Account prewarming

A signed-in, visible, online Forge tab checks the current account's confirmed projects with an existing checkpoint, sandbox and Preview URL. It performs a check on entry and every five minutes, with focus/online/visibility events subject to the same per-project cooldown. Healthy URLs are reused. Explicit failures enqueue the existing authenticated preview recovery RPC sequentially; backend task/writer/reconcile fences still decide admission. Unknown connectivity is left to the opened project's bounded health checks.

Other accounts, deleting projects, incomplete first builds and held/uncertain workspaces are excluded. Logout, hidden pages and offline state prevent new warmup submissions, including when logout happens during a probe. Already accepted recovery operations finish normally. No LLM, new sandbox, source mutation or permanent keepalive is introduced. Idle stop remains 120 minutes in the current Demo configuration. A queued recovery still needs the Worker to be running.

## Daytona interstitials

A first-visit Daytona warning page can return HTTP 200 while the sandbox runtime is stopped. A successful warning response is not application readiness. Health probes on known Daytona preview hosts send the documented `X-Daytona-Skip-Preview-Warning: true` header, then check actual upstream HTTP success. A remaining `Daytona Preview - Warning` HTML title is also rejected. The header is only for the health request; iframe navigation remains normal. This does not disable authentication or expose an admin key.

Local regressions cover warm/cold/unknown health, a 200 warning interstitial, same-URL recovery, account isolation, serial/cooldown behavior and logout/hidden cancellation. Public smoke must separately verify that the already stopped project's normal UI enqueues recovery and reaches a working preview without source revision/hash changes.
