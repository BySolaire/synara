// FILE: pullRequestAutoFixDecision.ts
// Purpose: The Auto-fix CI watcher's per-poll decision for one thread, as a pure function:
//          given the stored state, the thread, and the PR's checks, what to do next.
// Layer: Server domain logic (no Effect, no I/O)

import {
  PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type GitPullRequestCheck,
  type OrchestrationThreadShell,
  type PullRequestAutoFixPauseReason,
  type PullRequestAutoFixState,
} from "@synara/contracts";
import { failingPullRequestChecks } from "@synara/shared/pullRequestFixPrompts";

export interface PullRequestAutoFixObservation {
  readonly state: "open" | "closed" | "merged";
  readonly url: string;
  readonly headSha: string | null;
  readonly checks: ReadonlyArray<GitPullRequestCheck>;
}

export type PullRequestAutoFixDecision =
  /** Nothing to do this poll. */
  | { readonly type: "wait" }
  /** Stop watching for good and delete the row. */
  | { readonly type: "disable"; readonly reason: "pull-request-closed" | "thread-unavailable" }
  | { readonly type: "pause"; readonly reason: PullRequestAutoFixPauseReason }
  /** Persist a bookkeeping change without starting a turn. */
  | {
      readonly type: "update";
      readonly status: "watching";
      readonly attempts: number;
    }
  /** Start fix turn number `attempt` for the failing checks on `headSha`. */
  | {
      readonly type: "fix";
      readonly headSha: string;
      readonly attempt: number;
      readonly failingChecks: ReadonlyArray<GitPullRequestCheck>;
    };

type ThreadActivity = Pick<
  OrchestrationThreadShell,
  "archivedAt" | "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
>;

// A thread that is working or waiting on the user is left alone: fixes queue behind nothing
// and never race an approval prompt.
export function isThreadBusyForAutoFix(thread: ThreadActivity): boolean {
  const status = thread.session?.status;
  return (
    status === "starting" ||
    status === "running" ||
    thread.latestTurn?.state === "running" ||
    thread.hasPendingApprovals === true ||
    thread.hasPendingUserInput === true
  );
}

// True once a turn requested at or after `since` has finished. Covers the gap between
// dispatching the fix turn and the session reporting it as running.
function hasTurnFinishedSince(thread: ThreadActivity, since: string): boolean {
  const turn = thread.latestTurn;
  return turn !== null && turn.requestedAt >= since && turn.state !== "running";
}

export function decidePullRequestAutoFix(input: {
  readonly state: PullRequestAutoFixState;
  readonly thread: ThreadActivity | null;
  readonly pullRequest: PullRequestAutoFixObservation;
  readonly maxAttempts?: number;
}): PullRequestAutoFixDecision {
  const { state, thread, pullRequest } = input;
  const maxAttempts = input.maxAttempts ?? PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS;

  if (thread === null || thread.archivedAt != null) {
    return { type: "disable", reason: "thread-unavailable" };
  }
  if (pullRequest.state !== "open") {
    return { type: "disable", reason: "pull-request-closed" };
  }
  if (state.status === "paused" || isThreadBusyForAutoFix(thread) || pullRequest.headSha === null) {
    return { type: "wait" };
  }

  const pushedSinceLastFix = pullRequest.headSha !== state.lastHandledHeadSha;
  if (state.status === "fixing" && !pushedSinceLastFix) {
    // The fix turn ended without pushing a new commit: the agent decided the failure is not
    // fixable from here (or failed). Pausing hands the decision back to the user.
    return hasTurnFinishedSince(thread, state.updatedAt)
      ? { type: "pause", reason: "no-push" }
      : { type: "wait" };
  }

  const checksSettled =
    pullRequest.checks.length > 0 &&
    pullRequest.checks.every((check) => check.status !== "pending");
  if (!checksSettled) {
    return state.status === "fixing"
      ? { type: "update", status: "watching", attempts: state.attempts }
      : { type: "wait" };
  }

  const failingChecks = failingPullRequestChecks(pullRequest.checks);
  if (failingChecks.length === 0) {
    // Green: the attempt budget is per failure streak, not per PR lifetime.
    return state.status === "fixing" || state.attempts > 0
      ? { type: "update", status: "watching", attempts: 0 }
      : { type: "wait" };
  }
  if (!pushedSinceLastFix) {
    return { type: "wait" };
  }
  if (state.attempts >= maxAttempts) {
    return { type: "pause", reason: "attempt-limit" };
  }
  return {
    type: "fix",
    headSha: pullRequest.headSha,
    attempt: state.attempts + 1,
    failingChecks,
  };
}
