import { resolveThreadStatusPill } from "../Sidebar.logic";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation } from "@tanstack/react-router";
import { ProjectId, ThreadId } from "@synara/contracts";
import { appHistory } from "../../appNavigation";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useStore } from "../../store";
import { useComposerDraftStore } from "../../composerDraftStore";
import { rawSocketUrl } from "../../wsTransport";
import { addWsTransportStateListener, type WsTransportState } from "../../wsTransportEvents";
import {
  isWorkspacePath,
  readWorkspaceFrame,
  workspaceRoute,
  type WorkspaceFrameElement,
} from "../../lib/hosts/workspaceFrame";
import {
  readWorkspaceSessions,
  removeWorkspaceSession,
  updateWorkspaceSession,
  useWorkspaceSessions,
  type WorkspaceSession,
} from "../../lib/hosts/workspaceSessions";
import { recoverBeforeLocalEscape } from "../../lib/hosts/executionSwitch";
import { Button } from "../ui/button";
import { ServerIcon } from "../../lib/icons";

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
}: {
  session: WorkspaceSession;
  active: boolean;
  path: string;
}) {
  const environmentId = session.host.executionScope.environmentId;
  const host = session.host;
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
    [environmentId, host],
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
      <div className="flex shrink-0 items-center gap-2 border-b px-3 py-1 text-ui-sm">
        <ServerIcon className="size-3.5" />
        <span className="min-w-0 flex-1 truncate">{host.hostName}</span>
        <span className="text-muted-foreground">
          {session.error
            ? "Unavailable"
            : session.summary?.state === "open"
              ? "Connected"
              : "Reconnecting…"}
        </span>
        <Button variant="ghost" size="sm" onClick={() => appHistory.push("/")}>
          Local chats
        </Button>
      </div>
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

/** Each connected execution owns a permanent realm: async callbacks cannot change destinations. */
export function WorkspacePanels() {
  const sessions = useWorkspaceSessions();
  const href = useLocation({ select: (location) => location.href });
  if (readWorkspaceFrame()) return null;
  const selected = selection(href);
  return sessions.map((session) => {
    const environmentId = session.host.executionScope.environmentId;
    return (
      <WorkspacePanel
        key={JSON.stringify([session.host.hostId, session.host.executionScope])}
        session={session}
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
  const path = useLocation({ select: (location) => location.href });
  const { handleNewThread: newChat } = useHandleNewThread();
  const newChatRef = useRef(newChat);
  newChatRef.current = newChat;
  const [state, setState] = useState<WsTransportState>("connecting");
  useEffect(() => addWsTransportStateListener(setState, { replayCurrent: true }), []);
  useEffect(() => {
    if (!frame || !hydrated) return;
    frame.ready({
      navigate: (next) => {
        if (isWorkspacePath(next) && next !== appHistory.location.href) appHistory.replace(next);
      },
      newChat: async (projectId) => {
        const id = await newChatRef.current(ProjectId.makeUnsafe(projectId));
        if (!id) throw new Error("The project is not ready to create a chat.");
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
        if (thread) appHistory.push(`/${thread.id}`);
        else if (!(await newChatRef.current(ProjectId.makeUnsafe(projectId))))
          throw new Error("This project is not ready.");
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
        id: thread.id,
        projectId: thread.projectId,
        title: thread.title,
        archivedAt: thread.archivedAt ?? null,
        status: resolveThreadStatusPill({
          thread,
          hasPendingApprovals: thread.hasPendingApprovals,
          hasPendingUserInput: thread.hasPendingUserInput,
        }),
      }));
    for (const [id, draft] of Object.entries(drafts)) {
      if (draft.promotedTo === undefined && !threads.some((thread) => thread.id === id))
        threads.push({
          id: ThreadId.makeUnsafe(id),
          projectId: draft.projectId,
          title: "New chat",
          archivedAt: null,
          status: null,
        });
    }
    frame.publish({
      projects: projects.map(({ id, name, cwd }) => ({ id, name, cwd })),
      threads,
      path,
      state,
    });
  }, [drafts, frame, hydrated, path, projects, shell, state]);
  return null;
}
