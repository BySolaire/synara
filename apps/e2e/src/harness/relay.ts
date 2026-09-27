import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { RelayConfig } from "../../../relay/src/config";

export async function startBunRelay(
  config: RelayConfig,
): Promise<{ origin: string; close(): Promise<void> }> {
  const child = fork(fileURLToPath(new URL("./relayProcess.mjs", import.meta.url)), [], {
    execPath: "bun",
    execArgv: [],
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  });
  let closed = false;
  const exited = new Promise<void>((resolve) =>
    child.once("exit", () => {
      closed = true;
      resolve();
    }),
  );
  const close = async () => {
    if (closed) return;
    const kill = setTimeout(() => child.kill("SIGKILL"), 2000);
    if (child.connected) child.send({ type: "stop" });
    else child.kill("SIGTERM");
    await exited;
    clearTimeout(kill);
  };
  try {
    const origin = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Bun relay startup timed out")), 10000);
      const fail = () => {
        clearTimeout(timer);
        reject(new Error("Bun relay exited before ready"));
      };
      child.once("exit", fail);
      child.once("error", fail);
      child.once("message", (message: { origin?: string; runtime?: string }) => {
        clearTimeout(timer);
        child.off("exit", fail);
        child.off("error", fail);
        if (!message.origin || !message.runtime?.startsWith("Bun "))
          reject(new Error("Invalid relay runtime"));
        else resolve(message.origin);
      });
      child.send(config);
    });
    return { origin, close };
  } catch (error) {
    await close();
    throw error;
  }
}
