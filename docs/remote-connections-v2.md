# Personal remote connections v2

The transport now uses managed Cloudflare tunnels; see [operations](cloudflare-remote.md) and [ADR 0016](adr/0016-managed-cloudflare-remote.md). The historical TLS and owner-pairing admission gates passed local integration and an isolated `app.asar` test under Electron 43 / Node 24; those results do not qualify the new connector. Remote admission is available only for Beta/Canary or explicitly opted-in Node 24 development; Stable and Bun-hosted remote admission remain disabled. Release qualification on two physical Macs and with a real provider is still outstanding. The presence of UI, migrations or passing tests is not release qualification. This document supersedes plaintext transport and automatic device-enrollment assumptions in the earlier remote-host ADRs and slice specifications.

## Boundaries

A window has one execution environment. Account, host directory and connection management always use the local controller; projects, provider sessions, filesystem, Git and terminals use the selected execution host. Switching flushes editors and reloads. Returning locally does not wait for the remote host: unsaved editor snapshots are retained in scoped recovery storage. “Export editor drafts” also retrieves remote recoveries for the currently verified account when the window is local. It never writes those paths on the controller.

Remote v2 requires Node 24, including Electron's Node runtime. Local Bun development still works; Bun cannot enable v2. Stable rejects remote connections. Beta/Canary enable the locally qualified transport; a headless development server requires `SYNARA_REMOTE_CONNECTIONS=1`. Importing Stable state into Beta suspends remote activation and preserves the destination identity. Account profile sync and host secrets sync remain disabled on both client and server.

The outer binary WebSocket carries TLS 1.3. Direct, SSH-forward and Cloudflare use the same authenticated TLS tunnel. The inner RPC WebSocket and typed HTTP resources use a host-specific P-256 root and SAN, never a public-CA fallback or plaintext downgrade. Roots last ten years; server leaves last ninety days and renew thirty days before expiry. Missing or replaced roots require explicit repair and pairing. Keys stay in the installation's private secret store; no system trust-store installation is needed.

The owner creates a ten-minute, single-use code in Settings. The same-account controller redeems it, explicitly compares the root fingerprint across both screens, and requests access. Headless private-file invitation transfer remains available. The controller authenticates the pinned host before submitting its device proof. The owner approves the exact requesting device JKT on the execution host. A cloud grant does not authorize an unapproved device. SQLite trust generations and revocation tombstones survive restart. Device-key revocation and WorkOS account-session revocation are separate operations; the UI reports per-host delivery pending until that host acknowledges durable revocation. Authorization snapshots are polled every ten seconds with jitter. A successfully applied snapshot grants a sixty-second lease; expiry closes existing streams, and hard host-proof denial disables the old scope. Offline hosts cannot promise instantaneous revocation.

The controller persists desired connections. Each renderer attachment gets a new RPC stream, including after reload. Renewal prepares a replacement stream; requests are never generically replayed. Discovery/connection completions are fenced against stop, disconnect and account changes. HTTP resources use an independent pool of at most two TLS transports per host generation, bounded queues, streaming backpressure, Range and cancellation. Typed references choose allowlisted host routes; controller cookies and bearer credentials are not forwarded. Remote attachment ownership is stable across short-lived session leases.

## Headless owner pairing

Run on the execution host, against its existing verified loopback server, using its configured home directory and Node 24. These commands use the same owner RPC and capability gate as Settings; they do not edit trust databases directly.

```sh
synara --home-dir /path/to/isolated-home remote invite --output /private/path/invitation.json
synara --home-dir /path/to/isolated-home remote list
synara --home-dir /path/to/isolated-home remote approve --invite-id INVITE_ID --device-jkt EXACT_REQUESTING_JKT
synara --home-dir /path/to/isolated-home remote reject --invite-id INVITE_ID
```

The invitation file is created exclusively with mode `0600`; its secret is not printed. If a response is lost, inspect the host state before retrying. An existing invitation file is never overwritten. Where the loopback server requires a bootstrap token, use its existing `SYNARA_AUTH_TOKEN` environment configuration.

## Linked projects

“Linked projects” in the host menu opens a controller-origin catalog. Its storage key includes the verified controller EnvironmentId and account authority/user/organization. Opening the catalog records a project-only snapshot of the selected host; other hosts remain cached metadata, without transcript subscriptions. Open the catalog on each host to capture its project list.

A checkout is `{environmentId, projectId}`; a thread remains `{environmentId, threadId}` in its original environment. Group names, appearance, members and preferred checkout are local presentation metadata. Linking, unlinking or splitting never moves files or chats. A preferred checkout is a visible preference, not execution failover. Opening another member explicitly checks its host identity, saves editor state and switches the window. Missing checkouts fail explicitly. Offline catalogs are read-only.

GitHub suggestions normalize SSH/HTTPS and `.git` conservatively and require confirmation. Fork owners remain distinct; multiple repository identities do not produce suggestions. Other Git servers and no-remote projects can be linked manually. The normalization utility preserves significant case and ports on self-hosted servers. Dismissed suggestions and unlink/split corrections persist. Two clones remain two members even on the same computer.

