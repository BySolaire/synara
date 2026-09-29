import { resolveThreadStatusPill, runExclusiveProjectAddition } from "../Sidebar.logic";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useMemo,
  useSyncExternalStore,
  useLayoutEffect,
} from "react";
import { useLocation } from "@tanstack/react-router";
import { ProjectId, ThreadId } from "@synara/contracts";
import { appHistory } from "../../appNavigation";
import { useHandleNewChat } from "../../hooks/useHandleNewChat";
import { useAppSettings } from "../../appSettings";
import { ensureNativeApi } from "../../nativeApi";
import { createOrRecoverProjectFromPath } from "../../lib/projectCreation";
import { readExecutionContext } from "../../lib/hosts/executionContext";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useStore } from "../../store";
import { useComposerDraftStore } from "../../composerDraftStore";
import { rawSocketUrl } from "../../wsTransport";
import { addWsTransportStateListener, type WsTransportState } from "../../wsTransportEvents";
import {
  OPEN_CREATE_PROJECT_EVENT,
  isWorkspacePath,
  readWorkspaceFrame,
  workspaceRoute,
  type WorkspaceFrameElement,
} from "../../lib/hosts/workspaceFrame";
import {
  readWorkspaceSessions,
  subscribeWorkspaceSessions,
  removeWorkspaceSession,
  updateWorkspaceSession,
  useWorkspaceSessions,
  type WorkspaceSession,
} from "../../lib/hosts/workspaceSessions";
import { recoverBeforeLocalEscape } from "../../lib/hosts/executionSwitch";
import { isHomeChatContainerProject } from "../../lib/chatProjects";
import { isStudioContainerProject } from "../../lib/studioProjects";
import { useWorkspacePathsStore } from "../../workspacePathsStore";
import { useTerminalStateStore } from "../../terminalStateStore";
import { useSidebar } from "../ui/sidebar";

function selection(
  href = appHistory.location.href,
): { environmentId: string; path: string } | null {
  const [pathname, search = ""] = href.split("?");
  if (pathname !== "/remote") return null;
  const params = new URLSearchParams(search);
  const environmentId = params.get("environment");
  const path = params.get("path") ?? "/";
  return environmentId && isWorkspacePath(path) ? { environmentId, path } : null;
}

export function openWorkspacePath(environmentId: string, path: string): void {
  appHistory.push(workspaceRoute(environmentId, path));
}

