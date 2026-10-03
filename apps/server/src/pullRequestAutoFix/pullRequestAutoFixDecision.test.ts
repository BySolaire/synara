import {
  ThreadId,
  TurnId,
  type GitPullRequestCheck,
  type PullRequestAutoFixState,
} from "@synara/contracts";
import { describe, expect, it } from "vitest";

import {
  decidePullRequestAutoFix,
  type PullRequestAutoFixObservation,
} from "./pullRequestAutoFixDecision";

const T0 = "2026-10-03T10:00:00.000Z";
const T1 = "2026-10-03T10:05:00.000Z";

const failing: GitPullRequestCheck = { name: "Lint", status: "failure", url: null };
const passing: GitPullRequestCheck = { name: "Build", status: "success", url: null };
const pending: GitPullRequestCheck = { name: "Test", status: "pending", url: null };

function state(overrides: Partial<PullRequestAutoFixState> = {}): PullRequestAutoFixState {
  return {
    threadId: ThreadId.makeUnsafe("thread"),
    pullRequestUrl: "https://github.com/o/r/pull/1",
    status: "watching",
    pauseReason: null,
    attempts: 0,
    lastHandledHeadSha: null,
    updatedAt: T0,
    ...overrides,
  };
}

type Thread = NonNullable<Parameters<typeof decidePullRequestAutoFix>[0]["thread"]>;

function thread(overrides: Partial<Thread> = {}): Thread {
  return {
    archivedAt: null,
    session: null,
    latestTurn: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    ...overrides,
  };
}

function finishedTurn(requestedAt: string): Thread["latestTurn"] {
  return {
    turnId: TurnId.makeUnsafe("turn"),
    state: "completed",
    requestedAt,
    startedAt: requestedAt,
    completedAt: requestedAt,
    assistantMessageId: null,
  };
}

function pr(overrides: Partial<PullRequestAutoFixObservation> = {}): PullRequestAutoFixObservation {
  return {
    state: "open",
    url: "https://github.com/o/r/pull/1",
    headSha: "sha-1",
    checks: [passing, failing],
    ...overrides,
  };
}

describe("decidePullRequestAutoFix", () => {
  it("starts the first fix when checks settle red on a new commit", () => {
    expect(
      decidePullRequestAutoFix({ state: state(), thread: thread(), pullRequest: pr() }),
    ).toEqual({ type: "fix", headSha: "sha-1", attempt: 1, failingChecks: [failing] });
  });

  it("waits while checks are still running or none were reported", () => {
    for (const checks of [[failing, pending], []]) {
      expect(
        decidePullRequestAutoFix({ state: state(), thread: thread(), pullRequest: pr({ checks }) }),
      ).toEqual({ type: "wait" });
    }
  });

  it("never fixes the same commit twice", () => {
    expect(
      decidePullRequestAutoFix({
        state: state({ lastHandledHeadSha: "sha-1", attempts: 1 }),
        thread: thread(),
        pullRequest: pr(),
      }),
    ).toEqual({ type: "wait" });
  });

  it("waits while the thread is busy or waiting on the user", () => {
    const busyThreads: Thread[] = [
      thread({ latestTurn: { ...finishedTurn(T0)!, state: "running" } }),
      thread({ hasPendingApprovals: true }),
      thread({ hasPendingUserInput: true }),
    ];
    for (const busy of busyThreads) {
      expect(decidePullRequestAutoFix({ state: state(), thread: busy, pullRequest: pr() })).toEqual(
        { type: "wait" },
      );
    }
  });

  it("pauses at the attempt limit instead of starting another fix", () => {
    expect(
      decidePullRequestAutoFix({
        state: state({ attempts: 3, lastHandledHeadSha: "sha-0" }),
        thread: thread(),
        pullRequest: pr(),
      }),
    ).toEqual({ type: "pause", reason: "attempt-limit" });
  });

  it("pauses when the fix turn finished without pushing", () => {
    const fixing = state({
      status: "fixing",
      attempts: 1,
      lastHandledHeadSha: "sha-1",
      updatedAt: T1,
    });
    // The fix turn has not started yet: the latest turn predates the dispatch.
    expect(
      decidePullRequestAutoFix({
        state: fixing,
        thread: thread({ latestTurn: finishedTurn(T0) }),
        pullRequest: pr(),
      }),
    ).toEqual({ type: "wait" });
    expect(
      decidePullRequestAutoFix({
        state: fixing,
        thread: thread({ latestTurn: finishedTurn(T1) }),
        pullRequest: pr(),
      }),
    ).toEqual({ type: "pause", reason: "no-push" });
  });

  it("goes back to watching after a push and resets the budget once CI is green", () => {
    const fixing = state({ status: "fixing", attempts: 2, lastHandledHeadSha: "sha-1" });
    expect(
      decidePullRequestAutoFix({
        state: fixing,
        thread: thread(),
        pullRequest: pr({ headSha: "sha-2", checks: [pending] }),
      }),
    ).toEqual({ type: "update", status: "watching", attempts: 2 });
    expect(
      decidePullRequestAutoFix({
        state: fixing,
        thread: thread(),
        pullRequest: pr({ headSha: "sha-2", checks: [passing] }),
      }),
    ).toEqual({ type: "update", status: "watching", attempts: 0 });
  });

  it("starts the next attempt when the pushed fix fails again", () => {
    expect(
      decidePullRequestAutoFix({
        state: state({ status: "fixing", attempts: 1, lastHandledHeadSha: "sha-1" }),
        thread: thread(),
        pullRequest: pr({ headSha: "sha-2" }),
      }),
    ).toEqual({ type: "fix", headSha: "sha-2", attempt: 2, failingChecks: [failing] });
  });

  it("turns itself off when the PR closes or the thread goes away", () => {
    expect(
      decidePullRequestAutoFix({
        state: state(),
        thread: thread(),
        pullRequest: pr({ state: "merged" }),
      }),
    ).toEqual({ type: "disable", reason: "pull-request-closed" });
    expect(decidePullRequestAutoFix({ state: state(), thread: null, pullRequest: pr() })).toEqual({
      type: "disable",
      reason: "thread-unavailable",
    });
    expect(
      decidePullRequestAutoFix({
        state: state(),
        thread: thread({ archivedAt: T0 }),
        pullRequest: pr(),
      }),
    ).toEqual({ type: "disable", reason: "thread-unavailable" });
  });
});