## Unsupported remote surfaces

Agent-controlled browser, dev-server previews, Computer Use, device control, AppSnap and external editors are unavailable in remote execution. Both RPC admission and UI capabilities enforce this boundary. Local clipboard, export of received files and opening public links remain controller operations. Remote folder selection uses the execution filesystem.

## Persistence and verification

Main SQLite migrations 1–108 are unchanged. The historical private account tails are recognized by exact manifests before tracker repair; unknown hybrids fail closed. Usage migrations occupy 109/110, durable remote trust and pairing metadata 111, and desired host state 112. API PostgreSQL migrations are a separate chain: verified device/session binding and revocation delivery records are additive.

Qualification uses disposable SQLite, PostgreSQL and fake WorkOS fixtures, real Node sockets, an HTTPS Cloudflare-boundary fixture, Chromium and Electron. No user state or production account is needed. Relevant owners include `remoteSessions/httpRoute.test.ts`, `hostConnections/resourcePool.test.ts`, `hostConnections/registry.test.ts`, `hostConnections/port.test.ts`, API host authorization tests, execution-storage tests and browser host/catalog/picker tests. `SYNARA_RUNTIME_SMOKE=remote-tls` runs certificate generation/renewal and a 512 KiB encrypted round trip from the built runtime dependency smoke entrypoint.

Two physical Macs, authenticated providers, Linux headless behavior, Windows packaging, signed distribution and network/sleep recovery require separate qualification. A local bundle or Electron fixture does not establish those results. Do not claim release qualification until the corresponding evidence is recorded.

## Historical local qualification before the Cloudflare migration (28 September 2026)

The paragraphs below record the prior relay implementation. Current migration evidence lives in [STATUS.md](implementation/cloudflare-remote/STATUS.md); do not reuse the old counts or Docker commands for the new transport.

The migrated `apps/e2e` harness uses the production relay application in a Bun child process, the real Node/Effect host gateway, TLS and explicit exact-key owner approval, against isolated PostgreSQL and fake WorkOS. It covers relay/direct bytes, grant replay, account/relay outages, owner-only admission, backpressure and targeted session closure/expiry. It does not launch a paid agent. The inactive Host Secrets cryptographic core retains its tests; server admission for that feature stays disabled.

Run it on Node 24 with an isolated database and `SYNARA_E2E_AGENT=0 TEST_DATABASE_URL=... bun run --cwd apps/e2e test`. Each fixture uses an ephemeral home and loopback ports. This transport suite is separate from the full-workspace qualification below.

The packaged TLS proof ran the built server smoke entry from an isolated `app.asar` with its copied runtime dependencies, using Electron 43.4.1 / Node 24.18.1. It generated P-256 certificates, checked private permissions, renewed the leaf without replacing the root and transferred 524,288 bytes. This is not a signed full application artifact or a Linux/Windows runtime qualification.

A separate build-dependent workflow runs with `SYNARA_E2E_AGENT=0 TEST_DATABASE_URL=... bun run --cwd apps/e2e test:workspace`. It launches two built Node servers, the real Bun relay and Chromium with isolated homes. A deterministic provider CLI replaces only the external provider process. The real adapter and orchestration stream a task, continue while the controller is stopped, and restore the completed transcript after restart without replay. It also checks remote filesystem routing, attachment bytes and hashes across reconnect, approval and cancellation, and local recovery. This establishes fixture-provider continuity, not authenticated provider success. The expanded scenario also passes Git branch and terminal routing, attachment Range requests, revocation cutting off RPC/resources, and provider-process cleanup on host shutdown. Cancelling or refusing a relay splice must preserve the control connection and other sessions; native WebSocket regressions cover both this isolation and deferred errors during opening cancellation. The same browser workflow also interrupts the actual Bun relay during a running turn, records a provider delta while disconnected, and recovers that text after restarting the relay at the same origin without a browser reload. The provider PID and single-turn assertion cover both relay recovery and controller restart. Accelerated authorization expiry and one-use renewal remain separate real-socket tests; this does not claim a one-hour end-to-end credential soak.

The Cua benchmark snapshot test now creates a temporary repository from the actual checkout inputs, preserving its checksum and license assertions. It no longer depends on an unrelated committed `HEAD` while validating pending work.

The root `TEST_DATABASE_URL=... bun run test` command passes the isolated database URL to API/E2E tasks. The E2E package enables development remote admission only inside its Vitest configuration; do not globally opt the server's default-gate tests into remote access. The ordinary root suite skips the build-dependent browser workflow intentionally; run `test:workspace` separately after `bun run build`. The obsolete browser-owned grant/mint helper has been removed: credentials and dialing belong to the controller server.

The browser workflow also verifies the persisted interrupted turn after Stop. Successful parent interrupts retire the runtime generation, which can fence late terminal events; the command reactor now settles the targeted projection after confirmed retirement using the existing session compare-and-set. It preserves replacement turns and leaves targeted child interrupts scoped to the child. The real workflow reproduced the stuck-running state before the fix and passes after it.
