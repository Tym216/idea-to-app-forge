# Preview startup recovery

The platform HTML wraps module loading with a shared load guard. It shows a loading notice after one second; initial module errors or a 12-second missing-content deadline can reload the exact same iframe URL once. A sessionStorage marker scoped to the project is recorded before retry, cleared only after a rendered initial load. No model, source mutation, sandbox lifecycle operation, new proxy URL, or data reset is involved.

Auto navigation requires no observed application content and no user interaction. The storage bridge must confirm there are no dirty/unacknowledged writes and freezes subsequent writes before navigation. Corrupt/conflicting storage never permits automatic navigation. After rendered content or interaction, errors show a manual reload action instead. Missing sessionStorage disables automatic retry. Further failure shows a concise in-frame explanation and collapsed technical diagnostics, rather than an unhandled blank page.

This is initial display recovery, not functional acceptance. It cannot promise to detect every semantic/UI problem. A new runtime fingerprint is intentional because the browser runtime changed; existing source revisions/checkpoints remain untouched. Existing live Vite runtimes require the normal guarded platform upgrade/recovery path before receiving the new HTML. Worker and frontend regression tests stay local; no real model or A1–A4 browser suite is needed.

## Parent-origin authentication correction

`document.referrer` describes the preceding navigation and is not the iframe parent identity. A real browser fixture reproduced `APP_STORAGE_HOST_MISMATCH` after a child-side proxy/interstitial redirect, even with a legitimate Forge parent. Bootstrap now checks `location.ancestorOrigins[0]` when the browser provides it, then requires the existing exact-parent-window, exact-origin, random-channel handshake before launching App modules. Browsers without ancestorOrigins rely on that same strict handshake; no referrer-based grant, wildcard targetOrigin or extra host allowlist is introduced.

A genuinely foreign parent remains rejected before application launch and cannot access the trusted host's data. Missing/private referrer and proxy redirects are supported. Genuine host mismatch does not automatically reload; it offers an explicit link to the configured Forge preview and reports safe expected/observed origin diagnostics.
