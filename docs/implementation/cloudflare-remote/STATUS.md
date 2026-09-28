# Cloudflare Remote — execution state

Updated 2026-09-28. Base `42aa8fb4f093f78fe7a1f7be5525f67571086ebf` verified clean; existing isolated worktree `a816/synara`, branch `codex/cloudflare-remote-mvp`. Git emits known AppleDouble index warnings; branch creation succeeded (exit 0) after granting Git metadata access. No pack repair.

## Completion levels

- Implementation: complete.
- Local qualification: complete. See [QUALIFICATION.md](QUALIFICATION.md) for commands, evidence and limits.
- Live qualification: not run; no real services provisioned.

## Phase ledger

| Phase                   | State                              | Evidence / remaining                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 0 owners and references | complete                           | T3 comparison at `d15210cd3da79f9a1a495a6309d912d76362a046`, official Cloudflare API and limits; owner map below.                                                                                                                                                                                                                                                                                                                          |
| 1 account coordination  | implemented                        | Additive 0013/0014, immutable allocations, HostProof-only tokens, SQL leases/checkpoints, retryable cleanup and hourly retired-name sweep, same-account code rendezvous. API suite 318/318 passed, including delayed allocation-disable regression. Fresh WorkOS membership bypasses cache for provisioning/polling.                                                                                                                       |
| 2 connector             | implemented, Mac smoke passed      | Pinned official 2026.9.3, SHA256, dedicated loopback ingress, real readiness, cancellable provisioning/download, isolated home/config, shared process teardown. Actual binary launched/stopped from Electron app.asar (43.4.1 / Node 24.18.1). Focused tests and final browser E2E passed.                                                                                                                                                 |
| 3 dialer                | implemented                        | Explicit Cloudflare contract/labels and directory endpoint; no runtime relay fallback. HTTPS fixture transports pinned TLS, 512KiB hash/Range, RPC, resources and 4MiB backpressure burst. Substituted-root negative case passed in final E2E.                                                                                                                                                                                             |
| 4 revocation            | implemented                        | 10s jittered fresh snapshots, 60s lease; closes before durable tombstone/ACK. Real API device revocation tested through fixture. Async setup/teardown fencing; targeted allocation retirement prevents delayed cleanup affecting the next allocation.                                                                                                                                                                                      |
| 5 code pairing          | implemented, browser passed        | Atomic registered-device claim, budgets, expiration, same-account/org scope, preview stays server-side, compare full root and approve exact device. Browser flow passes on both screens. CLI private invitation remains available.                                                                                                                                                                                                         |
| 6 UI                    | implemented, visual evidence saved | Existing settings/button/input/checkbox primitives reused. Screenshots copied to durable task artifacts; see QUALIFICATION.md. No new UI primitives. First-use missing root no longer misleadingly requests repair.                                                                                                                                                                                                                        |
| 7 relay removal         | complete                           | Removed server/desktop relay config/fallback and Docker deployment workflow. Production API no longer exposes legacy relay credentials/tickets. Historical relay protocol fixtures retained; ADR 0016 and operations guide replace old instructions.                                                                                                                                                                                       |
| 8 local qualification   | final pass                         | Final E2E 16/16, API 318/318, focused lifecycle 13/13, build 10/10, typecheck 13/13, lint 792 existing warnings / 0 errors, Windows boundary and migration lineage passed. Root rerun passed 11/11 tasks: 13,914 tests passed / 246 skipped; database and E2E cases passed separately. The discovered signal-exit / Effect shutdown interaction was corrected. The built test now verifies connector PID exit and rejects forced shutdown. |
| 9 live                  | not run                            | No real resources provisioned; needs secure test configuration and two-Mac access after local completion. Commercial rollout still blocked by absence of real subscription authority (explicit test allowlist only).                                                                                                                                                                                                                       |

## Owner map and implementation order

WorkOS login and host link (`accountAuth`, API `hostKeyRegistry`) → host-proof authenticated allocation (`apps/api`, PostgreSQL) → dedicated loopback ingress + cloudflared (`hostConnectivity`, shared platform process boundary) → account directory exposes managed hostname only → authenticated code rendezvous → existing exact-JKT owner approval and SQLite trust → API grant + pinned TLS host mint → session registry/RPC/resources → API authorization snapshot polling, tombstones and ACK.

