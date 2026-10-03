// FILE: pullRequestAutoFix.ts
// Purpose: Per-thread "Auto-fix CI" state: the server watches the thread's open pull
//          request and starts a fix turn when its checks fail. Beta-only.
// Layer: Shared contracts (server watcher, WS RPCs, Environment panel PR menu)

import { Schema } from "effect";

import { IsoDateTime, NonNegativeInt, ThreadId, TrimmedNonEmptyString } from "./baseSchemas";

/** Fix turns allowed in a row without a green run before auto-fix pauses itself. */
export const PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS = 3;

/**
 * - `watching`: waiting for the PR's checks to settle.
 * - `fixing`: a fix turn was started for `lastHandledHeadSha` and has not pushed yet.
 * - `paused`: stopped until the user turns it back on (see `pauseReason`).
 */
export const PullRequestAutoFixStatus = Schema.Literals(["watching", "fixing", "paused"]);
export type PullRequestAutoFixStatus = typeof PullRequestAutoFixStatus.Type;

/**
 * - `attempt-limit`: CI still failed after the maximum number of fix turns.
 * - `no-push`: a fix turn ended without pushing a new commit.
 */
export const PullRequestAutoFixPauseReason = Schema.Literals(["attempt-limit", "no-push"]);
export type PullRequestAutoFixPauseReason = typeof PullRequestAutoFixPauseReason.Type;

export const PullRequestAutoFixState = Schema.Struct({
  threadId: ThreadId,
  /** The PR being watched. Auto-fix turns off when the thread's PR changes. */
  pullRequestUrl: TrimmedNonEmptyString,
  status: PullRequestAutoFixStatus,
  pauseReason: Schema.NullOr(PullRequestAutoFixPauseReason),
  /** Fix turns started since the last green run. */
  attempts: NonNegativeInt,
  /** Head commit whose failing checks already started a fix turn. */
  lastHandledHeadSha: Schema.NullOr(TrimmedNonEmptyString),
  updatedAt: IsoDateTime,
});
export type PullRequestAutoFixState = typeof PullRequestAutoFixState.Type;

export const PullRequestAutoFixGetInput = Schema.Struct({
  threadId: ThreadId,
});
export type PullRequestAutoFixGetInput = typeof PullRequestAutoFixGetInput.Type;

/**
 * `pullRequestUrl` is required to turn auto-fix on: it is the PR the Environment panel shows
 * for the thread's checked-out branch. Turning it on again after a pause resumes with a
 * fresh attempt count.
 */
export const PullRequestAutoFixSetInput = Schema.Struct({
  threadId: ThreadId,
  enabled: Schema.Boolean,
  pullRequestUrl: Schema.optional(TrimmedNonEmptyString),
});
export type PullRequestAutoFixSetInput = typeof PullRequestAutoFixSetInput.Type;

/** `state` is null while auto-fix is off for the thread. */
export const PullRequestAutoFixResult = Schema.Struct({
  state: Schema.NullOr(PullRequestAutoFixState),
});
export type PullRequestAutoFixResult = typeof PullRequestAutoFixResult.Type;
