import { EventEmitter } from "node:events";
import http from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";

import { describe, expect, it, vi } from "vitest";

import type { RelaySocket } from "./supervisor";
import { RelayDialSupervisor } from "./supervisor";

class FakeSocket extends EventEmitter implements RelaySocket {
  readyState = 1;
  readonly sent: string[] = [];
  readonly closes: Array<{ code: number; reason: string }> = [];
  send(data: string | Uint8Array): void {
    this.sent.push(data.toString());
  }
  close(code = 1000, reason = ""): void {
    this.readyState = 3;
    this.closes.push({ code, reason });
    this.emit("close", code, Buffer.from(reason));
  }
  open(): void {
    this.emit("open");
  }
  message(value: unknown): void {
    this.emit("message", Buffer.from(JSON.stringify(value)));
  }
  fail(error: Error): void {
    this.emit("error", error);
  }
}

describe("RelayDialSupervisor", () => {
  it("stops a native CONNECTING socket without an unhandled deferred error", async () => {
    const server = http.createServer();
    const sockets = new Set<Socket>();
    server.on("connection", (socket) => sockets.add(socket));
    let upgraded!: () => void;
    const upgrade = new Promise<void>((resolve) => {
      upgraded = resolve;
    });
    server.on("upgrade", (_request, socket) => {
      socket.resume();
      upgraded();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing relay listener");
    const controller = new AbortController();
    let dialing: WebSocket | undefined;
    const supervisor = new RelayDialSupervisor({
      relayUrl: `http://127.0.0.1:${address.port}`,
      hostId: "fixture-host",
      requestTicket: async () => "ticket",
      reverifySessions: async () => {},
      acceptSplice: async () => {},
      socketFactory: (url) => (dialing = new WebSocket(url)),
    });
    const running = supervisor.run(controller.signal);
    try {
      await upgrade;
      controller.abort();
      await running;
      // ws emits the CONNECTING cancellation error on the next tick. Vitest
      // reports an unhandled error if supervision detached its observer early.
      await delay(20);
      expect(dialing?.readyState).toBe(WebSocket.CLOSED);
    } finally {
      controller.abort();
      await running;
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("keeps native control usable after a refused splice upgrade", async () => {
    const server = http.createServer();
    const websocket = new WebSocketServer({ noServer: true });
    const messages: Array<{ type: string }> = [];
    let control: WebSocket | undefined;
    let refused = false;
    server.on("upgrade", (request, socket, head) => {
      if (request.url?.startsWith("/host/control")) {
        websocket.handleUpgrade(request, socket, head, (peer) => {
          control = peer;
          peer.on("message", (data) => messages.push(JSON.parse(data.toString())));
        });
      } else {
        refused = true;
        socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Missing relay listener");
    const controller = new AbortController();
    const acceptSplice = vi.fn(async () => {});
    const supervisor = new RelayDialSupervisor({
      relayUrl: `http://127.0.0.1:${address.port}`,
      hostId: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
      requestTicket: async () => "ticket",
      reverifySessions: async () => {},
      acceptSplice,
    });
    const running = supervisor.run(controller.signal);
    try {
      await vi.waitFor(() => expect(messages).toContainEqual({ v: 1, type: "ready" }));
      const originalControl = control!;
      originalControl.send(
        JSON.stringify({
          v: 1,
          type: "splice_request",
          spliceId: "a".repeat(43),
          hostId: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
          userId: "member",
          deviceJkt: "device-jkt",
          expiresAtMs: Date.now() + 30_000,
        }),
      );
      await vi.waitFor(() => expect(refused).toBe(true));
      originalControl.send(JSON.stringify({ v: 1, type: "ping" }));
      await vi.waitFor(() => expect(messages).toContainEqual({ v: 1, type: "pong" }));
      expect(originalControl.readyState).toBe(WebSocket.OPEN);
      expect(acceptSplice).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      await running;
      for (const peer of websocket.clients) peer.terminate();
      websocket.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("stops while the account ticket request is unresolved and ignores its late answer", async () => {
    let answer!: (ticket: string) => void;
    const requestTicket = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          answer = resolve;
        }),
    );
    const socketFactory = vi.fn(() => new FakeSocket());
    const controller = new AbortController();
    const supervisor = new RelayDialSupervisor({
      relayUrl: "https://relay.example.test",
      hostId: "fixture-host",
      requestTicket,
      socketFactory,
      acceptSplice: async () => {},
      reverifySessions: async () => {},
    });
    const running = supervisor.run(controller.signal);
    await vi.waitFor(() => expect(requestTicket).toHaveBeenCalledOnce());
    controller.abort();
    await running;
    answer("late-ticket");
    await Promise.resolve();
    expect(socketFactory).not.toHaveBeenCalled();
  });

  it("keeps a valid revocation control socket open when reverification is unavailable", async () => {
    const hostId = "2f1f9dd7-56a5-45cf-b847-12e6658f3720";
    const sockets: FakeSocket[] = [];
    const controller = new AbortController();
    const failure = new Error("account API returned 503");
    let reverifyCalls = 0;
    const onReverifyFailed = vi.fn();
    const supervisor = new RelayDialSupervisor({
      relayUrl: "https://relay.example.test",
      hostId,
      requestTicket: async () => "ticket",
      reverifySessions: async () => {
        reverifyCalls += 1;
        if (reverifyCalls > 1) throw failure;
      },
      acceptSplice: vi.fn(async () => {}),
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
      sleep: async () => controller.abort(),
      onReverifyFailed,
    });
    const running = supervisor.run(controller.signal);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    const control = sockets[0];
    if (!control) throw new Error("control socket was not created");

    control.message({
      v: 1,
      type: "revocation",
      events: [
        {
          id: 1,
          hostId,
          kind: "org_departure",
          subject: "departed-user",
          createdAt: new Date().toISOString(),
        },
      ],
    });
    await vi.waitFor(() => expect(reverifyCalls).toBe(2));
    await vi.waitFor(() =>
      expect(control.closes.length + onReverifyFailed.mock.calls.length).toBeGreaterThan(0),
    );

    expect(control.closes).toEqual([]);
    expect(onReverifyFailed).toHaveBeenCalledWith(failure);
    controller.abort();
    control.close();
    await running;
  });

  it("admits a splice before the first frame can follow its open event", async () => {
    const sockets: FakeSocket[] = [];
    const received: string[] = [];
    const controller = new AbortController();
    const supervisor = new RelayDialSupervisor({
      relayUrl: "https://relay.example.test/base",
      hostId: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
      requestTicket: async () => "ticket",
      reverifySessions: async () => {},
      acceptSplice: async (socket) => {
        socket.on("message", (message) => received.push(message.toString()));
      },
      socketFactory: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        if (sockets.length === 1) queueMicrotask(() => socket.open());
        else {
          queueMicrotask(() => {
            socket.open();
            socket.emit("message", Buffer.from("first-frame"), false);
          });
        }
        return socket;
      },
      sleep: async () => controller.abort(),
    });
    const running = supervisor.run(controller.signal);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    sockets[0]?.message({
      v: 1,
      type: "splice_request",
      spliceId: "a".repeat(43),
      hostId: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
      userId: "member",
      deviceJkt: "device-jkt",
      expiresAtMs: Date.now() + 30_000,
    });

    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await vi.waitFor(() => expect(received).toEqual(["first-frame"]));
    controller.abort();
    sockets[0]?.close();
    await running;
  });

  it("reconnects with capped jitter, reverifies, and handles control traffic", async () => {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const sleeps: number[] = [];
    const controller = new AbortController();
    const reverify = vi.fn(async () => {});
    const supervisor = new RelayDialSupervisor({
      relayUrl: "https://relay.example.test/base",
      hostId: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
      requestTicket: async () => "ticket",
      reverifySessions: reverify,
      acceptSplice: vi.fn(async () => {}),
      socketFactory: (url) => {
        urls.push(url);
        const socket = new FakeSocket();
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        if (sleeps.length === 2) controller.abort();
      },
      random: () => 0.5,
      baseBackoffMs: 100,
      maximumBackoffMs: 250,
    });

    const running = supervisor.run(controller.signal);
    await vi.waitFor(() => expect(sockets).toHaveLength(1));
    expect(sockets[0]?.sent).toEqual([JSON.stringify({ v: 1, type: "ready" })]);
    sockets[0]?.message({ v: 1, type: "ping" });
    expect(sockets[0]?.sent).toContain(JSON.stringify({ v: 1, type: "pong" }));
    sockets[0]?.close(1006);
    await vi.waitFor(() => expect(sockets.length).toBeGreaterThan(1));
    sockets[1]?.close(1006);
    await running;

    expect(urls[0]).toContain("/host/control?ticket=ticket");
    expect(reverify).toHaveBeenCalledTimes(2);
    // Both sockets opened successfully before dropping, so each reconnect
    // starts from the base delay. Escalation is reserved for connections that
    // never came up; otherwise a host stable for days would still carry a
    // saturated cap and turn one blip into a multi-second outage.
    expect(sleeps).toEqual([50, 50]);
  });

  it("escalates backoff only while connections keep failing, then resets on health", async () => {
    const sleeps: number[] = [];
    const controller = new AbortController();
    let openNext = false;
    const supervisor = new RelayDialSupervisor({
      relayUrl: "https://relay.example.test/base",
      hostId: "2f1f9dd7-56a5-45cf-b847-12e6658f3720",
      requestTicket: async () => "ticket",
      reverifySessions: vi.fn(async () => {}),
      acceptSplice: vi.fn(async () => {}),
      socketFactory: () => {
        const socket = new FakeSocket();
        // First two dials never open (connect failures); the third opens and
        // then drops. The drop is deferred past the supervisor's await chain
        // so its lifetime listener is attached before close fires.
        if (openNext) {
          queueMicrotask(() => socket.open());
          setTimeout(() => socket.close(1006), 5);
        } else {
          queueMicrotask(() => socket.fail(new Error("refused")));
        }
        return socket;
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        if (sleeps.length === 2) openNext = true;
        if (sleeps.length === 3) controller.abort();
      },
      random: () => 1,
      baseBackoffMs: 100,
      maximumBackoffMs: 10_000,
    });

    await supervisor.run(controller.signal);
    // 100*2^1 then 100*2^2 while failing; a healthy connection resets the
    // counter, so the next wait is the un-escalated 100*2^0.
    expect(sleeps).toEqual([200, 400, 100]);
  });
});