Keep public Cloudflare TLS separate from host P-256 TLS1.3. Never forward local admin routes or controller credentials. Pairing cloud delivery changes the out-of-band trust assumption: code lookup alone cannot confirm a root. Existing environment/account/generation fences and server Beta/Stable policy remain authoritative. No new provider/model, account stack, iOS app, production deployment or commercial entitlement system.

## Active local services and next action

Disposable PostgreSQL is stopped. It used `/private/tmp/synara-cloudflare-postgres/data`, 127.0.0.1:58433. Personal instance 7265 was preserved. Final E2E process inspection found no fixture connector/server remnants. Git AppleDouble warnings remain unchanged.

During qualification, the final process audit found connectors surviving a signal-induced Node exit. The existing Effect patch now keeps signal ownership during asynchronous finalization. A subprocess regression and built-workspace PID assertions cover the correction. Older fixture remnants were explicitly terminated. No operator process was targeted.

Logs: `/private/tmp/synara-cloudflare-{tests,api,e2e,all-types,build,format,lint,windows,migrations,electron,shutdown}.log`. Durable screenshots and compact checks: `/Users/emanueledipietro-macmini/.codex/visualizations/2026/09/28/01a0e737-6f66-7340-a97d-eada9d6c3680/cloudflare-remote/`.

Delivery: implementation commit `39784a61da783548060a1ed062b4ed6d9a314e8d` is published on `origin/codex/cloudflare-remote-mvp`. Final format and frozen patch-install verification passed; the installed-runtime regression passed 11/11. Live phase 9 needs secure test-environment setup and access to both Macs; no live success is claimed. No main merge, release, production deployment or commercial rollout.

## Follow-up readiness review — 2026-09-28

Reviewed the completed task against the first real two-Mac setup, including the WorkOS token contract, managed tunnel allocation/ingress, connector packaging and lifecycle, pairing, revocation and deployment instructions. The current WorkOS application/session-token documentation confirms the required `client_id` claim; no authentication boundary was relaxed.

The review reproduced and fixed controller pairing recovery defects:

- A transient account-directory or tunnel failure discarded a redeemed preview before success. The server now retains it until success, cancellation/forgetting, account change or expiry; the public code remains single-use and exact identity approval is unchanged.
- Forgetting/cancelling did not release the pending preview. It now clears the local preview and the UI directs the user to a fresh code.
- Concurrent setup could run before the per-host guard, and cancellation could race an unfinished trust import. The guard now owns the entire setup, and forgetting waits for its cancelled operation to settle before deleting trust.

Four focused regressions cover retries, cancellation/preview capacity, identity/account/expiry checks and concurrent setup cancellation. The browser qualification now deliberately stops the connector after code lookup, observes the failed attempt, restores connectivity and completes pairing with the same reviewed preview. Existing settings primitives are reused.

Checks: focused regressions 4/4; PostgreSQL API 318/318; rebuilt desktop/server 5/5 build tasks; typecheck 13/13; lint 0 errors / 792 existing warnings; format passed. Full Node 24 E2E passed 16/16 in 79.53 seconds. The first E2E attempt ran under the shell's Node 26 and was refused by the intended runtime gate; it was rerun on Node 24.21.0 without weakening that gate. Final full repository suite passed with Node 24 and cache bypass: 11/11 tasks, 13,918 tests passed / 246 skipped, 305.53 seconds. Database/build-dependent skipped cases passed in the separate API/E2E runs above.

The disposable PostgreSQL instance has been stopped again. This review used logs `/private/tmp/synara-remote-review-*` and browser evidence `/private/tmp/synara-remote-review-evidence`. No external credentials were configured, no real tunnel was provisioned and no live/signed/two-Mac qualification is claimed.

Follow [Configure the remote MVP](READINESS.md) for the remaining service setup and live test. API hosting is still required alongside WorkOS, PostgreSQL and Cloudflare. Internal test enrollment remains distinct from commercial paid-entitlement enforcement.
