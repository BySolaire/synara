// Runs the production relay application under Bun; the account authority is an isolated fixture.
import { serve } from "@hono/node-server";
import { createRelayApp } from "../app.ts";
import { FakeApi } from "./fakeApi.ts";
const api = await FakeApi.start();
const hostId = "10000000-0000-4000-8000-000000000001";
const environmentId = "test-environment";
const relay = await createRelayApp({
  port: 0,
  apiBaseUrl: api.origin,
  apiIssuer: api.issuer,
  relayServiceToken: api.serviceToken,
  maxPairs: 8,
  highWaterBytes: 65536,
});
let mode = "normal";
let captured = [];
let capturedBytes = 0;
let binaryOnly = true;
let coalescedFrames = 0;
function observe(socket) {
  const send = socket.send.bind(socket);
  let pending = [];
  let timer;
  const flush = () => {
    clearTimeout(timer);
    timer = undefined;
    const chunks = pending;
    pending = [];
    if (chunks.length > 1) coalescedFrames += chunks.length;
    if (chunks.length) send(Buffer.concat(chunks), true);
  };
  socket.send = (data, binary) => {
    binaryOnly &&= binary;
    if (capturedBytes < 4 * 1024 * 1024) captured.push(Buffer.from(data));
    capturedBytes += data.length;
    if (mode === "tamper") {
      mode = "normal";
      const altered = Buffer.from(data);
      altered[altered.length - 1] ^= 1;
      send(altered, binary);
    } else if (mode === "split") {
      for (let index = 0; index < data.length; index += 137)
        send(data.subarray(index, index + 137), binary);
    } else if (mode === "coalesce") {
      pending.push(Buffer.from(data));
      if (pending.reduce((size, chunk) => size + chunk.length, 0) >= 65536) flush();
      else timer ??= setTimeout(flush, 10);
    } else send(data, binary);
  };
  return socket;
}
const admitClient = relay.core.admitClient.bind(relay.core);
relay.core.admitClient = (socket, grant) => admitClient(observe(socket), grant);
const admitHostData = relay.core.admitHostData.bind(relay.core);
relay.core.admitHostData = (socket, splice) => admitHostData(observe(socket), splice);
const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
server.on("upgrade", relay.handleUpgrade);
await new Promise((resolve) => (server.listening ? resolve() : server.once("listening", resolve)));
process.on("message", async (message) => {
  if (message.type === "grant")
    process.send({ id: message.id, grant: await api.signGrant({ hostId, environmentId }) });
  if (message.type === "mode") {
    mode = message.mode;
    process.send({ id: message.id });
  }
  if (message.type === "stats")
    process.send({
      id: message.id,
      capturedBytes,
      binaryOnly,
      coalescedFrames,
      plaintextFound: Buffer.concat(captured).includes(Buffer.from(message.marker)),
      pairs: relay.core.pairCount,
    });
  if (message.type === "stop") {
    relay.close();
    server.close();
    await api.close();
    process.exit(0);
  }
});
process.on("disconnect", () => process.exit(0));
process.send({
  type: "ready",
  origin: `ws://127.0.0.1:${server.address().port}`,
  ticket: await api.signTicket({ hostId, environmentId }),
  runtime: `Bun ${Bun.version}`,
});
