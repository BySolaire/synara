// FILE: useSidebarWorkingRelocation.ts
// Purpose: Settle Working membership and fold rows in place when they move to or from Working.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type { ThreadId } from "@synara/contracts";

import { DISCLOSURE_CLEANUP_BUFFER_MS, DISCLOSURE_TRANSITION_MS } from "../lib/disclosureMotion";
import { useMediaQuery } from "./useMediaQuery";

/**
 * A new turn reports `running` before its latest turn replaces the settled one, and
 * a session can briefly connect without starting work. Membership only follows a
 * status that holds, so one start or finish moves a row once instead of bouncing it.
 */
export const SIDEBAR_WORKING_ENTER_DELAY_MS = 400;
export const SIDEBAR_WORKING_LEAVE_DELAY_MS = 800;
// A hydration or reconnect burst swaps rows instantly instead of folding the whole list.
const MAX_ANIMATED_RELOCATIONS = 8;

export type SidebarWorkingRelocationDirection = "toWorking" | "toList";

export interface SidebarWorkingRelocation {
  direction: SidebarWorkingRelocationDirection;
  startedAt: number;
}

const EMPTY_RELOCATIONS: ReadonlyMap<ThreadId, SidebarWorkingRelocation> = new Map();

function sameIds(left: ReadonlySet<ThreadId>, right: ReadonlySet<ThreadId>): boolean {
  if (left === right) return true;
  if (left.size !== right.size) return false;
  for (const id of left) if (!right.has(id)) return false;
  return true;
}

/** Follows `raw` only after an id has entered or left it for the matching delay. */
export function useSettledThreadIdSet(raw: ReadonlySet<ThreadId>): ReadonlySet<ThreadId> {
  const [settled, setSettled] = useState(raw);
  const rawRef = useRef(raw);
  const deadlines = useRef(new Map<ThreadId, number>());

  useEffect(() => {
    rawRef.current = raw;
    const pending = deadlines.current;
    const now = performance.now();
    const disagreeing = new Set<ThreadId>();
    for (const id of raw) if (!settled.has(id)) disagreeing.add(id);
    for (const id of settled) if (!raw.has(id)) disagreeing.add(id);
    for (const id of pending.keys()) if (!disagreeing.has(id)) pending.delete(id);
    for (const id of disagreeing) {
      if (pending.has(id)) continue;
      pending.set(
        id,
        now + (raw.has(id) ? SIDEBAR_WORKING_ENTER_DELAY_MS : SIDEBAR_WORKING_LEAVE_DELAY_MS),
      );
    }
    if (pending.size === 0) return;
    const timer = window.setTimeout(
      () => {
        // Settle every id due within a frame together, so a burst moves as one update.
        const due = performance.now() + 16;
        const dueIds = [...pending].filter(([, deadline]) => deadline <= due).map(([id]) => id);
        for (const id of dueIds) pending.delete(id);
        const target = rawRef.current;
        setSettled((current) => {
          const changed = dueIds.filter((id) => current.has(id) !== target.has(id));
          if (changed.length === 0) return current;
          const next = new Set(current);
          for (const id of changed) {
            if (target.has(id)) next.add(id);
            else next.delete(id);
          }
          return next;
        });
      },
      Math.max(0, Math.min(...pending.values()) - now),
    );
    return () => window.clearTimeout(timer);
  }, [raw, settled]);

  return settled;
}

/**
 * While a row folds out of one place and into the other, it renders in both:
 * `shownInWorking` keeps rows that are leaving Working, and `hiddenFromList` omits
 * rows that are still folding out of the main list.
 */
export function useSidebarWorkingRelocation(working: ReadonlySet<ThreadId>, surfaceKey: string) {
  const reduceMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [previous, setPrevious] = useState({ working, surfaceKey });
  const [relocations, setRelocations] = useState(EMPTY_RELOCATIONS);

  // Adjusted during render so no frame shows a row in neither place.
  if (previous.surfaceKey !== surfaceKey || !sameIds(previous.working, working)) {
    setPrevious({ working, surfaceKey });
    const changes: [ThreadId, SidebarWorkingRelocationDirection][] = [];
    if (previous.surfaceKey === surfaceKey && !reduceMotion) {
      for (const id of working) if (!previous.working.has(id)) changes.push([id, "toWorking"]);
      for (const id of previous.working) if (!working.has(id)) changes.push([id, "toList"]);
    }
    if (changes.length === 0 || changes.length > MAX_ANIMATED_RELOCATIONS) {
      if (relocations.size > 0) setRelocations(EMPTY_RELOCATIONS);
    } else {
      const next = new Map(relocations);
      const startedAt = performance.now();
      for (const [id, direction] of changes) next.set(id, { direction, startedAt });
      setRelocations(next);
    }
  }

  useEffect(() => {
    if (relocations.size === 0) return;
    const timer = window.setTimeout(
      () => setRelocations(EMPTY_RELOCATIONS),
      DISCLOSURE_TRANSITION_MS + DISCLOSURE_CLEANUP_BUFFER_MS,
    );
    return () => window.clearTimeout(timer);
  }, [relocations]);

  const shownInWorking = useMemo(() => {
    if (relocations.size === 0) return working;
    const shown = new Set(working);
    for (const [id, { direction }] of relocations) if (direction === "toList") shown.add(id);
    return shown;
  }, [relocations, working]);
  const hiddenFromList = useMemo(() => {
    if (relocations.size === 0) return working;
    const hidden = new Set(working);
    for (const [id, { direction }] of relocations) if (direction === "toWorking") hidden.delete(id);
    return hidden;
  }, [relocations, working]);

  return { shownInWorking, hiddenFromList, relocations };
}

