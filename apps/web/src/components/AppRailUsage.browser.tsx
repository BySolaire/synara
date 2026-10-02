import "../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, type ServerProviderUsageSnapshot } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("~/appSettings", () => ({
  useAppSettings: () => ({ settings: { codexHomePath: "", railUsageProviders: ["codex"] } }),
}));

import { serverQueryKeys } from "~/lib/serverReactQuery";

import { AppRailUsage } from "./AppRailUsage";

async function renderUsage(
  limits: ServerProviderUsageSnapshot["limits"],
  status: ServerProviderUsageSnapshot["status"] = "ok",
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, enabled: false } },
  });
  client.setQueryData(serverQueryKeys.allProviderUsage(), [
    {
      provider: "codex",
      updatedAt: "2026-10-02T12:00:00.000Z",
      status,
      source: "test",
      limits,
      usageLines: [],
    } satisfies ServerProviderUsageSnapshot,
  ]);
  client.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
  const onOpenUsageSettings = vi.fn();
  await render(
    <QueryClientProvider client={client}>
      <AppRailUsage onOpenUsageSettings={onOpenUsageSettings} />
    </QueryClientProvider>,
  );
  return onOpenUsageSettings;
}

describe("AppRailUsage", () => {
  it("shows independent weekly and five-hour rings even when a model sublimit is tighter", async () => {
    const onOpenUsageSettings = await renderUsage([
      { window: "seven_day", usedPercent: 57, windowDurationMins: 10_080 },
      { window: "five_hour", usedPercent: 22, windowDurationMins: 300 },
      { window: "seven_day_sonnet", usedPercent: 96, windowDurationMins: 10_080 },
    ]);

    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(Array.from(fills, (circle) => circle.getAttribute("stroke-dasharray"))).toEqual([
      "43 100",
      "78 100",
    ]);
    expect(Number(fills[0]?.getAttribute("r"))).toBeGreaterThan(
      Number(fills[1]?.getAttribute("r")),
    );
    expect(getComputedStyle(fills[0]!).stroke).not.toBe(getComputedStyle(fills[1]!).stroke);

    await userEvent.hover(button);
    await expect.element(page.getByText("Weekly · outer")).toBeVisible();
    await expect.element(page.getByText("5h · inner")).toBeVisible();
    await expect.element(page.getByText("43% left", { exact: true })).toBeVisible();
    await expect.element(page.getByText("78% left", { exact: true })).toBeVisible();
    await button.click();
    expect(onOpenUsageSettings).toHaveBeenCalledOnce();
  });

  it.each(["Weekly", "5h"])("shows only the reported %s ring", async (window) => {
    await renderUsage([{ window, usedPercent: 35 }]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("65 100");
  });

  it("keeps an empty track for an exhausted window without drawing a remaining arc", async () => {
    await renderUsage([
      { window: "Weekly", usedPercent: 0 },
      { window: "5h", usedPercent: 100 },
    ]);
    const button = page.getByRole("button", {
      name: "Codex usage: 5h 0% remaining, Weekly 100% remaining. Open usage settings",
    });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelectorAll("circle")).toHaveLength(3);
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("100 100");
  });

  it("preserves the single-ring fallback for providers with other limit windows", async () => {
    await renderUsage([{ window: "Monthly", usedPercent: 60 }]);
    const button = page.getByRole("button", { name: /^Codex usage:/ });
    await expect.element(button).toBeVisible();
    const fills = button.element().querySelectorAll("circle[stroke-dasharray]");
    expect(fills).toHaveLength(1);
    expect(fills[0]?.getAttribute("stroke-dasharray")).toBe("40 100");
  });

  it("keeps the unavailable provider visible without a quota arc", async () => {
    await renderUsage([], "error");
    const button = page.getByRole("button", {
      name: "Codex usage: Unavailable. Open usage settings",
    });
    await expect.element(button).toBeVisible();
    expect(button.element().querySelectorAll("circle")).toHaveLength(1);
    expect(button.element().querySelectorAll("circle[stroke-dasharray]")).toHaveLength(0);
  });
});
