// Production relay application in its supported Bun runtime, against the isolated API.
import { serve } from "@hono/node-server";
import { createRelayApp } from "../../../relay/src/app.ts";
let close;
process.once("message", async (config) => {
  const relay = await createRelayApp(config, {
    pendingTimeoutMs: 2000,
    keepaliveIntervalMs: 250,
    revocationPollIntervalMs: 25,
    revocationInitialBackoffMs: 10,
    revocationMaxBackoffMs: 100,
    stallTimeoutMs: 15000,
    backpressurePollMs: 5,
    logger: { error() {}, warn() {} },
  });
  const server = serve({ fetch: relay.app.fetch, port: 0, hostname: "127.0.0.1" });
  server.on("upgrade", relay.handleUpgrade);
  close = () => {
    relay.close();
    server.close(() => process.exit(0));
  };
  await new Promise((resolve) =>
    server.listening ? resolve() : server.once("listening", resolve),
  );
  process.send({
    origin: `http://127.0.0.1:${server.address().port}`,
    runtime: `Bun ${Bun.version}`,
  });
  process.once("message", () => close());
});
process.on("disconnect", () => {
  close?.();
  process.exit(0);
});
