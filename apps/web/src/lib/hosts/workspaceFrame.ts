import type { ActiveHost } from "./activeHost";
import type { ThreadStatusPill } from "../../components/Sidebar.logic";
import type { Project, ThreadShell } from "../../types";
import type { WsTransportState } from "../../wsTransportEvents";

/** Only navigation metadata crosses this boundary; RPC clients and stores stay with their host. */
export interface WorkspaceSummary {
  readonly projects: readonly Pick<Project, "id" | "name" | "cwd">[];
  readonly threads: readonly (Pick<ThreadShell, "id" | "projectId" | "title" | "archivedAt"> & {
    readonly status: ThreadStatusPill | null;
  })[];
  readonly path: string;
  readonly state: WsTransportState;
}

export interface WorkspaceNavigation {
  navigate(path: string): void;
  newChat(projectId: string): Promise<void>;
  openProject(projectId: string): Promise<void>;
  recover(): void;
}

export interface WorkspaceFrameBinding {
  readonly host: ActiveHost;
  /** Captured in memory, never placed in the frame URL, DOM attributes, or persistence. */
  readonly controllerWsUrl: string;
  publish(summary: WorkspaceSummary): void;
  ready(navigation: WorkspaceNavigation | null): void;
  fail(message: string): void;
  close(): void;
}

export interface WorkspaceFrameElement extends HTMLIFrameElement {
  synaraWorkspace?: WorkspaceFrameBinding;
}

/** A frame is an execution instance, not a selectable global execution pointer. */
export function readWorkspaceFrame(): WorkspaceFrameBinding | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return (window.frameElement as WorkspaceFrameElement | null)?.synaraWorkspace;
  } catch {
    return undefined;
  }
}

export function isWorkspacePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\");
}

export function workspaceRoute(environmentId: string, path = "/"): string {
  if (!isWorkspacePath(path)) throw new Error("Invalid workspace route");
  return `/remote?${new URLSearchParams({ environment: environmentId, path })}`;
}
