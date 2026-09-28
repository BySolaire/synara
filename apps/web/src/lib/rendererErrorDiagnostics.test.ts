import { afterEach, expect, it, vi } from "vitest";

import { installRendererErrorDiagnostics } from "./rendererErrorDiagnostics";

afterEach(() => vi.unstubAllGlobals());

it("does not throw a second renderer error when exception details have a throwing getter", () => {
  const reports: unknown[] = [];
  const target = Object.assign(new EventTarget(), {
    desktopBridge: {
      betaDiagnostics: {
        rendererReady: () => {},
        reportError: (error: unknown) => reports.push(error),
      },
    },
  });
  vi.stubGlobal("window", target);
  const dispose = installRendererErrorDiagnostics();
  try {
    const error = new Error("Original renderer failure");
    Object.defineProperty(error, "stack", {
      get() {
        throw new Error("Diagnostic accessor failure");
      },
    });
    target.dispatchEvent(Object.assign(new Event("error"), { error, message: error.message }));
    expect(reports).toEqual([{ message: "Renderer error details unavailable" }]);
  } finally {
    dispose?.();
  }
});
