import type {
  ExecutionEnvironmentDescriptor,
  FilesystemBrowseInput,
  FilesystemBrowseResult,
} from "@synara/contracts";
import type { WorkspaceSession } from "./workspaceSessions";
import type { ActiveHost } from "./activeHost";
import type { ThreadStatusPill } from "../../components/Sidebar.logic";
import type { Project, SidebarThreadSummary } from "../../types";
import type { SidebarContextProps } from "../../components/ui/sidebar";
import type { WsTransportState } from "../../wsTransportEvents";

/** Only navigation metadata crosses this boundary; RPC clients and stores stay with their host. */
export interface WorkspaceSummary {
  readonly projects: readonly (Pick<
    Project,
    "id" | "kind" | "name" | "cwd" | "appearance" | "createdAt" | "updatedAt" | "isPinned"
  > & { readonly section: "projects" | "chats" | "studio" })[];
  readonly threads: readonly (SidebarThreadSummary & {
    readonly status: ThreadStatusPill | null;
    readonly terminalEntryPoint?: boolean;
  })[];
  readonly path: string;
  readonly activeProjectId?: string;
  readonly state: WsTransportState;
}

export interface WorkspaceNavigation {
  navigate(path: string): void;
  newChat(projectId?: string): Promise<string>;
  browseFolders(input: FilesystemBrowseInput): Promise<FilesystemBrowseResult>;
  createProject(input: {
    name: string;
    workspaceRoot: string;
    createIfMissing: boolean;
  }): Promise<string>;
  openProject(projectId: string): Promise<string>;
  recover(): void;
}

export interface WorkspaceFrameBinding {
  readonly host: ActiveHost;
  readonly controller: {
    readonly environment: ExecutionEnvironmentDescriptor;
    readonly sidebar: {
      read(): SidebarContextProps;
      subscribe(listener: () => void): () => void;
    };
    sessions(): readonly WorkspaceSession[];
    subscribe(listener: () => void): () => void;
    newChat(): Promise<string>;
    createProject(): void;
    navigate(path: string): void;
  };
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

export const OPEN_CREATE_PROJECT_EVENT = "synara:open-create-project";
export function requestCreateProjectDialog(): void {
  const frame = readWorkspaceFrame();
  if (frame) frame.controller.createProject();
  else window.dispatchEvent(new Event(OPEN_CREATE_PROJECT_EVENT));
}
