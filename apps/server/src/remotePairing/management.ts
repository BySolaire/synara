import { accountStateDirectory } from "../accountAuth";
import { calculateJwkThumbprint } from "jose";
import { X509Certificate } from "node:crypto";
import {
  EnvironmentId,
  type RemoteAccessRequest,
  type RemoteAccessResult,
  type RemotePairingBundle,
} from "@synara/contracts";
import { desktopFlavorFromBundleId } from "@synara/shared/betaFeatures";
import { Effect } from "effect";
import { accountApiIssuer, readAccountFile } from "../accountAuth";
import type { HostsAccountSession } from "../accountSession";
import type { AuthControlPlaneShape } from "../auth/Services/AuthControlPlane";
import type { ServerConfigShape } from "../config";
import type { ServerEnvironmentShape } from "../environment/Services/ServerEnvironment";
import type { HostConnectionRegistry } from "../hostConnections/registry";
import type { RemoteDeviceTrustRepositoryShape } from "../persistence/Services/RemoteDeviceTrust";
import type {
  RemoteAccountBinding,
  RemoteHostTrustRepositoryShape,
} from "../persistence/Services/RemoteHostTrust";
import { requireRemoteConnections } from "../remoteFeaturePolicy";
import {
  initializeRemoteTlsIdentity,
  loadRemoteTlsIdentity,
  remoteTlsAnchor,
  remoteTlsIdentityPath,
  remoteTlsRootNeedsRepair,
  resetRemoteTlsIdentity,
} from "../remoteTransport/certificates";
import { pairRemoteHost } from "./client";

export interface RemoteAccessManagementOptions {
  readonly config: ServerConfigShape;
  readonly environment: ServerEnvironmentShape;
  readonly control: AuthControlPlaneShape;
  readonly devices: RemoteDeviceTrustRepositoryShape;
  readonly hosts: RemoteHostTrustRepositoryShape;
  readonly account: HostsAccountSession;
  readonly connections: HostConnectionRegistry;
}
export type RemoteAccessManagement = (
  request: RemoteAccessRequest,
  signal: AbortSignal,
) => Promise<RemoteAccessResult>;

