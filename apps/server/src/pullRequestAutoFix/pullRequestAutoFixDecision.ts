// FILE: pullRequestAutoFixDecision.ts
// Purpose: The Auto-fix CI watcher's per-poll decision for one watched PR of a chat, as a
//          pure function (given the stored state, the chat, its checkout, and the PR's checks,
//          what to do next), and the message that starts a fix turn.
// Layer: Server domain logic (no Effect, no I/O)

import {
  PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type GitPullRequestCheck,
  type OrchestrationThreadShell,
  type PullRequestAutoFixPauseReason,
  type PullRequestAutoFixState,
} from "@synara/contracts";

export interface PullRequestAutoFixObservation {
  readonly state: "open" | "closed" | "merged";
  readonly url: string;
  readonly headBranch: string | null;
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
  /**
   * Start fix turn number `attempt` for the failing checks on `headSha`. `switchBranch` is set
   * when the chat sits on another branch: the turn switches to the PR's branch first and back
   * to `returnBranch` (null for a detached HEAD) afterwards.
   */
  | {
      readonly type: "fix";
      readonly headSha: string;
      readonly attempt: number;
      readonly switchBranch: { readonly to: string; readonly returnBranch: string | null } | null;
    };

type ThreadActivity = Pick<
  OrchestrationThreadShell,
  "archivedAt" | "session" | "latestTurn" | "hasPendingApprovals" | "hasPendingUserInput"
>;

/** The chat's working tree, read once per poll. `null` when git status could not be read. */
export interface PullRequestAutoFixCheckout {
  readonly branch: string | null;
  readonly clean: boolean;
}

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
  readonly checkout: PullRequestAutoFixCheckout | null;
  readonly pullRequest: PullRequestAutoFixObservation;
  readonly maxAttempts?: number;
}): PullRequestAutoFixDecision {
  const { state, thread, checkout, pullRequest } = input;
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

  const failed = pullRequest.checks.some(
    (check) => check.status === "failure" || check.status === "cancelled",
  );
  if (!failed) {
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

  // A fix edits whatever is checked out. On the PR's own branch it runs as is; on another
  // branch (e.g. the next PR of a stack) the agent switches over, but only from a clean
  // working tree so in-progress edits are never carried along or lost.
  if (checkout === null) return { type: "wait" };
  const headBranch = pullRequest.headBranch;
  if (headBranch === null || checkout.branch === headBranch) {
    return {
      type: "fix",
      headSha: pullRequest.headSha,
      attempt: state.attempts + 1,
      switchBranch: null,
    };
  }
  if (!checkout.clean) return { type: "wait" };
  return {
    type: "fix",
    headSha: pullRequest.headSha,
    attempt: state.attempts + 1,
    switchBranch: { to: headBranch, returnBranch: checkout.branch },
  };
}

// Branch names land inside code spans; keep them on one line and free of backticks.
const inlineCode = (value: string) => `\`${value.replace(/[`\s]+/g, "")}\``;

// A one-line notice, like Claude Code's CI event: the agent reads the failures itself with
// `gh`, so the message only names the PR and commit, any branch switch, and when to push.
export function buildPullRequestAutoFixPrompt(input: {
  readonly prNumber: number;
  readonly headSha: string;
  readonly switchBranch: { readonly to: string; readonly returnBranch: string | null } | null;
}): string {
  const { prNumber, switchBranch } = input;
  const commit = input.headSha.slice(0, 7);
  const act = `push only a verified fix; if this PR didn't cause it, say why and don't push.`;
  if (switchBranch === null) {
    return `Auto-fix CI: CI failed on PR #${prNumber} at ${commit}. Check \`gh pr checks ${prNumber}\` and ${act}`;
  }
  const back =
    switchBranch.returnBranch === null
      ? ""
      : ` Then switch back to ${inlineCode(switchBranch.returnBranch)}.`;
  return `Auto-fix CI: CI failed on PR #${prNumber} (${inlineCode(switchBranch.to)}) at ${commit}. Switch to ${inlineCode(switchBranch.to)}, check \`gh pr checks ${prNumber}\`, and ${act}${back}`;
}
