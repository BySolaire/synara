import { useState, type CSSProperties } from "react";
import { useLocation } from "@tanstack/react-router";
import type { useSortable } from "@dnd-kit/sortable";
import type { SidebarThreadSortOrder } from "../../appSettings";
import { CentralIcon } from "../../lib/central-icons";
import { NewThreadIcon } from "../../lib/icons";
import { DEFAULT_PROJECT_ICON, projectColorValue } from "../../lib/projectAppearance";
import type { WorkspaceProjectEntry, WorkspaceThreadEntry } from "../../lib/hosts/workspaceSidebar";
import { readWorkspaceSessions } from "../../lib/hosts/workspaceSessions";
import { openWorkspacePath } from "./WorkspacePanels";
import {
  buildProjectThreadTree,
  getUnpinnedThreadsForSidebar,
  getVisibleSidebarEntriesForPreview,
  resolveProjectStatusIndicator,
  resolveSidebarThreadListPaging,
  sortThreadsForSidebar,
} from "../Sidebar.logic";
import { FolderClosed, FolderOpen } from "../FolderClosed";
import { ProjectEmojiGlyph } from "../ProjectSidebarIcon";
import { SidebarIconButton } from "../SidebarIconButton";
import { SidebarProjectRowContent } from "../SidebarProjectRowContent";
import { SidebarSectionToolbar } from "../SidebarSectionToolbar";
import { SidebarStatusTrailingGlyph } from "../SidebarStatusTrailingGlyph";
import { SidebarThreadRowContent } from "../SidebarThreadRowContent";
import {
  SidebarMenuButton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "../ui/sidebar";
import { toastManager } from "../ui/toast";
import {
  DISCLOSURE_INNER_CLASS,
  disclosureContentClassName,
  disclosureShellClassName,
} from "../../lib/disclosureMotion";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_THREAD_ROW_BASE_CLASS_NAME,
  sidebarHoverRevealHideClassName,
} from "../../sidebarRowStyles";
import { cn } from "../../lib/utils";

type SortableProjectHandleProps = Pick<
  ReturnType<typeof useSortable>,
  "attributes" | "listeners" | "setActivatorNodeRef"
>;

function WorkspaceProjectIcon({
  entry,
  expanded,
}: {
  entry: WorkspaceProjectEntry;
  expanded: boolean;
}) {
  const appearance = entry.project.appearance;
  if (appearance?.kind === "emoji")
    return <ProjectEmojiGlyph emoji={appearance.emoji} className="size-4" />;
  const style: CSSProperties | undefined = appearance?.color
    ? { color: projectColorValue(appearance.color) }
    : undefined;
  if (appearance?.kind === "icon" && appearance.icon !== DEFAULT_PROJECT_ICON)
    return <CentralIcon name={appearance.icon} className="size-4" style={style} />;
  const Folder = expanded ? FolderOpen : FolderClosed;
  return <Folder className="size-4" style={style} />;
}

function selectedThreadPath(href: string, environmentId: string, threadId: string): boolean {
  const [pathname, search = ""] = href.split("?");
  if (pathname !== "/remote") return false;
  const params = new URLSearchParams(search);
  return (
    params.get("environment") === environmentId &&
    params.get("path")?.split("?")[0] === `/${threadId}`
  );
}

