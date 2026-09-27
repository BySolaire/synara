import http from "node:http";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import WebSocket, { type RawData } from "ws";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBoundedNodeHttpServer } from "../nodeHttpServer";
import { sendBoundedRelayFrame } from "../relaySocket";
import {
  initializeRemoteTlsIdentity,
  loadRemoteTlsIdentity,
  remoteTlsAnchor,
  type RemoteTlsIdentity,
} from "../remoteTransport/certificates";
import { connectRemoteWebSocket, RemoteTlsServer } from "../remoteTransport/tunnel";
import {
  hostRemoteWebSocketRouteLayer,
  HOST_REMOTE_WS_PATH,
  registerHostRemoteSocketAcceptor,
} from "./httpRoute";

describe("remote TLS at the real Effect/Node HTTP boundary", () => {
  let directory: string;
  let identity: RemoteTlsIdentity;
  beforeAll(async () => {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "synara-tls-"));
    identity = await initializeRemoteTlsIdentity(
      path.join(directory, "identity.json"),
      "test-environment",
    );
  });
  afterAll(async () => {
    await fs.rm(directory, { recursive: true, force: true });
  });

  async function fixture(
    run: (url: string, tunnel: RemoteTlsServer, captured: Buffer[]) => Promise<void>,
    serverIdentity = identity,
  ) {
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const captured: Buffer[] = [];
    const tunnel = new RemoteTlsServer({
      identity: serverIdentity,
      handshakeTimeoutMs: 150,
      accept: async (inner) => {
        inner.on("message", (data, binary) => inner.send(data, { binary }));
        await Promise.resolve();
      },
    });
    const unregister = registerHostRemoteSocketAcceptor((outer) => {
      outer.on("message", (raw) => captured.push(Buffer.from(raw as Buffer)));
      tunnel.accept(outer);
    });
    try {
      const port = await Effect.runPromise(
        Scope.provide(
          Effect.gen(function* () {
            const server = yield* makeBoundedNodeHttpServer(() => http.createServer(), {
              host: "127.0.0.1",
              port: 0,
            });
            const app = yield* HttpRouter.toHttpEffect(hostRemoteWebSocketRouteLayer);
            yield* server.serve(app);
            if (server.address._tag !== "TcpAddress") throw new Error("Expected TCP");
            return server.address.port;
          }).pipe(Effect.provide(NodeServices.layer)),
          scope,
        ),
      );
      await run(`ws://127.0.0.1:${port}${HOST_REMOTE_WS_PATH}`, tunnel, captured);
    } finally {
      unregister();
      tunnel.close();
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  }

  async function outer(url: string) {
    const socket = new WebSocket(url, { perMessageDeflate: false, maxPayload: 2 * 1024 * 1024 });
    socket.on("error", () => socket.terminate());
    await once(socket, "open");
    return socket;
  }

  async function echo(socket: WebSocket, data: string | Buffer, binary: boolean) {
    const received = once(socket, "message");
    socket.send(data, { binary });
    const [value, isBinary] = (await received) as [RawData, boolean];
    expect(isBinary).toBe(binary);
    expect(Buffer.from(value as Buffer)).toEqual(Buffer.from(data));
  }

  it("preserves the first text frame and binary boundaries without exposing plaintext to the outer socket", async () => {
    await fixture(async (url, tunnel, captured) => {
      const socket = await connectRemoteWebSocket(await outer(url), remoteTlsAnchor(identity));
      const marker = `private-coding-payload-${randomBytes(32).toString("hex")}`;
      await echo(socket, marker, false);
      await echo(socket, randomBytes(512 * 1024), true);
      expect(Buffer.concat(captured).includes(Buffer.from(marker))).toBe(false);
      expect(socket.extensions).toBe("");
      const closed = once(socket, "close");
      tunnel.close();
      await closed;
      expect(tunnel.connectionCount).toBe(0);
    });
  });

  it.each(["untrusted-root", "wrong-hostname"])(
    "refuses %s before application data",
    async (kind) => {
      const other = await initializeRemoteTlsIdentity(
        path.join(directory, `${kind}.json`),
        "another-environment",
      );
      await fixture(async (url) => {
        const anchor =
          kind === "untrusted-root"
            ? remoteTlsAnchor(other)
            : { ...remoteTlsAnchor(identity), environmentId: "wrong-environment" };
        await expect(connectRemoteWebSocket(await outer(url), anchor)).rejects.toThrow();
      });
    },
  );

  it("closes silent and plaintext outer peers, and never exposes the old route", async () => {
    await fixture(async (url) => {
      for (const plaintext of [false, true]) {
        const socket = await outer(url);
        const closed = once(socket, "close");
        if (plaintext) socket.send('{"v":1,"type":"session_authorize"}');
        await closed;
      }
      const legacy = new WebSocket(url.replace("/v2", ""));
      const result = await new Promise<number>((resolve) => {
        legacy.on("error", () => {});
        legacy.on("unexpected-response", (_request, response) => {
          resolve(response.statusCode!);
          response.resume();
          legacy.terminate();
        });
      });
      expect(result).toBe(404);
    });
  });

  it("carries split TLS records through the production Bun relay and rejects altered ciphertext", async () => {
    const child = fork(
      fileURLToPath(new URL("../../../relay/src/test/tlsRelayProcess.mjs", import.meta.url)),
      [],
      {
        execPath: "bun",
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let diagnostic = "";
    child.stderr?.on("data", (chunk) => {
      diagnostic += chunk.toString();
    });
    const ready = await new Promise<{ origin: string; ticket: string; runtime: string }>(
      (resolve, reject) => {
        child.once("message", (message) =>
          resolve(message as { origin: string; ticket: string; runtime: string }),
        );
        child.once("error", reject);
        child.once("exit", (code) => reject(new Error(`Relay exited ${code}: ${diagnostic}`)));
      },
    );
    const sockets: WebSocket[] = [];
    const ingress: unknown[] = [];
    const tunnel = new RemoteTlsServer({
      identity,
      accept: (socket, _path, context) => {
        ingress.push(context);
        socket.on("message", (data, binary) => socket.send(data, { binary }));
      },
    });
    let requestId = 0;
    function command(input: Record<string, unknown>) {
      const id = ++requestId;
      return new Promise<Record<string, unknown>>((resolve) => {
        const listener = (message: unknown) => {
          const response = message as Record<string, unknown>;
          if (response.id === id) {
            child.off("message", listener);
            resolve(response);
          }
        };
        child.on("message", listener);
        child.send({ ...input, id });
      });
    }
    try {
      expect(ready.runtime).toMatch(/^Bun /);
      const control = await outer(
        `${ready.origin}/host/control?ticket=${encodeURIComponent(ready.ticket)}`,
      );
      sockets.push(control);
      control.on("message", (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === "ping") control.send(JSON.stringify({ v: 1, type: "pong" }));
        if (frame.type === "splice_request") {
          const host = new WebSocket(
            `${ready.origin}/host/data?splice=${encodeURIComponent(frame.spliceId)}`,
          );
          sockets.push(host);
          host.on("error", () => host.terminate());
          host.once("open", () =>
            tunnel.accept(host, {
              via: "relay",
              expectedPeer: { userId: frame.userId, deviceJkt: frame.deviceJkt },
            }),
          );
        }
      });
      control.send(JSON.stringify({ v: 1, type: "ready" }));
      const grant = await command({ type: "grant" });
      await command({ type: "mode", mode: "split" });
      const client = await outer(
        `${ready.origin}/client/session?grant=${encodeURIComponent(String(grant.grant))}`,
      );
      sockets.push(client);
      const inner = await connectRemoteWebSocket(client, remoteTlsAnchor(identity));
      sockets.push(inner);
      const marker = `relay-must-not-read-${randomBytes(32).toString("hex")}`;
      await echo(inner, marker, false);
      await echo(inner, randomBytes(512 * 1024), true);
      const stats = await command({ type: "stats", marker });
      expect(stats.plaintextFound).toBe(false);
      expect(stats.binaryOnly).toBe(true);
      expect(Number(stats.capturedBytes)).toBeGreaterThan(1024 * 1024);
      expect(ingress).toEqual([
        expect.objectContaining({
          via: "relay",
          expectedPeer: { userId: expect.any(String), deviceJkt: expect.any(String) },
        }),
      ]);
      await command({ type: "mode", mode: "coalesce" });
      const messages: string[] = [];
      const all = new Promise<void>((resolve) => {
        const collect = (data: RawData) => {
          messages.push(data.toString());
          if (messages.length === 8) {
            inner.off("message", collect);
            resolve();
          }
        };
        inner.on("message", collect);
      });
      for (let i = 0; i < 8; i++) {
        inner.send(`record-${i}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 1));
      }
      await all;
      expect(messages).toEqual(Array.from({ length: 8 }, (_, i) => `record-${i}`));
      expect(Number((await command({ type: "stats", marker })).coalescedFrames)).toBeGreaterThan(1);
      await command({ type: "mode", mode: "tamper" });
      const closed = once(inner, "close");
      let acceptedTamperedPayload = false;
      inner.on("message", () => {
        acceptedTamperedPayload = true;
      });
      inner.send("must-not-be-accepted");
      await closed;
      expect(acceptedTamperedPayload).toBe(false);
    } finally {
      for (const socket of sockets) socket.terminate();
      tunnel.close();
      child.kill("SIGTERM");
      await once(child, "exit");
    }
  }, 15_000);

  it("rejects an expired leaf and bounds writes to a paused native consumer", async () => {
    const expired = await initializeRemoteTlsIdentity(
      path.join(directory, "expired.json"),
      "test-environment",
      Date.now() - 120 * 86_400_000,
    );
    await fixture(async (url) => {
      await expect(
        connectRemoteWebSocket(await outer(url), remoteTlsAnchor(expired)),
      ).rejects.toThrow(/expir/i);
    }, expired);
    await fixture(async (url) => {
      const transport = await outer(url);
      const socket = await connectRemoteWebSocket(transport, remoteTlsAnchor(identity));
      socket.pause();
      const payload = randomBytes(1024 * 1024);
      let refused = false;
      for (let index = 0; index < 32; index++) {
        if (!sendBoundedRelayFrame(socket, payload)) {
          refused = true;
          break;
        }
      }
      expect(refused).toBe(true);
      expect(socket.bufferedAmount).toBeLessThanOrEqual(8 * 1024 * 1024);
      const closed = once(socket, "close");
      socket.resume();
      await closed;
    });
  });

  it("renews the leaf under the same root and refuses corrupt persisted keys", async () => {
    const target = path.join(directory, "renewal.json");
    const start = Date.now() - 61 * 86_400_000;
    const original = await initializeRemoteTlsIdentity(target, "test-environment", start);
    const renewed = await loadRemoteTlsIdentity(target, "test-environment");
    expect(renewed.rootCertificate).toBe(original.rootCertificate);
    expect(renewed.leafCertificate).not.toBe(original.leafCertificate);
    await fixture(async (url, tunnel) => {
      const socket = await connectRemoteWebSocket(await outer(url), remoteTlsAnchor(original));
      tunnel.renew(renewed);
      await echo(socket, "existing-connection-survives-renewal", false);
      const next = await connectRemoteWebSocket(await outer(url), remoteTlsAnchor(original));
      await echo(next, "old-root-accepts-new-leaf", false);
      expect(() => tunnel.renew(identity)).toThrow("Root replacement");
      socket.terminate();
      next.terminate();
    }, original);
    await fs.writeFile(target, "corrupt");
    await expect(initializeRemoteTlsIdentity(target, "test-environment")).rejects.toThrow();
    expect(await fs.readFile(target, "utf8")).toBe("corrupt");
  });
});
