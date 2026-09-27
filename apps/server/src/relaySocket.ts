import WebSocket from "ws";
import type { RelaySocket } from "./relayDial";

const MAX_PENDING_BYTES = 8 * 1024 * 1024;

/** RelaySocket has no async write acknowledgement; bound queues at native WS consumers. */
export function sendBoundedRelayFrame(socket: RelaySocket, data: string | Uint8Array): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
  if (socket instanceof WebSocket && socket.bufferedAmount + bytes > MAX_PENDING_BYTES) {
    socket.close(1009, "Remote consumer is too slow");
    const terminate = setTimeout(() => socket.terminate(), 1000);
    terminate.unref();
    socket.once("close", () => clearTimeout(terminate));
    return false;
  }
  socket.send(data);
  return true;
}
