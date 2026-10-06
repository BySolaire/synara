import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  normalizeSidebarProjectThreadListCwd,
  persistSidebarUiState,
  readSidebarUiState,
  readSidebarUiStateSnapshot,
  subscribeSidebarUiStateWrites,
  subscribeSidebarUiState,
} from "./Sidebar.uiState";
import type { ActivityScopeSelection } from "./SidebarActivityView.logic";

describe("Sidebar.uiState", () => {
  let storage = new Map<string, string>();

  beforeEach(() => {
    storage = new Map<string, string>();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          clear: () => {
            storage.clear();
          },
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => {
            storage.delete(key);
          },
          setItem: (key: string, value: string) => {
            storage.set(key, value);
          },
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis, "window");
  });

  it("tells same-tab readers about writes and keeps one snapshot between them", () => {
    let writes = 0;
    const unsubscribe = subscribeSidebarUiStateWrites(() => {
      writes += 1;
    });
    const before = readSidebarUiStateSnapshot();
    expect(readSidebarUiStateSnapshot()).toBe(before);

    persistSidebarUiState({
      ...readSidebarUiState(),
      dismissedThreadStatusKeyByThreadId: { "thread-1": "Pending Approval:turn-1" },
    });

    expect(writes).toBe(1);
    expect(readSidebarUiStateSnapshot().dismissedThreadStatusKeyByThreadId).toEqual({
      "thread-1": "Pending Approval:turn-1",
    });
    unsubscribe();
    persistSidebarUiState(readSidebarUiState());
    expect(writes).toBe(1);
  });

  it("defaults collapsed sidebar UI state with no thread list paging", () => {
    expect(readSidebarUiState()).toEqual({
      workingSectionExpanded: false,
      chatSectionExpanded: false,
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {},
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: null,
      activityViewEnabled: false,
      activityScope: null,
    });
  });

  it("remembers Working across reloads and periods without working chats", () => {
    persistSidebarUiState({ ...readSidebarUiState(), workingSectionExpanded: true });
    expect(readSidebarUiState().workingSectionExpanded).toBe(true);
    persistSidebarUiState({ ...readSidebarUiState(), chatSectionExpanded: true });
    expect(readSidebarUiState().workingSectionExpanded).toBe(true);
  });

  it("adopts Working changes from another window without losing other fields", () => {
    let onStorage: ((event: StorageEvent) => void) | undefined;
    window.addEventListener = ((_name: string, listener: (event: StorageEvent) => void) => {
      onStorage = listener;
    }) as typeof window.addEventListener;
    let received = readSidebarUiState();
    const unsubscribe = subscribeSidebarUiState((state) => {
      received = state;
    });
    window.localStorage.setItem(
      "synara:sidebar-ui:v1",
      JSON.stringify({
        workingSectionExpanded: true,
        activityViewEnabled: true,
        activityScope: "project-a",
      }),
    );
    onStorage!({ key: "synara:sidebar-ui:v1" } as StorageEvent);
    expect(received).toMatchObject({
      workingSectionExpanded: true,
      activityViewEnabled: true,
      activityScope: "project-a",
    });
    unsubscribe();
  });

  it("defaults malformed Working state to collapsed and tolerates unavailable storage", () => {
    window.localStorage.setItem(
      "synara:sidebar-ui:v1",
      JSON.stringify({ workingSectionExpanded: "true" }),
    );
    expect(readSidebarUiState().workingSectionExpanded).toBe(false);
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new Error("Storage unavailable");
      },
    });
    expect(readSidebarUiState().workingSectionExpanded).toBe(false);
    expect(() =>
      persistSidebarUiState({ ...readSidebarUiState(), workingSectionExpanded: true }),
    ).not.toThrow();
  });

  it("persists project thread list paging by normalized cwd", () => {
    persistSidebarUiState({
      workingSectionExpanded: false,
      chatSectionExpanded: true,
      chatThreadListExtraPages: 2,
      projectThreadListExtraPagesByCwd: {
        "/Users/tester/Code/demo": 1,
        "/Users/tester/Code/demo/": 3,
        "/Users/tester/Code/other": 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Plan Ready:turn-1",
      },
      lastThreadRoute: {
        threadId: "thread-123",
        splitViewId: "split-456",
      },
      activityViewEnabled: true,
      activityScope: "project-123" as ActivityScopeSelection,
    });

    expect(readSidebarUiState()).toEqual({
      workingSectionExpanded: false,
      chatSectionExpanded: true,
      chatThreadListExtraPages: 2,
      projectThreadListExtraPagesByCwd: {
        // Duplicate cwds that normalize to the same key keep the deepest paging.
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 3,
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/other")]: 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Plan Ready:turn-1",
      },
      lastThreadRoute: {
        threadId: "thread-123",
        splitViewId: "split-456",
      },
      activityViewEnabled: true,
      activityScope: "project-123",
    });
  });

  it("ignores malformed persisted thread list paging entries", () => {
    window.localStorage.setItem(
      "synara:sidebar-ui:v1",
      JSON.stringify({
        chatSectionExpanded: true,
        chatThreadListExtraPages: -4,
        projectThreadListExtraPagesByCwd: {
          "/Users/tester/Code/demo": 2,
          "/Users/tester/Code/zero": 0,
          "/Users/tester/Code/negative": -1,
          "/Users/tester/Code/bad": "nope",
          "": 3,
        },
        dismissedThreadStatusKeyByThreadId: {
          "thread-123": "Awaiting Input:turn-2",
          "": "bad",
          "thread-456": 42,
        },
        lastThreadRoute: {
          threadId: "thread-123",
          splitViewId: 42,
        },
        activityScope: 42,
      }),
    );

    expect(readSidebarUiState()).toEqual({
      workingSectionExpanded: false,
      chatSectionExpanded: true,
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 2,
      },
      dismissedThreadStatusKeyByThreadId: {
        "thread-123": "Awaiting Input:turn-2",
      },
      lastThreadRoute: {
        threadId: "thread-123",
      },
      activityViewEnabled: false,
      activityScope: null,
    });
  });

  it("migrates legacy all-or-nothing show-more state to one extra page", () => {
    window.localStorage.setItem(
      "synara:sidebar-ui:v1",
      JSON.stringify({
        chatSectionExpanded: false,
        chatThreadListExpanded: true,
        expandedProjectThreadListCwds: ["/Users/tester/Code/demo", "/Users/tester/Code/other"],
      }),
    );

    expect(readSidebarUiState()).toMatchObject({
      chatThreadListExtraPages: 1,
      projectThreadListExtraPagesByCwd: {
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/demo")]: 1,
        [normalizeSidebarProjectThreadListCwd("/Users/tester/Code/other")]: 1,
      },
    });
  });

  it("drops malformed persisted last thread routes", () => {
    window.localStorage.setItem(
      "synara:sidebar-ui:v1",
      JSON.stringify({
        lastThreadRoute: {
          threadId: 42,
          splitViewId: "split-123",
        },
      }),
    );

    expect(readSidebarUiState()).toEqual({
      workingSectionExpanded: false,
      chatSectionExpanded: false,
      chatThreadListExtraPages: 0,
      projectThreadListExtraPagesByCwd: {},
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: null,
      activityViewEnabled: false,
      activityScope: null,
    });
  });
});
