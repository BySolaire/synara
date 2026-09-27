import { RelayToHostControlMessage, type SpliceRequest } from "@synara/relay-protocol";
import { Schema } from "effect";
import WebSocket, { type RawData } from "ws";

export interface RelaySocket {
  readonly readyState: number;
  send(data: string | Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: "open", listener: () => void): this;
  on(event: "message", listener: (data: RawData, binary: boolean) => void): this;
  on(event: "close", listener: (code: number, reason: Buffer) => void): this;
  on(event: "error", listener: (error: Error) => void): this;
  off(event: "open", listener: () => void): this;
  off(event: "message", listener: (data: RawData, binary: boolean) => void): this;
  off(event: "close", listener: (code: number, reason: Buffer) => void): this;
  off(event: "error", listener: (error: Error) => void): this;
  removeAllListeners(event?: "open" | "message" | "close" | "error"): this;
}

export type RelaySocketFactory = (url: string) => RelaySocket;

export interface RelayDialSupervisorOptions {
  readonly relayUrl: string;
  readonly hostId: string;
  readonly requestTicket: () => Promise<string>;
  readonly reverifySessions: (event?: {
    readonly kind: "discoverability_off" | "org_departure" | "device_revoked" | "host_unlinked";
    readonly subject: string | null;
  }) => Promise<void>;
  readonly acceptSplice: (socket: RelaySocket, request: SpliceRequest) => Promise<void>;
  readonly socketFactory?: RelaySocketFactory;
  readonly sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  readonly random?: () => number;
  readonly nowMs?: () => number;
  /** Observability hook: session reverification failed but the socket lives. */
  readonly onReverifyFailed?: (error: unknown) => void;
  readonly baseBackoffMs?: number;
  readonly maximumBackoffMs?: number;
}

function websocketBase(relayUrl: string): URL {
  const url = new URL(relayUrl);
  if (url.protocol === "https:") url.protocol = "wss:";
  else if (url.protocol === "http:") url.protocol = "ws:";
  if (url.protocol !== "ws:" && url.protocol !== "wss:") {
    throw new Error(`Unsupported relay protocol ${url.protocol}`);
  }
  return url;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("aborted"));
    };
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function openSocket(
  socket: RelaySocket,
  signal: AbortSignal,
  onOpen?: () => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      socket.off("open", opened);
      socket.off("close", closed);
    };
    const finish = (error?: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve();
    };
    const fail = (error: unknown) => finish(error);
    // Closing a CONNECTING native ws emits an error on a later tick. Keep its
    // observer through close, including after an abort or opening timeout.
    const releaseErrorObserver = () => {
      socket.off("error", fail);
      socket.off("close", releaseErrorObserver);
    };
    const abort = () => {
      finish(signal.reason ?? new Error("aborted"));
      socket.close();
    };
    const closed = () => finish(new Error("socket closed while opening"));
    const opened = () => {
      try {
        Promise.resolve(onOpen?.()).then(() => finish(), fail);
      } catch (error) {
        fail(error);
      }
    };
    const timer = setTimeout(() => {
      finish(new Error("relay opening timed out"));
      socket.close();
    }, 15_000);
    socket.on("open", opened);
    socket.on("close", closed);
    socket.on("error", fail);
    socket.on("close", releaseErrorObserver);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

function socketLifetime(socket: RelaySocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      socket.off("close", finish);
      socket.off("error", finish);
      resolve();
    };
    const abort = () => {
      finish();
      socket.close();
    };
    socket.on("close", finish);
    socket.on("error", finish);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    else if (socket.readyState >= 2) finish();
  });
}

export class RelayDialSupervisor {
  readonly #socketFactory: RelaySocketFactory;
  readonly #sleep: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  /** True once a control socket opened, so backoff resets only on real health. */
  #connected = false;
  /** Aborts splice dials in flight when their control socket goes away. */
  #spliceDials = new AbortController();

  constructor(readonly options: RelayDialSupervisorOptions) {
    this.#socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
    this.#sleep = options.sleep ?? defaultSleep;
  }

  private controlUrl(ticket: string): string {
    const url = websocketBase(this.options.relayUrl);
    url.pathname = "/host/control";
    url.search = new URLSearchParams({ ticket }).toString();
    return url.toString();
  }

  private dataUrl(spliceId: string): string {
    const url = websocketBase(this.options.relayUrl);
    url.pathname = "/host/data";
    url.search = new URLSearchParams({ splice: spliceId }).toString();
    return url.toString();
  }

