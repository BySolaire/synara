import { accountStateDirectory } from "./accountAuth";
import { createRemoteResourceGateway } from "./remoteTransport/resourceGateway";
import { requireRemoteConnections } from "./remoteFeaturePolicy";
import http from "node:http";
import { Effect } from "effect";
import type { AuthControlPlaneShape } from "./auth/Services/AuthControlPlane";
import type { RemoteDeviceTrustRepositoryShape } from "./persistence/Services/RemoteDeviceTrust";
import { acceptRemotePairing } from "./remotePairing/gateway";

import { createAccountClient } from "@synara/shared/account";
import WebSocket, { WebSocketServer } from "ws";
import {
  loadRemoteTlsIdentity,
  remoteTlsIdentityPath,
  remoteTlsAnchor,
} from "./remoteTransport/certificates";
import {
  RemoteTlsServer,
  REMOTE_INNER_RPC_PATH,
  REMOTE_INNER_PAIRING_PATH,
} from "./remoteTransport/tunnel";

import { EnvironmentId, type HostAuthorizationSnapshot } from "@synara/contracts";
import {
  accountApiIssuer,
  readAccountFile,
  refreshHostRegistration,
  resolveEnvironmentId,
} from "./accountAuth";
import type { SessionCredentialServiceShape } from "./auth/Services/SessionCredentialService";
import type { ServerConfigShape } from "./config";
import { startEndpointReporter } from "./endpointReporter";
import { ApiJwksCache, HostMintService } from "./hostAuth";
import { mintHostProof, readHostIdentity } from "./hostIdentity";
import { MAX_WEBSOCKET_MESSAGE_BYTES } from "./nodeHttpServer";
import { RelayDialSupervisor } from "./relayDial";
import {
  bridgeRemoteSocketToLocalRpc,
  RemoteConnectionGateway,
  RemoteSessionRegistry,
  registerHostRemoteSocketAcceptor,
} from "./remoteSessions";

export interface HostConnectivityOptions {
  readonly config: ServerConfigShape;
  readonly listeningPort: number;
  readonly localSessions: SessionCredentialServiceShape;
  readonly remoteSessions: RemoteSessionRegistry;
  readonly remoteTrust: RemoteDeviceTrustRepositoryShape;
  readonly authControlPlane: AuthControlPlaneShape;
}

