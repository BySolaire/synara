import { ProjectId } from "@synara/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  library: {
    list: vi.fn(),
    status: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock("~/nativeApi", () => ({
  readNativeApi: () => ({ projectAgent: { library: harness.library } }),
}));
vi.mock("~/lib/wsHttpUrl", () => ({ resolveWsHttpUrl: (path: string) => path }));

import { useGroupLibrary } from "./useGroupLibrary";

const firstProject = ProjectId.makeUnsafe("first");
const secondProject = ProjectId.makeUnsafe("second");

beforeEach(() => {
  harness.library.list.mockReset().mockResolvedValue({ root: "/library", entries: [] });
  harness.library.status.mockReset().mockResolvedValue({
    root: "/library",
    remoteConfigured: false,
    lastPushAt: null,
    lastPushError: null,
  });
  harness.library.mkdir.mockReset().mockResolvedValue({ commitSha: "commit" });
});
afterEach(() => vi.unstubAllGlobals());

it.each([false, true])(
  "keeps a rejected upload unsuccessful after project switch: %s",
  async (switchProject) => {
    let resolveResponse!: (response: Response) => void;
    const response = new Promise<Response>((resolve) => {
      resolveResponse = resolve;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response),
    );
    const hook = await renderHook(
      (props = { projectId: firstProject }) => useGroupLibrary({ ...props, enabled: true }),
      { initialProps: { projectId: firstProject } },
    );
    try {
      await vi.waitFor(() => expect(hook.result.current.root).toBe("/library"));
      const upload = hook.result.current.upload(undefined, new File(["hello"], "note.md"));
      if (switchProject) await hook.rerender({ projectId: secondProject });
      resolveResponse(new Response(JSON.stringify({ error: "Library is full." }), { status: 413 }));
      expect(await upload).toBe(false);
      await vi.waitFor(() => {
        expect(hook.result.current.busy).toBe(false);
        expect(hook.result.current.error).toBe(switchProject ? null : "Library is full.");
      });
    } finally {
      await hook.unmount();
    }
  },
);

it("waits for each directory refresh reply before starting the next request budget", async () => {
  const hook = await renderHook(() => useGroupLibrary({ projectId: firstProject, enabled: true }));
  const replies: Array<() => void> = [];
  try {
    await vi.waitFor(() => expect(hook.result.current.root).toBe("/library"));
    for (const dir of ["one", "two", "three"]) await hook.result.current.loadDirectory(dir);
    harness.library.list.mockClear().mockImplementation(
      () =>
        new Promise((resolve) => {
          replies.push(() => resolve({ root: "/library", entries: [] }));
        }),
    );
    const mutation = hook.result.current.mkdir("new-folder");
    const verdict = mutation.then((result) => result);
    for (let index = 0; index < 4; index += 1) {
      await vi.waitFor(() => expect(replies).toHaveLength(index + 1));
      expect(harness.library.list).toHaveBeenCalledTimes(index + 1);
      replies[index]!();
    }
    expect(await verdict).toBe(true);
    expect(harness.library.list.mock.calls.map(([input]) => input.relativePath ?? "")).toEqual([
      "",
      "one",
      "two",
      "three",
    ]);
    expect(hook.result.current.entriesByDir.size).toBe(4);
  } finally {
    replies.forEach((reply) => reply());
    await hook.unmount();
  }
});

it.each(["mutation", "upload"])(
  "retains a directory refresh failure after a committed %s",
  async (operation) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 204 })),
    );
    const hook = await renderHook(() =>
      useGroupLibrary({ projectId: firstProject, enabled: true }),
    );
    try {
      await vi.waitFor(() => expect(hook.result.current.root).toBe("/library"));
      await hook.result.current.loadDirectory("one");
      harness.library.list.mockImplementation(async ({ relativePath }) => {
        if (relativePath === "one") throw new Error("Directory refresh timed out.");
        return { root: "/library", entries: [] };
      });
      const result =
        operation === "mutation"
          ? await hook.result.current.mkdir("new-folder")
          : await hook.result.current.upload(undefined, new File(["hello"], "note.md"));
      // The write committed; expose failed refresh without inviting another write.
      expect(result).toBe(true);
      await vi.waitFor(() => {
        expect(hook.result.current.busy).toBe(false);
        expect(hook.result.current.error).toBe("Directory refresh timed out.");
      });
    } finally {
      await hook.unmount();
    }
  },
);
