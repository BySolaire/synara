import { afterEach, expect, it, vi } from "vitest";
import { HostConnectionRegistry } from "./registry";
import { superviseHostConnections } from "./supervisor";
import { RemoteHostTrustError } from "./failure";
import type { HostConnectionsPort } from "./port";

afterEach(() => vi.useRealTimers());

it("bounds restoration to two dials and never resumes after stop during pending work", async () => {
  vi.useFakeTimers();
  const registry = new HostConnectionRegistry();
  const pending: Array<() => void> = [];
  const connect = vi.fn(
    () =>
      new Promise<never>((_resolve, reject) => pending.push(() => reject(new Error("offline")))),
  );
  const port: HostConnectionsPort = {
    connect,
    disconnect: async () => {},
    list: async () => ({
      connections: [],
      desiredHosts: ["a", "b", "c"].map((hostId) => ({
        hostId,
        environmentId: hostId,
        label: hostId,
      })),
    }),
  };
  const stop = superviseHostConnections(port, registry);
  await vi.advanceTimersByTimeAsync(0);
  expect(connect).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(5000);
  expect(connect).toHaveBeenCalledTimes(2);
  stop();
  pending.forEach((fail) => fail());
  await vi.advanceTimersByTimeAsync(60000);
  expect(connect).toHaveBeenCalledTimes(2);
  expect(registry.list()).toEqual([]);
});

it("does not retry a missing trust relationship until intent changes", async () => {
  vi.useFakeTimers();
  const registry = new HostConnectionRegistry();
  let desired = true;
  const connect = vi.fn(async () => {
    throw new RemoteHostTrustError("Pair on the host again");
  });
  const port: HostConnectionsPort = {
    connect,
    disconnect: async () => {},
    list: async () => ({
      connections: [],
      desiredHosts: desired ? [{ hostId: "mini", environmentId: "mini", label: "Mini" }] : [],
    }),
  };
  const stop = superviseHostConnections(port, registry);
  try {
    await vi.advanceTimersByTimeAsync(60000);
    expect(connect).toHaveBeenCalledTimes(1);
    desired = false;
    await vi.advanceTimersByTimeAsync(1000);
    desired = true;
    await vi.advanceTimersByTimeAsync(1000);
    expect(connect).toHaveBeenCalledTimes(2);
  } finally {
    stop();
  }
});
