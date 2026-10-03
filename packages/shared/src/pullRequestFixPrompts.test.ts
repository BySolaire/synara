import { describe, expect, it } from "vitest";

import { buildAutoFixFailingChecksPrompt } from "./pullRequestFixPrompts";

describe("buildAutoFixFailingChecksPrompt", () => {
  const input = {
    prNumber: 7,
    prUrl: "https://github.com/o/r/pull/7",
    headBranch: "feature/x",
    headSha: "abc123",
    attempt: 2,
    maxAttempts: 3,
    checks: [
      { name: "Lint", status: "failure" as const, url: "https://github.com/o/r/actions/runs/1" },
      { name: "Build", status: "success" as const, url: null },
      { name: "Deploy `preview`", status: "cancelled" as const, url: null },
    ],
  };

  it("names the attempt, commit, and only the failed or cancelled checks", () => {
    const prompt = buildAutoFixFailingChecksPrompt(input);
    expect(prompt).toContain("attempt 2 of 3");
    expect(prompt).toContain("`abc123`");
    expect(prompt).toContain("1. Failed check `Lint` at https://github.com/o/r/actions/runs/1");
    expect(prompt).toContain("2. Cancelled check `Deploy 'preview'`");
    expect(prompt).not.toContain("`Build`");
  });

  it("tells the agent how to read logs, when to push, and when to stop", () => {
    const prompt = buildAutoFixFailingChecksPrompt(input);
    expect(prompt).toContain("gh run view <run-id> --log-failed");
    expect(prompt).toContain("commit it and push to the PR branch");
    expect(prompt).toContain("do not push");
    expect(prompt).toContain("untrusted");
  });
});
