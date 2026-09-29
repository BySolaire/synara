# Configure the remote MVP

This is the handoff from implementation to the first real MacBook ↔ Mac Mini test. Use the same build from `codex/cloudflare-remote-mvp` on both computers. Local qualification is recorded in [STATUS.md](STATUS.md); it does not substitute for a live Cloudflare/WorkOS test.

## What must run

| Component                       | Where it runs                                          | What the operator supplies                                                |
| ------------------------------- | ------------------------------------------------------ | ------------------------------------------------------------------------- |
| Synara account API (`apps/api`) | A continuously running Bun service behind public HTTPS | Public URL, environment variables and persistent signing key              |
| WorkOS AuthKit                  | WorkOS                                                 | Application/client ID, API key, authentication settings                   |
| PostgreSQL                      | Supabase PostgreSQL, reachable by the account API      | A persistent database and connection URL                                  |
| Cloudflare Tunnel               | Cloudflare plus the bundled connector on the Mini      | Active DNS zone and scoped API token, kept on the account API             |
| Synara                          | Both Macs, separate installation homes                 | Same account/workspace and a Beta/Canary build with remote access enabled |

There is no Synara traffic-relay service to deploy. The shared account API is
now hosted on Cloudflare Containers for the profiles trial; see the
[deployed trial and evidence](../cloudflare-profiles/READINESS.md). This does not
configure remote tunnel provisioning, test enrollment or prove two-Mac access.
Railway is excluded. Avatar storage and iOS work are not required for remote.

## Configuration in dependency order

1. Reuse the existing Supabase Synara project and dedicated account role configured for the profiles trial. Account tables use default-deny RLS and deny Data API roles; preserve the sponsor tables and their enabled Data API. `DATABASE_URL` is already a Cloudflare secret with verified TLS. Do not point automated test suites at this database. See [database instructions](../../../apps/api/README.md#supabase-postgresql-with-workos).
2. Configure a WorkOS AuthKit application using [the API setup instructions](../../../apps/api/README.md#dashboard-setup). Set `IDENTITY_PROVIDER=workos`, `WORKOS_API_KEY`, and `WORKOS_CLIENT_ID`. Enable Magic Auth for the email-code login; configure social providers only if testing their buttons. The desktop browser flow needs the documented loopback redirect. Leave issuer/JWKS overrides unset for ordinary WorkOS discovery. Use the same application for both Macs.
3. Choose the public HTTPS origin of the account API. `ACCOUNT_BASE_URL` is that origin (for example `https://accounts.example.com`); `API_PUBLIC_URL` is the exact same origin plus `/api/v1`. Persist one `API_SIGNING_KEY` across redeploys; it is a base64url 32-byte Ed25519 seed, generated once and stored in the host's secret manager. Configure `TRUSTED_PROXY_HOPS` for the actual proxy chain, as described in the API README.
4. Set all four Cloudflare variables from [the operations guide](../../cloudflare-remote.md#test-service-configuration): account ID, zone ID, API token and tunnel domain. Use an active zone with HTTPS certificate coverage for one generated label beneath the domain. Grant tunnel administration for that account and DNS administration for that zone. Synara creates named tunnels, ingress configuration and DNS records automatically; do not manually create a tunnel for each device or copy an administrative token to a Mac.
5. Deploy/start `apps/api` using [its deployment instructions](../../../apps/api/README.md#build-and-run). For a source deployment with dependencies already installed, `bun run --cwd apps/api start` loads the API environment and starts it. `GET /api/v1/instance` and `GET /api/v1/keys/jwks` should succeed over public HTTPS; these are discovery checks, not proof of a working login or tunnel.
6. On both Macs set `SYNARA_ACCOUNT_URL` to the API origin, without `/api/v1`, in the environment used to launch Synara. Restart the application after changing it. An unset value uses the built-in hosted API, so configuring another API alone does not redirect the app to it. Sign in to the same account and workspace on both Macs.
7. Copy that test account's WorkOS user ID into the API's `REMOTE_TEST_USER_IDS`, then restart the API. Do this before creating the first pairing code. Empty enrollment deliberately refuses remote access. This allowlist is for the internal MVP; it is not a subscription check.
8. Use **Hosts & devices** on the Mini to create a code. Enter it on the MacBook, compare the displayed identity groups, request access, and approve the exact MacBook device fingerprint on the Mini. Press **Connect** on the MacBook. Credentials for WorkOS, PostgreSQL and Cloudflare administration stay on the API; the app receives only its own session/device/tunnel credentials.

Stable deliberately refuses remote connections. For an unpackaged development server use Node 24 and `SYNARA_REMOTE_CONNECTIONS=1`; do not run that server under Bun. A packaged Beta/Canary supplies its runtime and connector. Keep the Mini powered, online and awake with Synara running for unattended access.

## What the first live test must prove

- A new login and host link complete with real WorkOS, including session refresh. A user outside the test allowlist cannot provision or pair.
- The API creates a named tunnel and proxied DNS record without manual per-host setup. The generated HTTPS endpoint becomes reachable from a different network; unrelated app/admin paths are unavailable.
- Code lookup alone does not grant access. Expired, cancelled and replayed codes are rejected; the approved device connects with the pinned host identity.
- A temporary failure during pairing allows retry of the already reviewed code until expiry. Cancelling or forgetting clears the local pending state; a new code starts a new pairing.
- Disconnecting/reconnecting the network, restarting the connector/app and sleeping/waking the Mini recover without repeating a completed pairing. Existing execution-host work remains recoverable. Commands are not blindly replayed.
- Revoking the device or unlinking the host closes access. The API authorization lease expires during an API outage. Reconnection cannot bypass revocation.
- A declared-duration unattended run covers credential renewal; record actual connection and recovery timings. “24/7” requires an available Mini and measured recovery, not just a passing local fixture.

## Remaining boundary

For the **internal two-Mac MVP**, the remaining external work is service configuration/deployment and this live qualification. The repository contains the connector, automatic allocation, code rendezvous, approval, trust persistence, reconnect and revocation paths.

For a **customer launch**, also connect an authoritative paid entitlement source and qualify the signed distribution on supported platforms. `REMOTE_TEST_USER_IDS` must not be presented as payment enforcement. Billing integration is separate from proving the remote MVP and has not been implemented by this task.