export function makeRemoteAccessManagement(
  options: RemoteAccessManagementOptions,
): RemoteAccessManagement {
  const pairing = new Map<string, AbortController>();
  const readContext = async () => {
    const account = await readAccountFile(
      accountStateDirectory(options.config.baseDir, options.config.devUrl),
    );
    if (!account?.userId || !account.organizationId)
      throw new Error("Sign in to manage remote access");
    const local = await Effect.runPromise(options.environment.getDescriptor);
    const binding: RemoteAccountBinding = {
      controllerEnvironmentId: local.environmentId,
      accountAuthority: accountApiIssuer(account.accountUrl),
      userId: account.userId,
      organizationId: account.organizationId,
    };
    return { account, local, binding };
  };
  return async (request, signal) => {
    requireRemoteConnections(options.config.stateDir);
    const { account, local, binding } = await readContext();
    if (request.operation === "revoke-account-sessions") {
      return {
        kind: "account-sessions-revoked",
        ...(await options.account.revokeDeviceAccountSessions({ deviceId: request.deviceId })),
      };
    }
    if (request.operation === "device-info") {
      const identity = await options.account.dialIdentity();
      return {
        kind: "device-info",
        deviceJkt: await calculateJwkThumbprint(identity.publicJwk),
        label: local.label,
      };
    }
    if (request.operation === "forget-host") {
      pairing.get(JSON.stringify([binding, request.environmentId]))?.abort();
      const trusted = await Effect.runPromise(options.hosts.get(binding, request.environmentId));
      if (trusted) options.connections.remove(trusted.hostId);
      await Effect.runPromise(options.hosts.forget(binding, request.environmentId));
      return { kind: "done" };
    }
    if (request.operation === "pair") {
      const bundle = request.bundle;
      await Effect.runPromise(options.hosts.importInvitation(binding, bundle));
      const { hosts } = await options.account.listHosts();
      const host = hosts.find(
        (candidate) =>
          candidate.id === bundle.hostId && candidate.environmentId === bundle.environmentId,
      );
      if (!host) throw new Error("The invitation host is not available in this account");
      const identity = await options.account.dialIdentity();
      const key = JSON.stringify([binding, bundle.environmentId]);
      if (pairing.has(key)) throw new Error("Pairing is already in progress for this host");
      const lifetime = new AbortController();
      pairing.set(key, lifetime);
      try {
        await pairRemoteHost({
          host,
          anchor: bundle,
          bundle,
          identity,
          label: local.label,
          signal: AbortSignal.any([signal, lifetime.signal]),
          relayUrl: options.config.relayUrl?.toString(),
          requestGrant: async () => (await options.account.requestGrant({ hostId: host.id })).grant,
        });
        const current = await readContext();
        if (JSON.stringify(current.binding) !== JSON.stringify(binding))
          throw new Error("Account changed during pairing");
        const confirmed = await Effect.runPromise(
          options.hosts.confirm(
            binding,
            bundle.environmentId,
            bundle.rootFingerprint,
            new Date().toISOString(),
          ),
        );
        if (!confirmed) throw new Error("Local trust changed during pairing");
        return { kind: "paired", environmentId: bundle.environmentId, hostId: host.id };
      } finally {
        if (pairing.get(key) === lifetime) pairing.delete(key);
      }
    }
    if (!account.hostId || account.hostOwnerUserId !== binding.userId)
      throw new Error("Link this host to your own account first");
    const identityPath = remoteTlsIdentityPath(options.config.secretsDir);
    if (request.operation === "reset-identity") {
      if (request.environmentId !== local.environmentId)
        throw new Error("The environment changed. Review the reset on this computer.");
      await Effect.runPromise(
        options.devices.resetEnvironment(local.environmentId, new Date().toISOString()),
      );
      await resetRemoteTlsIdentity(identityPath, local.environmentId);
      return { kind: "done" };
    }
    let identity;
    try {
      identity = await loadRemoteTlsIdentity(identityPath, local.environmentId);
    } catch (cause) {
      if (request.operation === "list")
        return {
          kind: "host-state",
          invitations: [],
          devices: [],
          rootExpiresAt: null,
          rootNeedsRepair: true,
        };
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      if (
        request.operation !== "create-invitation" ||
        (await Effect.runPromise(options.devices.hasIdentity(local.environmentId)))
      ) {
        throw new Error(
          "The host root is missing. Restore it or explicitly reset remote trust before pairing again.",
        );
      }
      identity = await initializeRemoteTlsIdentity(identityPath, local.environmentId);
    }
    const anchor = remoteTlsAnchor(identity);
    const scope = {
      environmentId: EnvironmentId.makeUnsafe(local.environmentId),
      rootFingerprint: anchor.rootFingerprint,
      accountAuthority: binding.accountAuthority,
      userId: binding.userId,
      organizationId: binding.organizationId,
    };
    switch (request.operation) {
      case "create-invitation": {
        const invitation = await Effect.runPromise(options.control.remotePairing.create(scope));
        const flavor = desktopFlavorFromBundleId(process.env.SYNARA_DESKTOP_BUNDLE_ID);
        const channel: RemotePairingBundle["channel"] =
          flavor === "beta"
            ? "beta"
            : flavor === "canary"
              ? "canary"
              : flavor === "production"
                ? "stable"
                : "dev";
        return {
          kind: "invitation",
          bundle: {
            v: 2,
            ...anchor,
            ...scope,
            ...invitation,
            channel,
            hostId: account.hostId,
            label: local.label,
          },
        };
      }
      case "list":
        return {
          kind: "host-state",
          invitations: await Effect.runPromise(options.control.remotePairing.list(scope)),
          devices: await Effect.runPromise(options.devices.list(scope)),
          rootExpiresAt: new Date(
            new X509Certificate(identity.rootCertificate).validTo,
          ).toISOString(),
          rootNeedsRepair: remoteTlsRootNeedsRepair(identity),
        };
      case "approve":
        if (
          !(await Effect.runPromise(
            options.control.remotePairing.approve(scope, request.inviteId, request.deviceJkt),
          ))
        )
          throw new Error(
            "The invitation or requested device changed. Review it again on this host.",
          );
        return { kind: "done" };
      case "cancel-invitation":
        await Effect.runPromise(options.control.remotePairing.revoke(scope, request.inviteId));
        return { kind: "done" };
      case "revoke-device":
        await Effect.runPromise(
          options.devices.revoke(scope, request.deviceJkt, new Date().toISOString()),
        );
        return { kind: "done" };
    }
  };
}