  private async connectOnce(signal: AbortSignal): Promise<void> {
    // Bound even a ticket provider which never settles. Observe abort before
    // invoking it; a late answer cannot create a control socket after stop.
    const ticket = await new Promise<string>((resolve, reject) => {
      const finish = (error?: unknown, value?: string) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        if (error) reject(error);
        else resolve(value!);
      };
      const abort = () => finish(signal.reason ?? new Error("aborted"));
      const timer = setTimeout(() => finish(new Error("relay ticket timed out")), 15_000);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      Promise.resolve()
        .then(() => this.options.requestTicket())
        .then((value) => finish(undefined, value), finish);
    });
    if (signal.aborted) return;
    const control = this.#socketFactory(this.controlUrl(ticket));
    // Close/abort observation precedes opening and every authorization await.
    let ended = false;
    const lifetime = socketLifetime(control, signal).then(() => {
      ended = true;
    });
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    control.on("message", (raw) => {
      void this.handleControlMessage(control, raw).catch(() =>
        control.close(1002, "invalid control message"),
      );
    });
    try {
      await openSocket(control, signal);
      if (ended || signal.aborted) return;
      await Promise.race([
        this.options.reverifySessions().catch((error) => this.options.onReverifyFailed?.(error)),
        lifetime,
        new Promise<void>((resolve) => {
          refreshTimer = setTimeout(resolve, 15_000);
        }),
      ]);
      if (ended || signal.aborted || control.readyState !== 1) return;
      this.#connected = true;
      control.send(JSON.stringify({ v: 1, type: "ready" }));
      await lifetime;
    } finally {
      clearTimeout(refreshTimer);
      control.removeAllListeners("message");
      control.close();
      this.#spliceDials.abort();
      this.#spliceDials = new AbortController();
    }
  }

  private async handleControlMessage(control: RelaySocket, raw: RawData): Promise<void> {
    const message = Schema.decodeUnknownSync(RelayToHostControlMessage)(JSON.parse(raw.toString()));
    if (message.type === "ping") {
      control.send(JSON.stringify({ v: 1, type: "pong" }));
      return;
    }
    if (message.type === "revocation") {
      for (const event of message.events) {
        if (event.hostId !== this.options.hostId) continue;
        try {
          await this.options.reverifySessions({ kind: event.kind, subject: event.subject });
        } catch (error) {
          // The frame was valid; only the cloud refresh behind reverification
          // failed. Keep the splice-signalling socket alive and report the
          // transient failure instead of misclassifying it as protocol error.
          this.options.onReverifyFailed?.(error);
        }
      }
      return;
    }
    if ((this.options.nowMs?.() ?? Date.now()) >= message.expiresAtMs) return;
    const dials = this.#spliceDials;
    const data = this.#socketFactory(this.dataUrl(message.spliceId));
    try {
      await openSocket(data, dials.signal, () => {
        // `ws` can deliver the first data frame immediately after its `open`
        // listeners return. Admit synchronously from that event so the
        // gateway's message listener exists before the peer can speak.
        if (dials.signal.aborted) {
          data.close(1001, "control socket closed during splice dial");
          return;
        }
        return this.options.acceptSplice(data, message);
      });
    } catch {
      data.close(1001, "splice dial aborted");
      // A cancelled client or refused data upgrade is local to this splice.
      // Closing control here would disconnect every established host session.
      return;
    }
    // The control socket may have died while the data socket was opening.
    // Accepting now would create a remote session nothing is supervising.
    if (dials.signal.aborted) {
      data.close(1001, "control socket closed during splice dial");
      return;
    }
  }

  async run(signal: AbortSignal): Promise<void> {
    let failures = 0;
    while (!signal.aborted) {
      this.#connected = false;
      try {
        await this.connectOnce(signal);
      } catch {
        // fall through to backoff
      }
      // A connection that came up healthy clears the backoff. Counting it as
      // a failure (as before) meant the cap only ever ratcheted upward, so a
      // long-lived host turned a single blip into a multi-second outage.
      failures = this.#connected ? 0 : failures + 1;
      if (signal.aborted) break;
      const cap = Math.min(
        this.options.maximumBackoffMs ?? 30_000,
        (this.options.baseBackoffMs ?? 500) * 2 ** Math.min(failures, 16),
      );
      const delay = Math.floor((this.options.random?.() ?? Math.random()) * cap);
      try {
        await this.#sleep(delay, signal);
      } catch {
        break;
      }
    }
  }
}