export function WorkspaceThreadRow({
  entry,
  topLevel: topLevelProp,
  depth: depthProp,
}: {
  entry: WorkspaceThreadEntry;
  topLevel?: boolean;
  depth?: number | undefined;
}) {
  const topLevel = topLevelProp ?? false;
  const depth = depthProp ?? 0;
  const href = useLocation({ select: (location) => location.href });
  const { session, thread } = entry;
  if (!session) return null;
  const environmentId = session.host.executionScope.environmentId;
  const active = selectedThreadPath(href, environmentId, thread.id);
  const hostName = session.host.hostName;
  const status = thread.status;
  const content = (
    <SidebarThreadRowContent
      thread={thread}
      terminalEntryPoint={thread.terminalEntryPoint ?? false}
      terminalStatus={null}
      terminalCount={0}
      isActive={active}
      variant="standard"
      subagentIndentPx={Math.max(0, Math.min(depth - 1, 3) * 10)}
      relatedThreads={session.summary?.threads}
      pendingStatusColorClass={status?.label === "Pending Approval" ? status.colorClass : null}
      suffix={
        <>
          {topLevel ? (
            <span className="max-w-[40%] shrink-0 truncate text-ui-xs text-muted-foreground">
              {hostName}
            </span>
          ) : null}
          {status ? <SidebarStatusTrailingGlyph status={status} /> : null}
        </>
      }
    />
  );
  const label = `${thread.title}, ${hostName}${status ? `, ${status.label}` : ""}`;
  const open = () => openWorkspacePath(environmentId, `/${thread.id}`);
  return topLevel ? (
    <SidebarMenuButton
      size="sm"
      isActive={active}
      aria-label={label}
      className={cn(
        SIDEBAR_HEADER_ROW_CLASS_NAME,
        "gap-1.5",
        active ? SIDEBAR_ROW_ACTIVE_CLASS_NAME : SIDEBAR_ROW_HOVER_CLASS_NAME,
      )}
      onClick={open}
    >
      {content}
    </SidebarMenuButton>
  ) : (
    <SidebarMenuSubButton
      render={<button type="button" />}
      size="sm"
      isActive={active}
      aria-label={label}
      className={SIDEBAR_THREAD_ROW_BASE_CLASS_NAME}
      onClick={open}
    >
      {content}
    </SidebarMenuSubButton>
  );
}

