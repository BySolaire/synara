import { executionKey } from "./executionContext";
import { flushBeforeExecutionSwitch, recoverBeforeLocalEscape } from "./executionSwitch";
// Window selection contains only controller-verified identity metadata.
import type { RemoteExecutionScope } from "@synara/contracts";

const ACTIVE_HOST_STORAGE_KEY = "synara:active-host:v1";

export interface ActiveHost {
  readonly executionScope?: RemoteExecutionScope;
  readonly hostId: string;
  readonly hostName: string;
  /** The shell's local upgrade path for this host's bridged session. */
  readonly wsPath: string;
}

function storage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function readActiveHost(): ActiveHost | null {
  const raw = storage()?.getItem(ACTIVE_HOST_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ActiveHost>;
    if (
      typeof parsed.hostId === "string" &&
      typeof parsed.hostName === "string" &&
      typeof parsed.wsPath === "string" &&
      parsed.wsPath.startsWith("/")
    ) {
      return {
        hostId: parsed.hostId,
        hostName: parsed.hostName,
        wsPath: parsed.wsPath,
        ...(parsed.executionScope ? { executionScope: parsed.executionScope } : {}),
      };
    }
  } catch {
    // Fall through: a corrupt value is the same as none.
  }
  storage()?.removeItem(ACTIVE_HOST_STORAGE_KEY);
  return null;
}

/** Persists the choice for this window and reloads onto the bridged socket. */
export async function activateHost(host: ActiveHost): Promise<void> {
  await flushBeforeExecutionSwitch();
  prepareReload();
  storage()?.setItem(ACTIVE_HOST_STORAGE_KEY, JSON.stringify(host));
  window.location.reload();
}

/** Back to the local shell. */
export function deactivateHost(): void {
  recoverBeforeLocalEscape();
  prepareReload();
  storage()?.removeItem(ACTIVE_HOST_STORAGE_KEY);
  window.location.reload();
}

/**
 * The path prefix the transport puts in front of `/ws`, `/ws/negotiate` and
 * `/ws/bootstrap` while a host is active. The shell mounts those paths under
 * the host's bridge path; its own auth (the desktop bridge `?token=`, or
 * loopback trust) is unchanged because the bridge applies the same admission
 * as the local `/ws`. Null when this window is on the local shell.
 */
export function readActiveHostSocketPrefix(): string | null {
  const active = readActiveHost();
  return active ? active.wsPath.replace(/\/+$/, "") : null;
}

function prepareReload(): void {
  const location = window.location;
  const hashRouting = location.protocol !== "http:" && location.protocol !== "https:";
  const route = hashRouting ? location.hash.slice(1) || "/" : location.pathname + location.search;
  storage()?.setItem(executionKey("last-route:v1"), route);
  window.history.replaceState(
    {},
    "",
    hashRouting ? `${location.pathname}${location.search}#/` : "/",
  );
}
