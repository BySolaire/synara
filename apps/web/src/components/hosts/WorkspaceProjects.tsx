import { ThreadStatusPillChip } from "../ThreadStatusPillChip";
import { useState } from "react";
import { useLocation } from "@tanstack/react-router";
import {
  readWorkspaceSessions,
  useWorkspaceSessions,
  type WorkspaceSession,
} from "../../lib/hosts/workspaceSessions";
import { checkoutKey } from "../../lib/projectCatalog/model";
import { openWorkspacePath } from "./WorkspacePanels";
import {
  SidebarGroup,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
} from "../ui/sidebar";
import { SidebarIconButton } from "../SidebarIconButton";
import { SidebarSectionToolbar } from "../SidebarSectionToolbar";
import { DisclosureChevron } from "../ui/DisclosureChevron";
import { AddPlusIcon, FolderIcon, ServerIcon } from "../../lib/icons";
import {
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "../../lib/disclosureMotion";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_PROJECT_NAME_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
} from "../../sidebarRowStyles";
import { cn } from "../../lib/utils";
import { toastManager } from "../ui/toast";

function WorkspaceProjectGroup({ session }: { session: WorkspaceSession }) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const location = useLocation();
  const environmentId = session.host.executionScope.environmentId;
  const params = new URLSearchParams(location.searchStr);
  const selectedPath =
    location.pathname === "/remote" && params.get("environment") === environmentId
      ? params.get("path")
      : null;
  const online = session.summary?.state === "open" && Boolean(session.navigation);
  return (
    <SidebarGroup className="px-1.5 pt-2 pb-1" aria-label={`Projects on ${session.host.hostName}`}>
      <SidebarMenuButton
        aria-label={`${session.host.hostName}. ${online ? "Connected" : "Connecting"}`}
        size="sm"
        className="text-ui-sm text-muted-foreground"
        onClick={() => openWorkspacePath(environmentId, session.summary?.path ?? "/")}
      >
        <ServerIcon className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{session.host.hostName}</span>
        <span
          role="status"
          title={session.error ?? (online ? "Connected" : "Connection unavailable")}
          className={cn(
            "size-2 shrink-0 rounded-full",
            online ? "bg-emerald-500" : "bg-muted-foreground",
          )}
        />
      </SidebarMenuButton>
      {!session.summary ? (
        <p className="px-2 py-1 text-ui-sm text-muted-foreground">
          {session.error ?? "Loading projects…"}
        </p>
      ) : null}
      <SidebarMenu className="gap-2">
        {session.summary?.projects.map((project) => {
          const key = checkoutKey({ environmentId, projectId: project.id });
          const expanded = !collapsed.has(key);
          const threads = session.summary!.threads.filter(
            (thread) => thread.projectId === project.id && !thread.archivedAt,
          );
          return (
            <SidebarMenuItem key={key}>
              <div className="group/project-header relative">
                <SidebarMenuButton
                  size="sm"
                  className={cn(SIDEBAR_HEADER_ROW_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME)}
                  aria-expanded={expanded}
                  title={`${project.cwd}\n${session.host.hostName}`}
                  onClick={() =>
                    setCollapsed((previous) => {
                      const next = new Set(previous);
                      if (expanded) next.add(key);
                      else next.delete(key);
                      return next;
                    })
                  }
                >
                  <FolderIcon className="size-4 shrink-0" />
                  <span className={SIDEBAR_PROJECT_NAME_CLASS_NAME}>{project.name}</span>
                  <DisclosureChevron open={expanded} />
                </SidebarMenuButton>
                <SidebarSectionToolbar placement="overlay" revealOnHover>
                  <SidebarIconButton
                    icon={AddPlusIcon}
                    label={`New chat in ${project.name} on ${session.host.hostName}`}
                    disabled={!online}
                    onClick={() => {
                      const navigation = session.navigation;
                      // Create in the owning host first; activating its old route can cancel creation.
                      void navigation
                        ?.newChat(project.id)
                        .then((path) => {
                          if (
                            readWorkspaceSessions().some(
                              (entry) =>
                                entry.host === session.host && entry.navigation === navigation,
                            )
                          )
                            openWorkspacePath(environmentId, path);
                        })
                        .catch((error: unknown) =>
                          toastManager.add({
                            type: "error",
                            title: "Could not create chat",
                            description: error instanceof Error ? error.message : "Try again.",
                          }),
                        );
                    }}
                  />
                </SidebarSectionToolbar>
              </div>
              <div className={disclosureShellClassName(expanded)}>
                <div className={DISCLOSURE_INNER_CLASS}>
                  <SidebarMenuSub
                    className={cn("mx-0 border-0 px-0", disclosureContentClassName(expanded))}
                  >
                    {threads.map((thread) => (
                      <SidebarMenuItem key={thread.id}>
                        <SidebarMenuSubButton
                          className={SIDEBAR_THREAD_ROW_BASE_CLASS_NAME}
                          isActive={selectedPath?.split("?")[0] === `/${thread.id}`}
                          onClick={() => openWorkspacePath(environmentId, `/${thread.id}`)}
                        >
                          <span className="min-w-0 flex-1 truncate">{thread.title}</span>
                          {thread.status ? (
                            <ThreadStatusPillChip
                              pill={thread.status}
                              className="max-w-24 shrink-0"
                            />
                          ) : null}
                        </SidebarMenuSubButton>
                      </SidebarMenuItem>
                    ))}
                    {!threads.length ? (
                      <span className="px-8 py-1 text-ui-sm text-muted-foreground">
                        No chats yet
                      </span>
                    ) : null}
                  </SidebarMenuSub>
                </div>
              </div>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

export function WorkspaceProjects() {
  return useWorkspaceSessions().map((session) => (
    <WorkspaceProjectGroup key={session.host.executionScope.environmentId} session={session} />
  ));
}