function WorkspacePanel({
  session,
  active,
  path,
  newLocalChat,
}: {
  session: WorkspaceSession;
  active: boolean;
  path: string;
  newLocalChat: () => Promise<string>;
}) {
  const environmentId = session.host.executionScope.environmentId;
  const host = session.host;
  const sidebar = useSidebar();
  const sidebarRef = useRef(sidebar);
  const sidebarListeners = useRef(new Set<() => void>());
  const sidebarBridge = useMemo(
    () => ({
      read: () => sidebarRef.current,
      subscribe: (listener: () => void) => {
        sidebarListeners.current.add(listener);
        return () => {
          sidebarListeners.current.delete(listener);
        };
      },
    }),
    [],
  );
  useLayoutEffect(() => {
    sidebarRef.current = sidebar;
    for (const listener of sidebarListeners.current) listener();
  }, [sidebar]);
  const frameRef = useRef<WorkspaceFrameElement | null>(null);
  const bind = useCallback(
    (frame: WorkspaceFrameElement | null) => {
      const previous = frameRef.current;
      if (previous) delete previous.synaraWorkspace;
      frameRef.current = frame;
      if (!frame) return;
      // Same-origin application code only. No repository HTML is ever loaded in this frame.
      frame.synaraWorkspace = {
        host,
        controller: {
          environment: readExecutionContext()!.controller,
          sidebar: sidebarBridge,
          sessions: readWorkspaceSessions,
          subscribe: subscribeWorkspaceSessions,
          newChat: newLocalChat,
          createProject: () => window.dispatchEvent(new Event(OPEN_CREATE_PROJECT_EVENT)),
          navigate: (path) => {
            if (isWorkspacePath(path)) appHistory.push(path);
          },
        },
        controllerWsUrl: rawSocketUrl(null),
        publish: (summary) => {
          if (frameRef.current !== frame) return;
          const previousPath = readWorkspaceSessions().find((entry) => entry.host === host)?.summary
            ?.path;
          updateWorkspaceSession(environmentId, { summary });
          const current = selection();
          if (
            previousPath &&
            previousPath !== summary.path &&
            current?.environmentId === environmentId &&
            current.path !== summary.path
          )
            appHistory.push(workspaceRoute(environmentId, summary.path));
        },
        ready: (navigation) => {
          if (frameRef.current !== frame) return;
          updateWorkspaceSession(environmentId, {
            navigation: navigation ?? undefined,
            error: undefined,
          });
          const current = selection();
          if (navigation && current?.environmentId === environmentId)
            navigation.navigate(current.path);
        },
        fail: (error) => {
          if (frameRef.current === frame)
            updateWorkspaceSession(environmentId, { error, navigation: undefined });
        },
        close: () => {
          removeWorkspaceSession(host.hostId);
          if (selection()?.environmentId === environmentId) appHistory.push("/");
        },
      };
      const url = new URL(window.location.href);
      url.search = "";
      url.hash = "";
      if (url.protocol === "http:" || url.protocol === "https:") url.pathname = "/";
      frame.src = url.toString();
    },
    [environmentId, host, newLocalChat, sidebarBridge],
  );

  const navigate = session.navigation?.navigate;
  useEffect(() => {
    if (active) navigate?.(path);
  }, [active, path, navigate]);

  return (
    <section
      hidden={!active}
      className={active ? "absolute inset-0 z-10 flex min-h-0 flex-col bg-background" : "hidden"}
      aria-label={`Workspace on ${host.hostName}`}
    >
      <iframe
        ref={bind}
        title={`Synara workspace on ${host.hostName}`}
        className="min-h-0 w-full flex-1 border-0"
        allow="clipboard-read; clipboard-write"
        // The bundled app needs its own storage and scripts. This isolates state, not security principals.
        // eslint-disable-next-line react/iframe-missing-sandbox
        sandbox="allow-same-origin allow-scripts allow-forms allow-modals allow-downloads allow-popups allow-popups-to-escape-sandbox"
      />
    </section>
  );
}

const subscribeWithoutFrame = () => () => {};
const readWithoutFrame = () => null;

/** Only shell controls cross this bridge; execution state remains owned by the frame. */
export function useWorkspaceSidebarControls() {
  const sidebar = readWorkspaceFrame()?.controller.sidebar;
  return useSyncExternalStore(
    sidebar?.subscribe ?? subscribeWithoutFrame,
    sidebar?.read ?? readWithoutFrame,
    readWithoutFrame,
  );
}

/** Each connected execution owns a permanent realm: async callbacks cannot change destinations. */
export function WorkspacePanels() {
  const sessions = useWorkspaceSessions();
  const { handleNewChat } = useHandleNewChat();
  const localChatRef = useRef(handleNewChat);
  localChatRef.current = handleNewChat;
  const newLocalChat = useCallback(async () => {
    const result = await localChatRef.current();
    if (!result.ok) throw new Error(result.error);
    if (!result.threadId) throw new Error("The local computer is not ready.");
    return `/${result.threadId}`;
  }, []);
  const href = useLocation({ select: (location) => location.href });
  if (readWorkspaceFrame()) return null;
  const selected = selection(href);
  return sessions.map((session) => {
    const environmentId = session.host.executionScope.environmentId;
    return (
      <WorkspacePanel
        key={JSON.stringify([session.host.hostId, session.host.executionScope])}
        session={session}
        newLocalChat={newLocalChat}
        active={selected?.environmentId === environmentId}
        path={selected?.environmentId === environmentId ? selected.path : "/"}
      />
    );
  });
}

