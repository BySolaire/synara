// FILE: useActivityThreads.ts
// Purpose: The thread lists the sidebar's Activity view, its unread bell, and the Inbox
//          read, so every surface agrees on which threads count.
// Layer: Web hook over the normalized store
// Exports: useActivityThreads

import { useMemo } from "react";

import { partitionSidebarThreadsByProjectIds } from "../components/Sidebar.logic";
import { collectStudioProjectIds } from "../lib/studioProjects";
import { useStore, type AppState } from "../store";
import { createSidebarThreadSummariesSelector, isSidebarThreadVisible } from "../storeSelectors";
import type { SidebarThreadSummary } from "../types";
import { useWorkspacePathsStore } from "../workspacePathsStore";

interface ActivityThreads {
  readonly sidebarThreads: readonly SidebarThreadSummary[];
  readonly studioProjectIdSet: ReturnType<typeof collectStudioProjectIds>;
  readonly nonStudioThreads: readonly SidebarThreadSummary[];
  readonly studioThreads: readonly SidebarThreadSummary[];
  /** Activity, its unread bell, and the Inbox read this list, so a badge can never point
   *  at a row the lists are hiding. */
  readonly visibleNonStudioThreads: readonly SidebarThreadSummary[];
}

type ActivityThreadInputs = readonly [
  sidebarThreads: readonly SidebarThreadSummary[],
  projects: AppState["projects"],
  homeDir: string | null,
  chatWorkspaceRoot: string | null,
  studioWorkspaceRoot: string | null,
  hideAutomationRunThreads: boolean,
];

// Shared by every caller, so the sidebar and the Inbox (mounted together) read one set of
// lists: the selector returns the same array for both, and the derivation below runs once
// per change instead of once per caller.
const selectSidebarThreads = createSidebarThreadSummariesSelector();
let lastDerived: {
  readonly inputs: ActivityThreadInputs;
  readonly result: ActivityThreads;
} | null = null;

function deriveActivityThreads(inputs: ActivityThreadInputs): ActivityThreads {
  if (lastDerived && inputs.every((input, index) => input === lastDerived?.inputs[index])) {
    return lastDerived.result;
  }
  const [
    sidebarThreads,
    projects,
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
    hideAutomationRunThreads,
  ] = inputs;
  const studioProjectIdSet = collectStudioProjectIds(projects, {
    homeDir,
    chatWorkspaceRoot,
    studioWorkspaceRoot,
  });
  const { nonStudioThreads, studioThreads } = partitionSidebarThreadsByProjectIds(
    sidebarThreads,
    studioProjectIdSet,
  );
  const result: ActivityThreads = {
    sidebarThreads,
    studioProjectIdSet,
    nonStudioThreads,
    studioThreads,
    visibleNonStudioThreads: nonStudioThreads.filter((thread) =>
      isSidebarThreadVisible(thread, { hideAutomationRunThreads }),
    ),
  };
  lastDerived = { inputs, result };
  return result;
}

/** Callers pass the automation-run visibility setting they already read. */
export function useActivityThreads({
  hideAutomationRunThreads,
}: {
  readonly hideAutomationRunThreads: boolean;
}): ActivityThreads {
  const projects = useStore((store) => store.projects);
  const homeDir = useWorkspacePathsStore((store) => store.homeDir);
  const chatWorkspaceRoot = useWorkspacePathsStore((store) => store.chatWorkspaceRoot);
  const studioWorkspaceRoot = useWorkspacePathsStore((store) => store.studioWorkspaceRoot);
  const sidebarThreads = useStore(selectSidebarThreads);
  return useMemo(
    () =>
      deriveActivityThreads([
        sidebarThreads,
        projects,
        homeDir,
        chatWorkspaceRoot,
        studioWorkspaceRoot,
        hideAutomationRunThreads,
      ]),
    [
      chatWorkspaceRoot,
      hideAutomationRunThreads,
      homeDir,
      projects,
      sidebarThreads,
      studioWorkspaceRoot,
    ],
  );
}
