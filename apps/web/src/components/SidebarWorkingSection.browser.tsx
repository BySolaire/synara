// FILE: SidebarWorkingSection.browser.tsx
// Purpose: Classic Working disclosure, independent scrolling, and keyboard-focus regressions.

import "../index.css";

import { useMemo, useRef, useState } from "react";
import { ProjectId, ThreadId } from "@synara/contracts";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { useSidebarWorkingFocus } from "../hooks/useSidebarWorkingFocus";
import {
  SIDEBAR_WORKING_LEAVE_DELAY_MS,
  useSettledThreadIdSet,
  useSidebarWorkingRelocation,
  useSidebarWorkingRelocationMotion,
} from "../hooks/useSidebarWorkingRelocation";
import { DISCLOSURE_TRANSITION_MS } from "../lib/disclosureMotion";
import { SIDEBAR_THREAD_ROW_BASE_CLASS_NAME } from "../sidebarRowStyles";
import type { SidebarThreadSummary, Thread } from "../types";
import {
  buildProjectThreadTree,
  collectActiveWorkThreadIds,
  collectWorkingThreadIds,
  resolveThreadStatusPill,
} from "./Sidebar.logic";
import { SidebarThreadRowContent } from "./SidebarThreadRowContent";
import { SidebarStatusTrailingGlyph } from "./SidebarStatusTrailingGlyph";
import { SidebarWorkingSection } from "./SidebarWorkingSection";
import {
  SidebarContent,
  SidebarMenu,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
} from "./ui/sidebar";

const EMPTY_IDS: ReadonlySet<ThreadId> = new Set();
const SECTION = "[data-sidebar-working-section]";

const session = (status: "connecting" | "running") =>
  ({
    provider: "codex",
    status,
    createdAt: "2026-10-05T12:00:00.000Z",
    updatedAt: "2026-10-05T12:00:00.000Z",
    orchestrationStatus: "ready",
  }) as Thread["session"];
const settledTurn = {
  turnId: "turn-previous",
  state: "completed",
  requestedAt: "2026-10-05T11:59:00.000Z",
  startedAt: "2026-10-05T11:59:00.000Z",
  completedAt: "2026-10-05T11:59:30.000Z",
  assistantMessageId: null,
} as unknown as Thread["latestTurn"];

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function rowsOf(id: ThreadId): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(`[data-sidebar-thread-id="${id}"]`)];
}

/** Where the row renders: its usual list, Working, or both while it folds across. */
function placementOf(id: ThreadId): "list" | "working" | "both" | "none" {
  const rows = rowsOf(id);
  const inWorking = rows.some((row) => row.closest(SECTION));
  const inList = rows.some((row) => !row.closest(SECTION));
  return inWorking && inList ? "both" : inWorking ? "working" : inList ? "list" : "none";
}

/** [departing copy, arriving copy] of a row that renders in both places. */
function splitByDeparture(id: ThreadId): [HTMLElement | undefined, HTMLElement | undefined] {
  const rows = rowsOf(id);
  return [rows.find((row) => row.inert), rows.find((row) => !row.inert)];
}

function makeThread(index: number, work = false): SidebarThreadSummary {
  return {
    id: ThreadId.makeUnsafe(`classic-working-${index}`),
    projectId: ProjectId.makeUnsafe("working-project"),
    title: `Conversation ${index}`,
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    session: null,
    createdAt: "2026-10-05T12:00:00.000Z",
    latestTurn: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    hasLiveTailWork: work,
    pendingBackgroundWorkCount: 0,
  };
}