/** Runs inside the host's own router, stores, query client, event router, and transport. */
export function WorkspaceFrameNavigation() {
  const frame = readWorkspaceFrame();
  const projects = useStore((state) => state.projects);
  const shell = useStore((state) => state.sidebarThreadSummaryById);
  const hydrated = useStore((state) => state.threadsHydrated);
  const drafts = useComposerDraftStore((state) => state.draftThreadsByThreadId);
  const paths = useWorkspacePathsStore();
  const terminalStates = useTerminalStateStore((state) => state.terminalStateByThreadId);
  const path = useLocation({ select: (location) => location.href });
  const { handleNewThread: newChat } = useHandleNewThread();
  const { handleNewChat } = useHandleNewChat();
  const { settings } = useAppSettings();
  const homeChatRef = useRef(handleNewChat);
  homeChatRef.current = handleNewChat;
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;
  const projectAdditionLockRef = useRef(false);
  const [state, setState] = useState<WsTransportState>("connecting");
  useEffect(() => addWsTransportStateListener(setState, { replayCurrent: true }), []);
  useEffect(() => {
    if (!frame || !hydrated) return;
    frame.ready({
      navigate: (next) => {
        if (isWorkspacePath(next) && next !== appHistory.location.href) appHistory.replace(next);
      },
      browseFolders: (input) => ensureNativeApi().filesystem.browse(input),
      createProject: (input) =>
        runExclusiveProjectAddition(projectAdditionLockRef, async () => {
          const api = ensureNativeApi();
          const result = await createOrRecoverProjectFromPath({
            api,
            ...input,
            spaceId: null,
            defaultProvider: settingsRef.current.defaultProvider,
            loadSnapshot: () => api.orchestration.getShellSnapshot(),
          });
          if (result.snapshot) useStore.getState().syncServerShellSnapshot(result.snapshot);
          if (!result.project)
            throw new Error(
              "The project was added, but is still syncing. Reopen it from the sidebar.",
            );
          const id = await newChatRef.current(result.projectId);
          if (!id)
            throw new Error(
              "The project was added, but its chat could not be opened. Reopen it from the sidebar.",
            );
          return `/${id}`;
        }),
      newChat: async (projectId) => {
        if (!projectId) {
          const result = await homeChatRef.current();
          if (!result.ok) throw new Error(result.error);
          if (!result.threadId) throw new Error("This computer is not ready to create a chat.");
          return `/${result.threadId}`;
        }
        const id = await newChatRef.current(ProjectId.makeUnsafe(projectId));
        if (!id) throw new Error("The project is not ready to create a chat.");
        return `/${id}`;
      },
      openProject: async (projectId) => {
        const store = useStore.getState();
        if (!store.projects.some((project) => project.id === projectId))
          throw new Error("This checkout is no longer available on this computer.");
        const thread = Object.values(store.sidebarThreadSummaryById)
          .filter((item) => item.projectId === projectId && !item.archivedAt)
          .toSorted((a, b) =>
            (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt),
          )[0];
        if (thread) return `/${thread.id}`;
        const id = await newChatRef.current(ProjectId.makeUnsafe(projectId));
        if (!id) throw new Error("This project is not ready.");
        return `/${id}`;
      },
      recover: recoverBeforeLocalEscape,
    });
    return () => frame.ready(null);
  }, [frame, hydrated]);
  useEffect(() => {
    if (!frame || !hydrated) return;
    const threads = Object.values(shell ?? {})
      .filter((thread) => !thread.archivedAt)
      .map((thread) => ({
        ...thread,
        terminalEntryPoint: terminalStates[thread.id]?.entryPoint === "terminal",
        status: resolveThreadStatusPill({
          thread,
          hasPendingApprovals: thread.hasPendingApprovals,
          hasPendingUserInput: thread.hasPendingUserInput,
        }),
      }));
    const threadPath = path.split("?")[0]?.slice(1);
    const threadId = threadPath ? ThreadId.makeUnsafe(threadPath) : undefined;
    const activeProjectId = threadId
      ? (shell[threadId]?.projectId ?? drafts[threadId]?.projectId)
      : undefined;
    frame.publish({
      projects: projects.map((project) => ({
        id: project.id,
        kind: project.kind,
        name: project.name,
        cwd: project.cwd,
        ...(project.appearance !== undefined ? { appearance: project.appearance } : {}),
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        ...(project.isPinned !== undefined ? { isPinned: project.isPinned } : {}),
        section: isHomeChatContainerProject(project, paths)
          ? "chats"
          : isStudioContainerProject(project, paths)
            ? "studio"
            : "projects",
      })),
      ...(activeProjectId ? { activeProjectId } : {}),
      threads,
      path,
      state,
    });
  }, [drafts, frame, hydrated, path, paths, projects, shell, state, terminalStates]);
  return null;
}
