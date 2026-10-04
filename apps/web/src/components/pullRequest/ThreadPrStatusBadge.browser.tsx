// FILE: ThreadPrStatusBadge.browser.tsx
// Purpose: Guards the icon-only PR badge, its accessible name, and its clickable destination.
// Layer: Pull request presentation test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ThreadPrStatusBadge } from "./ThreadPrStatusBadge";

describe("ThreadPrStatusBadge", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("renders an icon-only badge that exposes the PR number via its accessible name", async () => {
    const onOpen = vi.fn();
    await render(
      <ThreadPrStatusBadge
        pr={{
          number: 841,
          title: "Fix created-at thread ordering",
          url: "https://github.com/acme/synara/pull/841",
          state: "open",
          isDraft: false,
          mergeability: "mergeable",
        }}
        onOpen={onOpen}
      />,
    );

    const button = page.getByRole("button", {
      name: "#841 PR open: Fix created-at thread ordering",
    });
    await expect.element(button).toBeVisible();
    expect(document.body.textContent).not.toContain("841");

    await button.click();

    expect(onOpen).toHaveBeenCalledOnce();
    expect(onOpen.mock.calls[0]?.[1]).toBe("https://github.com/acme/synara/pull/841");
  });

  it("keeps presses on the badge from reaching the sidebar row around it", async () => {
    const onRowPointerDown = vi.fn();
    const onRowKeyDown = vi.fn();
    await render(
      <div
        role="button"
        aria-label="Thread row"
        tabIndex={0}
        onPointerDown={onRowPointerDown}
        onKeyDown={onRowKeyDown}
      >
        <ThreadPrStatusBadge
          pr={{
            number: 842,
            title: "Move the PR badge",
            url: "https://github.com/acme/synara/pull/842",
            state: "open",
            isDraft: false,
            mergeability: "mergeable",
          }}
          onOpen={vi.fn()}
        />
      </div>,
    );

    const badge = page.getByRole("button", { name: "#842 PR open: Move the PR badge" });
    await badge.click();
    badge.element().dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

    expect(onRowPointerDown).not.toHaveBeenCalled();
    expect(onRowKeyDown).not.toHaveBeenCalled();
  });
});
