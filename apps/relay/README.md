# Retired relay fixture

The application data path moved to [managed Cloudflare tunnels](../../docs/cloudflare-remote.md). This source remains only for legacy protocol regression tests. Its Docker deployment has been removed; do not deploy it for the current MVP. The Node host no longer dials it and the account app no longer exposes its control credentials.

Session close codes and socket/backpressure contracts in `packages/relay-protocol` still have application consumers and must not be deleted with this fixture.