interface FoldState {
  leaving: boolean;
  animation: Animation;
}

const ROW_SELECTOR = "[data-sidebar-thread-id]";
const SECTION_SELECTOR = "[data-sidebar-working-section]";

/**
 * Folds the departing copy of each relocating row to zero height and unfolds the
 * arriving copy, with the shared disclosure timing. The Working section itself
 * unfolds when its first row arrives and folds when its last row leaves.
 */
export function useSidebarWorkingRelocationMotion(
  panelRef: RefObject<HTMLElement | null>,
  relocations: ReadonlyMap<ThreadId, SidebarWorkingRelocation>,
  workingCount: number,
) {
  const folds = useRef(new WeakMap<HTMLElement, FoldState>());
  const previousSection = useRef<HTMLElement | null>(null);

  // No deps: a row re-created mid-fold (grouping or paging refresh) resumes at the same point.
  useLayoutEffect(() => {
    const panel = panelRef.current;
    const section = panel?.querySelector<HTMLElement>(SECTION_SELECTOR) ?? null;
    const sectionAppeared = section !== null && section !== previousSection.current;
    previousSection.current = section;
    if (!panel) return;
    if (relocations.size === 0) {
      // A row can arrive without motion (reduced motion, burst) while the section folds out.
      const fold = section ? folds.current.get(section) : undefined;
      if (section && fold?.leaving && workingCount > 0) {
        fold.animation.cancel();
        folds.current.delete(section);
        section.inert = false;
        section.style.removeProperty("overflow");
      }
      return;
    }

    const targets: { element: HTMLElement; leaving: boolean; startedAt: number }[] = [];
    let sectionStart = performance.now();
    for (const row of panel.querySelectorAll<HTMLElement>(ROW_SELECTOR)) {
      const relocation = relocations.get(row.dataset.sidebarThreadId as ThreadId);
      if (!relocation) continue;
      sectionStart = Math.min(sectionStart, relocation.startedAt);
      const inWorking = row.closest(SECTION_SELECTOR) !== null;
      targets.push({
        element: row,
        leaving: (relocation.direction === "toWorking") !== inWorking,
        startedAt: relocation.startedAt,
      });
    }
    if (section && (sectionAppeared || workingCount === 0 || folds.current.has(section))) {
      targets.push({ element: section, leaving: workingCount === 0, startedAt: sectionStart });
    }

    // Read every natural height before the first animation writes styles.
    const measured = targets
      .filter(({ element, leaving }) => folds.current.get(element)?.leaving !== leaving)
      .map((target) => ({ ...target, height: target.element.getBoundingClientRect().height }));
    const now = performance.now();
    for (const { element, leaving, startedAt, height } of measured) {
      folds.current.get(element)?.animation.cancel();
      const frames: Keyframe[] = [
        { height: "0px", opacity: 0 },
        { height: `${height}px`, opacity: 1 },
      ];
      element.style.overflow = "hidden";
      // A departing copy must not keep focus or take clicks while it folds away.
      element.inert = leaving;
      const animation = element.animate(leaving ? frames.reverse() : frames, {
        duration: DISCLOSURE_TRANSITION_MS,
        easing: "ease-out",
        fill: leaving ? "forwards" : "none",
      });
      animation.currentTime = Math.min(DISCLOSURE_TRANSITION_MS, Math.max(0, now - startedAt));
      folds.current.set(element, { leaving, animation });
      if (!leaving) {
        void animation.finished.then(
          () => {
            if (folds.current.get(element)?.animation !== animation) return;
            folds.current.delete(element);
            element.style.removeProperty("overflow");
          },
          () => {},
        );
      }
    }
  });
}