function ClassicHarness({
  threads,
  pins = EMPTY_IDS,
  activeThreadId,
  initiallyOpen = false,
  rowVersion = 0,
}: {
  threads: readonly SidebarThreadSummary[];
  pins?: ReadonlySet<ThreadId>;
  activeThreadId?: ThreadId;
  initiallyOpen?: boolean;
  rowVersion?: number;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const panelRef = useRef<HTMLDivElement>(null);
  const activeThreadIds = useSettledThreadIdSet(
    useMemo(() => collectActiveWorkThreadIds(threads, EMPTY_IDS), [threads]),
  );
  const working = useMemo(
    () =>
      collectWorkingThreadIds({
        threads,
        pinnedThreadIdSet: pins,
        preparingWorktreeThreadIds: EMPTY_IDS,
        activeThreadIds,
      }),
    [threads, pins, activeThreadIds],
  );
  const { shownInWorking, hiddenFromList, relocations } = useSidebarWorkingRelocation(
    working,
    "classic",
  );
  useSidebarWorkingRelocationMotion(panelRef, relocations, working.size);
  useSidebarWorkingFocus(panelRef, working, open);
  const workingRows = buildProjectThreadTree({
    threads: threads.filter((thread) => shownInWorking.has(thread.id)),
    forceVisibleThreadId: activeThreadId,
  });
  const normalRows = buildProjectThreadTree({
    threads: threads.filter((thread) => !hiddenFromList.has(thread.id)),
    forceVisibleThreadId: activeThreadId,
  });
  const row = (thread: SidebarThreadSummary) => {
    const status = resolveThreadStatusPill({
      thread,
      hasPendingApprovals: thread.hasPendingApprovals,
      hasPendingUserInput: thread.hasPendingUserInput,
    });
    return (
      <SidebarMenuSubItem key={`${thread.id}:${rowVersion}`} data-sidebar-thread-id={thread.id}>
        <SidebarMenuSubButton
          size="sm"
          render={<div role="button" tabIndex={0} />}
          aria-label={thread.title}
          data-testid={`classic-thread-${thread.id}`}
          className={`${SIDEBAR_THREAD_ROW_BASE_CLASS_NAME} pl-2 pr-2`}
        >
          <SidebarThreadRowContent
            thread={thread}
            terminalEntryPoint={false}
            terminalStatus={null}
            terminalCount={0}
            isActive={activeThreadId === thread.id}
            variant="standard"
            suffix={<span className="text-ui-xs text-muted-foreground">Project Alpha</span>}
          />
          {status ? <SidebarStatusTrailingGlyph status={status} /> : null}
        </SidebarMenuSubButton>
      </SidebarMenuSubItem>
    );
  };
  return (
    <>
      <SidebarProvider className="h-[500px] w-[300px] min-h-0">
        <div
          ref={panelRef}
          data-testid="classic-panel"
          className="flex min-h-0 min-w-0 flex-1 flex-col bg-sidebar text-sidebar-foreground [container-type:size]"
        >
          <SidebarContent className="px-1.5">
            <div className="px-2 py-2 text-ui text-muted-foreground">Projects</div>
            <SidebarMenu>{normalRows.map(({ thread }) => row(thread))}</SidebarMenu>
          </SidebarContent>
          <div
            data-sidebar-working-host
            data-testid="classic-footer"
            tabIndex={-1}
            className="shrink-0"
          >
            <SidebarWorkingSection
              count={workingRows.filter(({ thread }) => !thread.parentThreadId).length}
              open={open}
              onToggle={() => setOpen((value) => !value)}
            >
              <SidebarMenu>{workingRows.map(({ thread }) => row(thread))}</SidebarMenu>
            </SidebarWorkingSection>
          </div>
        </div>
      </SidebarProvider>
      <input aria-label="Composer" />
    </>
  );
}

describe("SidebarWorkingSection", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    document.documentElement.classList.remove("dark");
  });

  it("moves once when a new turn reports running before the turn itself", async () => {
    const idle = makeThread(1);
    const mounted = await render(<ClassicHarness threads={[idle]} initiallyOpen />);
    const placements: string[] = [];
    let frameId = 0;
    const record = () => {
      const placement = placementOf(idle.id);
      if (placements.at(-1) !== placement) placements.push(placement);
      frameId = requestAnimationFrame(record);
    };
    record();
    try {
      // Connecting, then `running` while the settled turn is still the latest, then the new turn.
      await mounted.rerender(
        <ClassicHarness threads={[{ ...idle, session: session("connecting") }]} initiallyOpen />,
      );
      await wait(120);
      await mounted.rerender(
        <ClassicHarness
          threads={[{ ...idle, session: session("running"), latestTurn: settledTurn }]}
          initiallyOpen
        />,
      );
      await wait(120);
      await mounted.rerender(
        <ClassicHarness threads={[{ ...idle, hasLiveTailWork: true }]} initiallyOpen />,
      );
      await expect.poll(() => placementOf(idle.id), { timeout: 2000 }).toBe("working");
      await wait(SIDEBAR_WORKING_LEAVE_DELAY_MS);
      expect(placements).toEqual(["list", "both", "working"]);
    } finally {
      cancelAnimationFrame(frameId);
      await mounted.unmount();
    }
  });

  it.each([false, true])(
    "folds the row out of its place and into the other with Working open=%s",
    async (open) => {
      document.documentElement.classList.toggle("dark", open);
      await page.viewport(open ? 1280 : 390, 800);
      const idle = makeThread(1);
      const peer = makeThread(2);
      const mounted = await render(<ClassicHarness threads={[idle, peer]} initiallyOpen={open} />);
      const rowHeight = rowsOf(idle.id)[0]!.getBoundingClientRect().height;
      const composer = page.getByRole("textbox", { name: "Composer", exact: true }).element();
      composer.focus();
      for (const working of [true, false]) {
        await mounted.rerender(
          <ClassicHarness
            threads={[{ ...idle, hasLiveTailWork: working }, peer]}
            initiallyOpen={open}
          />,
        );
        await expect.poll(() => placementOf(idle.id), { timeout: 2000 }).toBe("both");
        const [leaving, arriving] = splitByDeparture(idle.id);
        expect(leaving!.inert).toBe(true);
        expect(Boolean(leaving!.closest(SECTION))).toBe(!working);
        for (const element of [leaving!, arriving!]) element.getAnimations()[0]!.pause();
        leaving!.getAnimations()[0]!.currentTime = DISCLOSURE_TRANSITION_MS / 2;
        arriving!.getAnimations()[0]!.currentTime = DISCLOSURE_TRANSITION_MS / 2;
        for (const element of [leaving!, arriving!]) {
          const height = element.getBoundingClientRect().height;
          expect(height).toBeGreaterThan(1);
          expect(height).toBeLessThan(rowHeight - 1);
        }
        if (working) {
          await page.getByTestId("classic-panel").screenshot({
            path: `node_modules/.cache/working-fold-${open ? "open-dark" : "closed-light"}.png`,
          });
        }
        for (const element of [leaving!, arriving!]) element.getAnimations()[0]!.finish();
        await expect.poll(() => placementOf(idle.id)).toBe(working ? "working" : "list");
        const [settled] = rowsOf(idle.id);
        expect(settled!.inert).toBe(false);
        expect(settled!.style.overflow).toBe("");
        expect(settled!.getBoundingClientRect().height).toBeCloseTo(rowHeight, 0);
        expect(document.activeElement).toBe(composer);
      }
      await mounted.unmount();
      await page.viewport(1280, 900);
    },
  );

  it("unfolds Working with its first row and folds it away with its last", async () => {
    const idle = makeThread(1);
    const mounted = await render(<ClassicHarness threads={[idle]} />);
    expect(document.querySelector(SECTION)).toBeNull();
    await mounted.rerender(<ClassicHarness threads={[{ ...idle, hasLiveTailWork: true }]} />);
    await expect.poll(() => document.querySelector(SECTION), { timeout: 2000 }).not.toBeNull();
    const entering = document.querySelector<HTMLElement>(SECTION)!;
    expect(entering.getAnimations()).toHaveLength(1);
    expect(entering.inert).toBe(false);
    await expect.poll(() => entering.getAnimations().length).toBe(0);
    await mounted.rerender(<ClassicHarness threads={[idle]} />);
    await expect.poll(() => entering.inert, { timeout: 2000 }).toBe(true);
    expect(entering.getAnimations()).toHaveLength(1);
    await expect.poll(() => document.querySelector(SECTION)).toBeNull();
    expect(placementOf(idle.id)).toBe("list");
    await mounted.unmount();
  });

  it("resumes a fold when the row is re-created and ignores streaming updates", async () => {
    const idle = makeThread(1);
    const working = { ...idle, hasLiveTailWork: true };
    const mounted = await render(<ClassicHarness threads={[idle]} initiallyOpen />);
    await mounted.rerender(<ClassicHarness threads={[working]} initiallyOpen />);
    await expect.poll(() => placementOf(idle.id), { timeout: 2000 }).toBe("both");
    // A worktree or grouping refresh can remount the row without changing membership.
    await mounted.rerender(<ClassicHarness threads={[working]} initiallyOpen rowVersion={1} />);
    const [leaving] = splitByDeparture(idle.id);
    expect(leaving!.inert).toBe(true);
    expect(leaving!.getAnimations()).toHaveLength(1);
    await expect.poll(() => placementOf(idle.id)).toBe("working");
    await mounted.rerender(
      <ClassicHarness
        threads={[{ ...working, title: "Updated during streaming" }]}
        initiallyOpen
        rowVersion={1}
      />,
    );
    expect(rowsOf(idle.id)[0]!.getAnimations()).toHaveLength(0);
    await mounted.unmount();
  });

  it("swaps rows without folding when reduced motion is requested", async () => {
    const protocol = cdp() as {
      send(method: string, params: { features: { name: string; value: string }[] }): Promise<void>;
    };
    await protocol.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const idle = makeThread(1);
    const mounted = await render(<ClassicHarness threads={[idle]} initiallyOpen />);
    try {
      const placements = new Set<string>();
      let frameId = 0;
      const record = () => {
        placements.add(placementOf(idle.id));
        frameId = requestAnimationFrame(record);
      };
      record();
      await mounted.rerender(
        <ClassicHarness threads={[{ ...idle, hasLiveTailWork: true }]} initiallyOpen />,
      );
      await expect.poll(() => placementOf(idle.id), { timeout: 2000 }).toBe("working");
      cancelAnimationFrame(frameId);
      expect(placements.has("both")).toBe(false);
      expect(rowsOf(idle.id)[0]!.getAnimations()).toHaveLength(0);
    } finally {
      await protocol.send("Emulation.setEmulatedMedia", { features: [] });
      await mounted.unmount();
    }
  });

  it("swaps a burst of relocations without folding", async () => {
    const idle = Array.from({ length: 50 }, (_, index) => makeThread(index));
    const mounted = await render(<ClassicHarness threads={idle} />);
    await mounted.rerender(
      <ClassicHarness
        threads={Array.from({ length: 50 }, (_, index) => makeThread(index, true))}
      />,
    );
    await expect
      .poll(() => page.getByRole("button", { name: "Working (50)", exact: true }).query(), {
        timeout: 2000,
      })
      .not.toBeNull();
    expect(document.querySelectorAll("[data-sidebar-thread-id]")).toHaveLength(50);
    expect(document.querySelectorAll("[data-sidebar-thread-id][inert]")).toHaveLength(0);
    await mounted.unmount();
  });

  it("keeps an active subagent under its relocated parent without double rendering", async () => {
    const root = makeThread(1, true);
    const child = { ...makeThread(2), parentThreadId: root.id };
    const mounted = await render(
      <ClassicHarness threads={[root, child]} activeThreadId={child.id} />,
    );
    const header = page.getByRole("button", { name: "Working (1)", exact: true });
    expect(
      page.getByTestId(`classic-thread-${child.id}`).element().closest("[inert]"),
    ).not.toBeNull();
    await header.click();
    await expect.element(page.getByRole("button", { name: root.title, exact: true })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: child.title, exact: true }))
      .toBeVisible();
    expect(document.querySelectorAll(`[data-sidebar-thread-id="${child.id}"]`)).toHaveLength(1);
    await mounted.unmount();
  });

  it("keeps the composer focused while moving its conversation", async () => {
    const idle = makeThread(1);
    const mounted = await render(<ClassicHarness threads={[idle]} />);
    const composer = page.getByRole("textbox", { name: "Composer", exact: true }).element();
    composer.focus();
    await mounted.rerender(<ClassicHarness threads={[{ ...idle, hasLiveTailWork: true }]} />);
    await expect.poll(() => placementOf(idle.id), { timeout: 2000 }).toBe("working");
    expect(document.activeElement).toBe(composer);
    expect(
      page.getByTestId(`classic-thread-${idle.id}`).element().closest("[inert]"),
    ).not.toBeNull();
    await mounted.unmount();
  });

  it("keeps collapsed rows out of keyboard navigation and disables motion when requested", async () => {
    const protocol = cdp() as {
      send(method: string, params: { features: { name: string; value: string }[] }): Promise<void>;
    };
    await protocol.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });
    const mounted = await render(<ClassicHarness threads={[makeThread(1, true)]} />);
    try {
      const header = page.getByRole("button", { name: "Working (1)", exact: true });
      header.element().focus();
      await userEvent.tab();
      expect(document.activeElement).toBe(
        page.getByRole("textbox", { name: "Composer", exact: true }).element(),
      );
      expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(
        getComputedStyle(document.querySelector("[data-sidebar-working-section] div[aria-hidden]")!)
          .transitionProperty,
      ).toBe("none");
      await header.click();
      await expect
        .element(page.getByRole("button", { name: "Conversation 1", exact: true }))
        .toBeVisible();
    } finally {
      await protocol.send("Emulation.setEmulatedMedia", { features: [] });
      await mounted.unmount();
    }
  });

  it.each([false, true])(
    "keeps fifty working chats below a scrolling main list in dark=%s",
    async (dark) => {
      document.documentElement.classList.toggle("dark", dark);
      await page.viewport(dark ? 1280 : 390, dark ? 900 : 700);
      const threads = [
        ...Array.from({ length: 30 }, (_, index) => makeThread(index)),
        ...Array.from({ length: 50 }, (_, index) => makeThread(index + 30, true)),
      ];
      const mounted = await render(<ClassicHarness threads={threads} initiallyOpen />);
      const panel = page.getByTestId("classic-panel").element();
      const footer = page.getByTestId("classic-footer").element();
      const mainViewport = panel
        .querySelector<HTMLElement>("[data-sidebar=content]")!
        .closest("[data-slot=scroll-area-viewport]") as HTMLElement;
      const workViewport = footer.querySelector<HTMLElement>("[data-slot=scroll-area-viewport]")!;
      expect(footer.getBoundingClientRect().height).toBeLessThanOrEqual(
        panel.getBoundingClientRect().height * 0.4,
      );
      const top = footer.getBoundingClientRect().top;
      mainViewport.scrollTop = mainViewport.scrollHeight;
      expect(footer.getBoundingClientRect().top).toBe(top);
      workViewport.scrollTop = workViewport.scrollHeight;
      expect(mainViewport.scrollTop).toBeGreaterThan(0);
      await page.getByTestId("classic-panel").screenshot({
        path: `node_modules/.cache/working-classic-${dark ? "dark-desktop" : "light-mobile"}.png`,
      });
      await mounted.unmount();
      await page.viewport(1280, 900);
    },
  );
});