export async function startHostConnectivity(options: HostConnectivityOptions): Promise<() => void> {
  requireRemoteConnections(options.config.stateDir);
  const credentials = await readAccountFile(
    accountStateDirectory(options.config.baseDir, options.config.devUrl),
  );
  if (
    !credentials?.hostId ||
    !credentials.hostOwnerUserId ||
    !credentials.organizationId ||
    credentials.hostKeyGeneration === undefined
  ) {
    return () => {};
  }
  const identity = await readHostIdentity(options.config.hostIdentityPath);
  if (!identity) return () => {};
  const environmentId = await resolveEnvironmentId(options.config.baseDir, options.config.devUrl);
  // Startup cannot silently replace a missing root. Only local pairing initializes it.
  const tlsIdentity = await loadRemoteTlsIdentity(
    remoteTlsIdentityPath(options.config.secretsDir),
    environmentId,
  );
  const trustScope = {
    environmentId: EnvironmentId.makeUnsafe(environmentId),
    rootFingerprint: remoteTlsAnchor(tlsIdentity).rootFingerprint,
    accountAuthority: accountApiIssuer(credentials.accountUrl),
    userId: credentials.hostOwnerUserId,
    organizationId: credentials.organizationId,
  };
  const authorizeDevice = async (userId: string, deviceJkt: string, generation?: number) => {
    if (userId !== trustScope.userId)
      throw new Error("Only the locally linked owner is authorized");
    const trusted = await Effect.runPromise(
      options.remoteTrust.authorize(trustScope, deviceJkt, generation),
    );
    if (!trusted) throw new Error("Device approval is missing or revoked on this host");
    return trusted.generation;
  };
  const client = createAccountClient({ baseUrl: credentials.accountUrl });
  const hostProof = () =>
    mintHostProof({
      identity,
      apiIssuer: accountApiIssuer(credentials.accountUrl),
      environmentId,
      hostId: credentials.hostId!,
      keyGeneration: credentials.hostKeyGeneration!,
    });
  // Fail-closed placeholder until the first successful refresh: nobody but
  // the link-time owner (checked separately, without this snapshot) gets in
  // on a host that has not yet heard from the account API.
  let authorization: HostAuthorizationSnapshot = {
    discoverable: false,
    ownerUserId: credentials.hostOwnerUserId,
    orgId: credentials.organizationId ?? "unknown",
    ownerInOrg: false,
    revokedDeviceJkts: [],
  };
  const refreshAuthorization = async () => {
    authorization = await client.getHostAuthorization(await hostProof(), credentials.hostId!);
    for (const jkt of authorization.revokedDeviceJkts) {
      await Effect.runPromise(
        options.remoteTrust.revoke(trustScope, jkt, new Date().toISOString()),
      );
      options.remoteSessions.closeDevice(jkt);
    }
    const pending = authorization.pendingRevocationDeviceJkts ?? [];
    if (pending.length) {
      // Acknowledgement follows the durable local tombstone, never receipt of
      // the relay frame. Failed delivery remains pending in the account service.
      await client
        .acknowledgeDeviceRevocations(await hostProof(), credentials.hostId!, pending)
        .catch(() => {});
    }
    return authorization;
  };
  const remoteSessions = options.remoteSessions;
  const apiJwks = new ApiJwksCache(() => client.getApiJwks());
  const mintService = new HostMintService({
    identity,
    apiIssuer: accountApiIssuer(credentials.accountUrl),
    environmentId,
    hostId: credentials.hostId,
    keyGeneration: credentials.hostKeyGeneration,
    ownerUserId: credentials.hostOwnerUserId,
    authorizeDevice,
    getApiJwks: () => apiJwks.get(),
    refreshApiJwksForUnknownKid: () => apiJwks.refreshForUnknownKid(),
    getAuthorization: refreshAuthorization,
  });
  const gateway = new RemoteConnectionGateway({
    mintService,
    identity,
    environmentId,
    keyGeneration: credentials.hostKeyGeneration,
    sessions: remoteSessions,
    authorizeDevice: async (userId, deviceJkt, generation) => {
      await authorizeDevice(userId, deviceJkt, generation);
    },
    bridgeToLocal: (socket, peer) =>
      bridgeRemoteSocketToLocalRpc(socket, peer, {
        listeningPort: options.listeningPort,
        sessions: options.localSessions,
        attachmentScope: {
          ...trustScope,
          deviceJkt: peer.deviceJkt,
          trustGeneration: peer.trustGeneration,
        },
      }),
  });
  const controller = new AbortController();
  const stops: Array<() => void> = [];
  const stop = () => {
    controller.abort();
    remoteSessions.closeAll();
    for (const cleanup of stops.splice(0)) cleanup();
  };
  try {
    const tunnel = new RemoteTlsServer({
      identity: tlsIdentity,
      request: createRemoteResourceGateway({
        identity,
        environmentId,
        keyGeneration: credentials.hostKeyGeneration,
        rootFingerprint: trustScope.rootFingerprint,
        listeningPort: options.listeningPort,
        localSessions: options.localSessions,
        sessions: remoteSessions,
        authorizeDevice: async (userId, jkt, generation) => {
          await authorizeDevice(userId, jkt, generation);
        },
      }),
      accept: (socket, path, ingress) => {
        if (path === REMOTE_INNER_PAIRING_PATH) {
          acceptRemotePairing(
            socket,
            trustScope,
            options.authControlPlane.remotePairing,
            options.remoteTrust,
          );
          return;
        }
        if (path !== REMOTE_INNER_RPC_PATH) {
          socket.close(1008, "Pairing unavailable");
          return;
        }
        return gateway.accept(socket, ingress.expectedPeer, ingress.via);
      },
    });
    stops.push(() => tunnel.close());
    stops.push(
      options.remoteTrust.onRevoked((scope, jkt) => {
        if (
          scope.environmentId !== environmentId ||
          scope.rootFingerprint !== trustScope.rootFingerprint
        )
          return;
        if (jkt) remoteSessions.closeDevice(jkt);
        else {
          remoteSessions.closeAll("remote access disabled");
          tunnel.close();
        }
      }),
    );
    const renewal = setInterval(() => {
      void loadRemoteTlsIdentity(remoteTlsIdentityPath(options.config.secretsDir), environmentId)
        .then((renewed) => {
          if (!controller.signal.aborted) tunnel.renew(renewed);
        })
        .catch(() => {
          console.warn("[synara] Remote TLS identity unavailable; local re-pair is required.");
          stop();
        });
    }, 60 * 60_000);
    renewal.unref();
    stops.push(() => clearInterval(renewal));
    stops.push(registerHostRemoteSocketAcceptor((socket) => tunnel.accept(socket)));
    const expirySweep = setInterval(() => remoteSessions.dropExpired(), 30_000);
    expirySweep.unref();
    stops.push(() => clearInterval(expirySweep));

    stops.push(
      startEndpointReporter({
        report: () =>
          refreshHostRegistration({
            baseDir: options.config.baseDir,
            ...(options.config.devUrl ? { devUrl: options.config.devUrl } : {}),
            client,
          }),
      }),
    );

    if (options.config.relayUrl) {
      const supervisor = new RelayDialSupervisor({
        relayUrl: options.config.relayUrl.toString(),
        hostId: credentials.hostId,
        requestTicket: async () =>
          (await client.requestRelayTicket(await hostProof(), credentials.hostId!)).ticket,
        reverifySessions: async (event) => {
          // Kill first with what the event already proves, THEN refresh.
          //
          // The frame is self-sufficient for the two kinds that matter most:
          // `device_revoked` carries the thumbprint in `event.subject`, and
          // `host_unlinked` drops everything unconditionally. Neither needs to
          // ask the cloud anything. Refreshing first made revocation fail OPEN
          // — an account-API 5xx threw before a single session was dropped, so
          // a revoked device kept its session precisely when the control plane
          // was unhealthy.
          if (event?.kind === "host_unlinked" || event?.kind === "device_revoked") {
            if (event.kind === "host_unlinked")
              await Effect.runPromise(
                options.remoteTrust.disable(trustScope, new Date().toISOString()),
              );
            else if (event.subject)
              await Effect.runPromise(
                options.remoteTrust.revoke(trustScope, event.subject, new Date().toISOString()),
              );
            await remoteSessions.reverify(authorization, event);
          }
          // Discoverability and org membership genuinely are cloud-governed, so
          // they still need the snapshot — but a failure here can no longer
          // suppress the kill above.
          const current = await refreshAuthorization();
          for (const jkt of current.revokedDeviceJkts)
            await Effect.runPromise(
              options.remoteTrust.revoke(trustScope, jkt, new Date().toISOString()),
            );
          await remoteSessions.reverify(current, event);
        },
        acceptSplice: async (socket, request) => {
          if (!(socket instanceof WebSocket))
            throw new Error("Remote TLS requires a native Node socket");
          tunnel.accept(socket, {
            via: "relay",
            expectedPeer: { userId: request.userId, deviceJkt: request.deviceJkt },
          });
        },
      });
      void supervisor.run(controller.signal);
    }

    if (!options.config.relayUrl) {
      // A linked host with no relay still accepts direct and ssh-forward
      // sessions, but has no control socket — so it never receives a revocation
      // signal, and every kind (discoverability-off, org departure, device
      // revoke, unlink) degrades silently to the credential TTL. That is a
      // misconfiguration, not a mode: say so where an operator will see it.
      console.warn(
        "[synara] This host is linked to an account but SYNARA_RELAY_URL is not set. " +
          "Remote sessions will still be accepted, but revocations cannot be delivered " +
          "and will only take effect when session credentials expire.",
      );
    }

    if (options.config.sshForwardPort !== undefined) {
      const server = http.createServer((_request, response) => {
        response.writeHead(426).end("WebSocket upgrade required");
      });
      const websocket = new WebSocketServer({
        server,
        maxPayload: MAX_WEBSOCKET_MESSAGE_BYTES,
        perMessageDeflate: false,
      });
      websocket.on("connection", (socket) => tunnel.accept(socket, { via: "ssh-forward" }));
      stops.push(() => {
        for (const socket of websocket.clients) socket.terminate();
        websocket.close();
        server.close();
      });
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => reject(error);
        server.once("error", onError);
        server.listen(options.config.sshForwardPort, "127.0.0.1", () => {
          server.off("error", onError);
          resolve();
        });
      });
    }
    return stop;
  } catch (error) {
    stop();
    throw error;
  }
}
