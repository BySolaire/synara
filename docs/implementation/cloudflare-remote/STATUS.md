# Cloudflare Remote — execution state

Updated 2026-09-29. Original base `42aa8fb4f093f78fe7a1f7be5525f67571086ebf` verified clean; existing isolated worktree `a816/synara`, branch `codex/cloudflare-remote-mvp`. Git emits known AppleDouble index warnings; branch creation succeeded (exit 0) after granting Git metadata access. No pack repair.

## Completion levels

- Implementation: complete.
- Local qualification: complete. See [QUALIFICATION.md](QUALIFICATION.md) for commands, evidence and limits.
- Live qualification: in progress. Real service configuration, same-account
  login, managed provisioning, two-Mac pairing and remote file reading have
  passed with a process-scoped DNS override during propagation. Controller
  restart and connector crash recovery now pass without manual reconnect.
  Normal DNS, live revocation and unattended qualification remain pending.
  See the dated entries.

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

## Supabase database selection — 2026-09-28

The selected stack is WorkOS AuthKit for identity, Supabase PostgreSQL for account
metadata, and Cloudflare Tunnel for remote transport. WorkOS tokens and session
flows are unchanged. The API continues using `pg`/Drizzle with a server-only
`DATABASE_URL`; no Supabase Auth, client SDK or third-party JWT bridge is needed.