export function WorkspaceProjectItem({
  entry,
  expanded,
  onToggle,
  threadSortOrder,
  dragHandleProps,
  manualSorting: manualSortingProp,
}: {
  entry: WorkspaceProjectEntry;
  expanded: boolean;
  onToggle: () => void;
  threadSortOrder: SidebarThreadSortOrder;
  dragHandleProps?: SortableProjectHandleProps | null;
  manualSorting?: boolean;
}) {
  const manualSorting = manualSortingProp ?? false;
  const [extraPages, setExtraPages] = useState(0);
  const href = useLocation({ select: (location) => location.href });
  const { project, session } = entry;
  if (!session) return null;
  const hostName = session.host.hostName;
  const environmentId = session.host.executionScope.environmentId;
  const online = session.summary?.state === "open" && Boolean(session.navigation);
  const status = expanded
    ? null
    : resolveProjectStatusIndicator(entry.threads.map((thread) => thread.status));
  const projectThreads = getUnpinnedThreadsForSidebar(
    entry.threads,
    entry.threads.filter((thread) => thread.isPinned).map((thread) => thread.id),
  );
  const activeThreadId = projectThreads.find((thread) =>
    selectedThreadPath(href, environmentId, thread.id),
  )?.id;
  const rows = buildProjectThreadTree({
    threads: sortThreadsForSidebar(projectThreads, threadSortOrder),
    forceVisibleThreadId: activeThreadId,
  });
  const paging = resolveSidebarThreadListPaging({
    totalCount: rows.length,
    baseLimit: 5,
    pageSize: 5,
    requestedExtraPages: extraPages,
  });
  const { visibleEntries } = getVisibleSidebarEntriesForPreview({
    entries: rows.map((row) => ({ rowId: row.thread.id, rootRowId: row.rootThreadId, row })),
    activeEntryId: activeThreadId,
    previewLimit: paging.previewLimit,
  });
  const canShowMore = paging.canShowMore && visibleEntries.length < rows.length;
  const startChat = () => {
    const navigation = session.navigation;
    if (!online || !navigation) return;
    void navigation
      .newChat(project.id)
      .then((path) => {
        // A disconnected or replaced host cannot route the result into another execution.
        if (
          readWorkspaceSessions().some(
            (current) => current.host === session.host && current.navigation === navigation,
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
  };

  return (
    <div className="group/collapsible">
      <div className="group/project-header relative">
        <SidebarMenuButton
          ref={manualSorting ? dragHandleProps?.setActivatorNodeRef : undefined}
          size="sm"
          className={cn(
            SIDEBAR_HEADER_ROW_CLASS_NAME,
            SIDEBAR_ROW_HOVER_CLASS_NAME,
            manualSorting ? "cursor-grab active:cursor-grabbing" : "cursor-pointer",
          )}
          {...(manualSorting && dragHandleProps ? dragHandleProps.attributes : {})}
          {...(manualSorting && dragHandleProps ? dragHandleProps.listeners : {})}
          aria-expanded={expanded}
          aria-label={`${project.name}, ${hostName}${status ? `, ${status.label}` : ""}`}
          title={`${project.cwd}\n${hostName}`}
          onClick={onToggle}
        >
          <SidebarProjectRowContent
            icon={<WorkspaceProjectIcon entry={entry} expanded={expanded} />}
            label={project.name}
            hostName={hostName}
            reserveClassName="group-hover/project-header:pr-7 group-has-[:focus-visible]/project-header:pr-7"
            trailing={
              status ? (
                <span
                  aria-label={`Project status: ${status.label}`}
                  title={status.label}
                  className={cn(
                    "ml-auto flex min-w-[1.625rem] shrink-0 items-center justify-end self-center",
                    sidebarHoverRevealHideClassName("project-header"),
                  )}
                >
                  <SidebarStatusTrailingGlyph status={status} />
                </span>
              ) : null
            }
          />
        </SidebarMenuButton>
        <SidebarSectionToolbar placement="overlay" revealOnHover>
          <SidebarIconButton
            icon={NewThreadIcon}
            label={`New chat in ${project.name} on ${hostName}`}
            disabled={!online}
            onClick={startChat}
          />
        </SidebarSectionToolbar>
      </div>
      <div
        className={cn(disclosureShellClassName(expanded), SIDEBAR_NESTED_LIST_OFFSET_CLASS_NAME)}
      >
        <div className={DISCLOSURE_INNER_CLASS}>
          <SidebarMenuSub
            className={cn("mx-0 border-0 px-0", disclosureContentClassName(expanded))}
          >
            {visibleEntries.map(({ row }) => (
              <SidebarMenuSubItem key={row.thread.id}>
                <WorkspaceThreadRow
                  entry={{ key: `${entry.key}:${row.thread.id}`, thread: row.thread, session }}
                  depth={row.depth}
                />
              </SidebarMenuSubItem>
            ))}
            {canShowMore || paging.canShowLess ? (
              <SidebarMenuSubItem className="w-full">
                <div className="flex w-full items-center gap-1">
                  {canShowMore ? (
                    <SidebarMenuSubButton
                      render={<button type="button" />}
                      size="sm"
                      className="h-7 flex-1 translate-x-0 justify-start rounded-lg pr-2 pl-8 text-left text-ui text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground"
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setExtraPages(paging.effectiveExtraPages + 1)}
                    >
                      <span>Show more</span>
                    </SidebarMenuSubButton>
                  ) : null}
                  {paging.canShowLess ? (
                    <SidebarMenuSubButton
                      render={<button type="button" />}
                      size="sm"
                      className={cn(
                        "h-7 translate-x-0 justify-start rounded-lg text-left text-ui text-muted-foreground/79 hover:bg-transparent hover:text-foreground active:bg-transparent active:text-foreground",
                        canShowMore ? "w-auto flex-none px-2" : "flex-1 pr-2 pl-8",
                      )}
                      onMouseDown={(event) => event.preventDefault()}
                      onClick={() => setExtraPages(Math.max(0, paging.effectiveExtraPages - 1))}
                    >
                      <span>Show less</span>
                    </SidebarMenuSubButton>
                  ) : null}
                </div>
              </SidebarMenuSubItem>
            ) : null}
          </SidebarMenuSub>
        </div>
      </div>
    </div>
  );
}
