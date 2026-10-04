import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({ toastAdd: vi.fn() }));
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/hooks/useDesktopCustomTitleBar", () => ({
  useDesktopCustomTitleBarActive: () => true,
}));
vi.mock("~/components/ui/toast", () => ({ toastManager: { add: harness.toastAdd } }));

import { DesktopWindowControls } from "./DesktopWindowControls";

const originalBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
afterEach(() => {
  if (originalBridge) Object.defineProperty(window, "desktopBridge", originalBridge);
  else Reflect.deleteProperty(window, "desktopBridge");
});

it("reports a failed maximize request and lets the user retry", async () => {
  const toggleMaximize = vi
    .fn()
    .mockRejectedValueOnce(new Error("Window is unavailable."))
    .mockResolvedValue({ isMaximized: true, isFullscreen: false });
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: {
      windowControls: {
        getState: vi.fn().mockResolvedValue({ isMaximized: false, isFullscreen: false }),
        onState: vi.fn(() => () => undefined),
        toggleMaximize,
      },
    },
  });
  const view = await render(<DesktopWindowControls />);
  try {
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    await vi.waitFor(() =>
      expect(harness.toastAdd).toHaveBeenCalledWith({
        type: "error",
        title: "Could not resize window",
        description: "Window is unavailable.",
      }),
    );
    await page.getByRole("button", { name: "Maximize", exact: true }).click();
    await expect.element(page.getByRole("button", { name: "Restore", exact: true })).toBeVisible();
  } finally {
    await view.unmount();
  }
});
