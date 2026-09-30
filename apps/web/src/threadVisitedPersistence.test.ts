// FILE: threadVisitedPersistence.test.ts
// Purpose: Unit-test persisted thread visits and the reload watermark.

import { ThreadId } from "@synara/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import { initialState, type AppState } from "./storeState";
import { makeFakeWindow } from "./storeTestFixtures";
import { THREAD_VISITED_STORAGE_KEY } from "./threadVisitedPersistence";
import type { SidebarThreadSummary } from "./types";

async function importThreadVisitedPersistence(storage: Map<string, string>) {
  vi.stubGlobal("window", makeFakeWindow(storage));
  vi.resetModules();
  return import("./threadVisitedPersistence");
}

interface Visit {
  readonly id: string;
  readonly updatedAt: string;
  readonly lastVisitedAt: string;
  readonly completedAt?: string;
}

function stateWithVisits(visits: ReadonlyArray<Visit>): AppState {
  const sidebarThreadSummaryById: Record<string, SidebarThreadSummary> = {};
  for (const visit of visits) {
    sidebarThreadSummaryById[visit.id] = {
      id: ThreadId.makeUnsafe(visit.id),
      updatedAt: visit.updatedAt,
      lastVisitedAt: visit.lastVisitedAt,
      latestTurn: visit.completedAt ? { state: "completed", completedAt: visit.completedAt } : null,
    } as SidebarThreadSummary;
  }
  return { ...initialState, threadsHydrated: true, sidebarThreadSummaryById };
}

describe("threadVisitedPersistence", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("keeps first-run behavior when nothing was saved", async () => {
    const { resolveInitialLastVisitedAt } = await importThreadVisitedPersistence(new Map());

    expect(resolveInitialLastVisitedAt("thread-1", "2026-09-30T10:00:00.000Z")).toBe(
      "2026-09-30T10:00:00.000Z",
    );
  });

  it("restores saved visits and treats updates after the last save as unseen", async () => {
    const storage = new Map<string, string>();
    storage.set(
      THREAD_VISITED_STORAGE_KEY,
      JSON.stringify({
        watermarkAt: "2026-09-30T08:00:00.000Z",
        byThreadId: {
          "thread-visited": "2026-09-30T07:00:00.000Z",
          "thread-bad": "not-a-date",
        },
      }),
    );
    const { resolveInitialLastVisitedAt } = await importThreadVisitedPersistence(storage);

    expect(resolveInitialLastVisitedAt("thread-visited", "2026-09-30T09:00:00.000Z")).toBe(
      "2026-09-30T07:00:00.000Z",
    );
    // Finished while the app was closed: unread from the last save onward.
    expect(
      resolveInitialLastVisitedAt("thread-new", "2026-09-30T09:00:00.000Z", {
        fromSnapshot: true,
      }),
    ).toBe("2026-09-30T08:00:00.000Z");
    // A thread that first appears through a live event is new as it happens.
    expect(resolveInitialLastVisitedAt("thread-new", "2026-09-30T09:00:00.000Z")).toBe(
      "2026-09-30T09:00:00.000Z",
    );
    expect(resolveInitialLastVisitedAt("thread-bad", "2026-09-30T07:30:00.000Z")).toBe(
      "2026-09-30T07:30:00.000Z",
    );
  });

  it("saves unread threads and a server-time watermark, and skips unchanged writes", async () => {
    const storage = new Map<string, string>();
    const { persistThreadVisitedState } = await importThreadVisitedPersistence(storage);
    const state = stateWithVisits([
      {
        id: "thread-read",
        updatedAt: "2026-09-30T09:00:00.000Z",
        lastVisitedAt: "2026-09-30T09:00:00.000Z",
        completedAt: "2026-09-30T08:50:00.000Z",
      },
      {
        id: "thread-unread",
        updatedAt: "2026-09-30T10:00:00.000Z",
        lastVisitedAt: "2026-09-30T08:00:00.000Z",
        completedAt: "2026-09-30T10:00:00.000Z",
      },
    ]);

    persistThreadVisitedState(state);
    expect(JSON.parse(storage.get(THREAD_VISITED_STORAGE_KEY) ?? "{}")).toEqual({
      watermarkAt: "2026-09-30T10:00:00.000Z",
      byThreadId: { "thread-unread": "2026-09-30T08:00:00.000Z" },
    });

    storage.set(THREAD_VISITED_STORAGE_KEY, "sentinel");
    persistThreadVisitedState(state);
    persistThreadVisitedState({ ...state });
    expect(storage.get(THREAD_VISITED_STORAGE_KEY)).toBe("sentinel");

    persistThreadVisitedState(state, { force: true });
    expect(storage.get(THREAD_VISITED_STORAGE_KEY)).not.toBe("sentinel");
  });

  it("keeps the most recently updated unread threads when over the cap", async () => {
    const storage = new Map<string, string>();
    const { MAX_PERSISTED_VISITED_THREADS, persistThreadVisitedState } =
      await importThreadVisitedPersistence(storage);
    const visits = Array.from({ length: MAX_PERSISTED_VISITED_THREADS + 1 }, (_, index) => {
      const at = new Date(Date.UTC(2026, 8, 30, 0, index)).toISOString();
      return {
        id: `thread-${index}`,
        updatedAt: at,
        lastVisitedAt: "2026-09-29T00:00:00.000Z",
        completedAt: at,
      };
    });

    persistThreadVisitedState(stateWithVisits(visits));
    const saved = JSON.parse(storage.get(THREAD_VISITED_STORAGE_KEY) ?? "{}");
    expect(Object.keys(saved.byThreadId)).toHaveLength(MAX_PERSISTED_VISITED_THREADS);
    expect(saved.byThreadId["thread-0"]).toBeUndefined();
  });
});
