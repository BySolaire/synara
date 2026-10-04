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

it("refreshes independent loaded directories together after a mutation", async () => {
  const hook = await renderHook(() => useGroupLibrary({ projectId: firstProject, enabled: true }));
  try {
    await vi.waitFor(() => expect(hook.result.current.root).toBe("/library"));
    await Promise.all(["one", "two", "three"].map((dir) => hook.result.current.loadDirectory(dir)));
    let active = 0;
    let peak = 0;
    harness.library.list.mockImplementation(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 80));
      active -= 1;
      return { root: "/library", entries: [] };
    });
    const start = performance.now();
    expect(await hook.result.current.mkdir("new-folder")).toBe(true);
    console.info(
      `Library mutation refresh, four 80ms reads: ${Math.round(performance.now() - start)}ms`,
    );
    expect(peak).toBe(4);
    expect(hook.result.current.entriesByDir.size).toBe(4);
  } finally {
    await hook.unmount();
  }
});
