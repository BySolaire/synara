// FILE: useSidebarWorkingFocus.ts
// Purpose: Preserve sidebar keyboard focus when a thread moves into or out of Working.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import type { ThreadId } from "@synara/contracts";

export function useSidebarWorkingFocus(
  panelRef: RefObject<HTMLDivElement | null>,
  workingThreadIds: ReadonlySet<ThreadId>,
  expanded: boolean,
) {
  const focusedRow = useRef<{ id: ThreadId; element: HTMLElement } | null>(null);
  const previous = useRef({ workingThreadIds, expanded });
  useEffect(() => {
    const rememberFocus = (event: FocusEvent) => {
      const element = event.target;
      const row =
        element instanceof HTMLElement && panelRef.current?.contains(element)
          ? element.closest<HTMLElement>("[data-sidebar-thread-id]")
          : null;
      focusedRow.current =
        row && element instanceof HTMLElement
          ? { id: row.dataset.sidebarThreadId as ThreadId, element }
          : null;
    };
    document.addEventListener("focusin", rememberFocus);
    return () => document.removeEventListener("focusin", rememberFocus);
  }, [panelRef]);

  useLayoutEffect(() => {
    const before = previous.current;
    previous.current = { workingThreadIds, expanded };
    const focused = focusedRow.current;
    const panel = panelRef.current;
    if (!focused || !panel) return;
    const wasWorking = before.workingThreadIds.has(focused.id);
    const isWorking = workingThreadIds.has(focused.id);
    if (wasWorking === isWorking && !(isWorking && before.expanded && !expanded)) return;
    // The composer or another control may have received focus during this update.
    if (document.activeElement !== document.body && document.activeElement !== focused.element)
      return;
    const header = panel.querySelector<HTMLElement>(
      "[data-sidebar-working-section] button[aria-expanded]",
    );
    if (isWorking && !expanded) {
      header?.focus({ preventScroll: true });
      return;
    }
    const row = [...panel.querySelectorAll<HTMLElement>("[data-sidebar-thread-id]")].find(
      (candidate) =>
        candidate.dataset.sidebarThreadId === focused.id &&
        !candidate.closest("[inert]") &&
        candidate.getClientRects().length > 0,
    );
    const target = row?.matches("button, [role=button]")
      ? row
      : row?.querySelector<HTMLElement>("button, [role=button]");
    if (target) target.focus({ preventScroll: true });
    else if (header) header.focus({ preventScroll: true });
    else
      panel
        .querySelector<HTMLElement>("[data-sidebar-working-host]")
        ?.focus({ preventScroll: true });
  });
}