Migration `0015_account_table_rls` enables default-deny RLS on all 15 account API
tables. This prevents untrusted database roles with table grants (such as
Supabase's Data API roles) from reading or changing rows outside Synara's API.
The database-owner runtime remains authoritative for WorkOS-scoped checks. The
new PostgreSQL regression verifies table coverage, denied reads/writes and
preserved access for a non-superuser table owner. No historical migration was
changed; the generated snapshot adds only RLS flags.

The API README, environment example and readiness checklist now cover Supabase
direct/session-pooler URLs, verified TLS/project CA, disabled Data API, database
ownership and isolation from automated-test fixtures. Future migration to another
standard PostgreSQL host remains possible.

Validation uses a disposable local PostgreSQL instance, not the connected
Supabase project. The first parallel API run raced while creating the empty
Drizzle migration table; applying migrations once before the test run resolved
that fixture bootstrap race. The full API suite passed 319/319. Workspace
checks and migration lineage are recorded with the completion report. Live
Supabase TLS, WorkOS and Cloudflare qualification remains pending service setup;
no hosted database or authentication settings were changed.

## Shared account service update — 2026-09-29

The profiles trial now has a deployed Cloudflare account API, verified Supabase
TLS/database role and hosted synthetic privacy checks. See
[profiles qualification](../cloudflare-profiles/READINESS.md) for current service
state; earlier no-resource statements describe the preceding remote-only work.
Real WorkOS login and the migrated account session have now been verified on
`synara-account-api-trial.synara-orgs.workers.dev`. Tunnel provisioning, remote
enrollment and two-Mac acceptance remain unverified. This deployment does not
mark remote access complete.

## Remote deployment review — 2026-09-29

The Worker was missing the five optional remote runtime bindings, so setting
them in Cloudflare would not configure the API Container. Its explicit
forwarding list now includes the four `CLOUDFLARE_*` tunnel settings and
`REMOTE_TEST_USER_IDS`. Container configuration tests cover forwarding and
the unconfigured case; unrelated Worker bindings remain excluded. The API's
existing config tests cover rejection of incomplete tunnel settings.

Live inspection found no zones or tunnels in Synara Orgs and none of those five
bindings on the API. The operator chose `trysynara.com` and deferred its DNS
move from Vercel. The website can remain hosted on Vercel. The
[readiness checklist](READINESS.md) records the remaining DNS preparation,
runtime token/enrollment, Container restart and two-Mac acceptance steps.
No live remote connection is claimed, and this code correction is not itself
a deployment or DNS change.

### Live Quick Tunnel transport proof

A disposable test on the Mac Mini successfully routed through a real Cloudflare
Quick Tunnel using the branch's `startCloudflareIngress`, `RemoteTlsServer`,
host gateway and `dialHost`. It exchanged an authenticated, native-TLS-encrypted
synthetic application frame. An incorrect pinned host identity and an
unapproved device were rejected; public admin paths returned 404. The connector
was stopped and fixture state cleaned up afterward.

The test used ephemeral fixture account grants and approvals, not a real
WorkOS session, and ran both endpoints on one Mac through Cloudflare's public
edge. It does not qualify the two-Mac UI flow, managed provisioning, pairing-code
delivery or unattended recovery. The normal app still needs managed tunnel
configuration; Quick Tunnel support is not wired into its pairing flow.

Initial attempts failed resolving the newly allocated hostname. Public DNS over
HTTPS returned the Cloudflare address while the Mac's normal resolver returned
NXDOMAIN. The passing test waited for public DNS publication and used that
resolution only inside its own process, with TLS verification enabled. No OS
DNS settings or domain nameservers changed. A user-facing temporary-tunnel test
also needs hostname resolution verified on the controller's network.

The forwarding fix passed workspace formatting, lint (zero errors; existing
warnings) and typecheck, plus 29 focused API tests and 19 server remote tests.
The live Quick Tunnel transport check passed separately. PostgreSQL-dependent
API tests and the two-Mac acceptance suite were not rerun for this deployment
binding change.

## Managed DNS activation — 2026-09-29

After the operator approved the exact nameserver change, Namecheap saved
`cecelia.ns.cloudflare.com` and `eric.ns.cloudflare.com` for `trysynara.com`.
The registry confirms the delegation and Cloudflare reports the zone active in
Synara Orgs. The full ten-record Vercel inventory was copied before switching;
website records remain DNS-only and point to the original Vercel destinations.
HTTPS checks returned 200 from Vercel and its project Analytics history remained
present. No DNSSEC DS delegation existed. No interruption was observed in these
checks; they are not continuous uptime monitoring or a mail-delivery test.

The zone's Free website plan is separate from the account's verified Workers
Paid plan. Some resolver caches initially retained the Vercel nameservers.
Direct DNS requests from this Mac returned recursive, not authoritative,
responses; do not treat them as direct checks of Cloudflare nameservers.

The tested Worker forwarding fix was deployed as version
`e4641bcd-79ef-43e5-93c4-5f54af5f1e89`, preserving the existing API Container
image and runtime secrets. Remote token creation, installation of all five
remote bindings, Container restart and real two-Mac acceptance remain pending.

## Remote service configured — 2026-09-29

The operator explicitly approved creating `synara-remote-tunnels-trial` with
no expiration, cloudflared connector write in Synara Orgs and DNS write limited
to `trysynara.com`. The token was stored outside the repository with private
filesystem permissions and in the account API's Worker secrets. A single bulk
secret update installed all four Cloudflare settings plus the one-user trial
allowlist, preserving unrelated secrets. Runtime-token verification, tunnel
listing and DNS listing succeeded; the DNS baseline still contained the ten
preserved website/mail records and there were no tunnels before testing.

Container rollout `e3b5f8d2-4e2d-46d4-8e4c-0a25987f7f9c` completed with one
healthy instance and no reported rollout errors. Public API discovery and JWKS
checks returned 200. This verifies deployment health, not managed provisioning
or a real remote connection.

The current branch's CLI and web build passed (four build tasks). A separate
Node 24 test instance runs on loopback port 4775 with its own home, after the
dev runner dry-run and IPv4/IPv6 listener checks. The older profiles test and
the regular Synara instance were left running. The new instance uses the
Synara Orgs API directly. The operator completed a fresh WorkOS login, the
machine linked successfully, and Hosts & devices exposes the pairing controls.
The new login selected a different WorkOS identity than the earlier profiles
test. After verifying it through `/api/v1/me`, the allowlist was replaced with
only the current Mini user; rollout `5ff927a9-475c-4a50-85a5-21aa798ee595`
completed and API discovery returned 200. The older profile session is still
bound to the legacy API URL, so it was not silently rewritten or copied to the
new installation.

The operator requested coordination with Codex on the connected MacBook. A
separate MacBook task prepared an isolated worktree at commit
`20b8f71b342f11532cc7caee4ef03a04fd6e7f52`, matching the Mini's application
sources, and passed the frozen-lockfile install and CLI/web build. Its Node
24.21.0 server listens only on `127.0.0.1:4776`, with a separate test home.
The MacBook task verified local UI and API discovery HTTP 200. The operator
completed login, and both machines' WorkOS user and organization IDs match.
The MacBook device thumbprint was independently recomputed from its public key
and matched the registered device. The operator explicitly approved pairing
that exact device with the isolated Mini instance.

Creating a pairing code through the Mini UI initialized its remote identity.
Synara automatically provisioned one named Cloudflare tunnel and its proxied
DNS record; Cloudflare reported healthy with four connector connections. The
ten existing website/mail records remained present. Cloudflare and Google
DNS-over-HTTPS resolved the generated hostname to Cloudflare, but the Mini's
system resolver still returned the old Vercel wildcard destination. A probe
using the public DNS result only within that process, with normal TLS
validation, returned 200 for `/health` and 404 for `/` and `/api/v1/instance`.
The normal system-resolution probe reached Vercel instead. This is a DNS
propagation limitation, not a passing normal-path remote connection. No OS
DNS setting or certificate validation was changed. The MacBook's normal DNS
path also reached Vercel. Its first code lookup returned the exact Mini root
and expected controller thumbprint, but UI navigation discarded the preview
before the access request. That invitation was cancelled on the Mini.

To continue transport qualification during propagation, a temporary preload
outside the repository limits a DNS override to the exact generated hostname
inside the MacBook test process. The Cloudflare address came from public
DNS-over-HTTPS; the MacBook's independent HTTPS probe returned 200 with normal
certificate validation. This workaround is test-only and does not qualify
ordinary DNS resolution.

A fresh code then completed the real two-Mac UI flow: the MacBook compared
every Mini identity group, the Mini approved the exact operator-confirmed
device thumbprint, and the MacBook reported successful pairing and connection.
The Mini displayed the authenticated MacBook session with Cloudflare transport.
From the MacBook editor, the operator's coordination task opened a disposable
project and read the exact random proof value from a file created only on the
Mini. No provider request was sent. Approval survived a Mini page reload.
After that read, the MacBook renderer remained on `Connecting…` and the Mini's
active RPC session disappeared before any intentional connector interruption.
The unchanged connector and public health endpoint remained healthy. A separate
authenticated controller bridge remained open for 60 seconds, with successful
requests at 0, 20, 40 and 60 seconds. Wire evidence identified the cause: the
remote renderer subscribed to `device.subscribeEvents` and
`computer.subscribeEvents`, which the host correctly rejects as local-only.
Those stream failures triggered a global renderer reconnect. The controller
observed `Renderer detached` closures, without a transport error. The web
adapter now skips these two subscriptions in remote execution while retaining
them locally and preserving the server-side denial. The regression failed
before the change, and all 90 focused adapter/transport tests pass after it.
The rebuilt MacBook UI remained connected for over a minute, with no further
renderer-detached loop. The controlled connector interruption then exposed a
second defect: cloudflared restarted automatically, but the MacBook remained
connecting beyond the 120-second observation window. Its durable desired host
and connection view were `stopped`; a temporarily missing published route had
been classified as terminal. Missing routes now use bounded reconnect backoff,
while revocation, identity, authentication and compatibility failures retain
their existing handling. A supervisor/registry regression fails before this
change and passes after it.

The controller restart check found a separate lifecycle defect. Runtime
instrumentation showed its remote supervisor starting and stopping two
milliseconds apart: `Effect.provide` closed the handler layer when the HTTP
factory returned. Handler provisioning now belongs to the router layer, whose
scope lasts until server shutdown. After rebuilding and restarting the
isolated MacBook controller, the existing page reconnected automatically and
read the Mini's proof file again, with no reload, `hosts.connect`, or pairing.
The built-workspace E2E now waits for restored connections before any manual
action and no longer reloads the page after controller restart; it passes.

A second live interruption forcibly terminated only the isolated Mini's
cloudflared process at 11:57:58.574 UTC. Synara replaced it automatically.
The MacBook recorded socket closure at 11:58:04.343 and a restored connection
at 11:58:07.715: approximately 9.1 seconds from termination and 3.4 seconds
from the observed close. A subsequent authenticated file read matched the
Mini's proof. No retry button, page reload, manual connection, or new pairing
was used. These timings are one measured trial, not a recovery guarantee.

Final checks: format, lint (792 warnings, zero errors), typecheck (13 tasks),
CLI/web build (4 tasks), 90 adapter/transport tests, 55 lifecycle/auth/host
tests, and the strengthened built-workspace E2E passed. The first full suite
passed all 12 tasks; subsequent full runs on the recovery changes passed 11
of 12, failing the unchanged `accountCredentialLock.test.ts` real-process
contention test with `ENOTEMPTY`. Its isolated rerun passed 3/3; the final
full suite is therefore not reported as green. Database/E2E cases skipped by
the ordinary root run are not included in its passing count. The E2E used a
disposable local PostgreSQL cluster, now stopped.

Live revocation has not been performed: automatic approval review required
separate operator consent for interrupting the approved device. The key
remains approved. Ordinary DNS, sleep/wake, authorization-outage behavior and
long unattended qualification also remain incomplete. This is not a signed
distribution or an unattended reliability result.

The newly installed official `cf` CLI (`1.0.0-beta.5`) is authenticated to
Synara Orgs with read-only OAuth scopes. A DNS listing through this CLI matched
all ten baseline records exactly, including DNS-only website CNAMEs. Runtime
tunnel writes use the separate scoped service token, and deployment operations
use the existing authorized deployment credentials.
