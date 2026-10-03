// FILE: PullRequestAutoFixService.ts (layer)
// Purpose: Auto-fix CI. Stores the per-thread switch and, every minute, polls the checks of
//          each watched PR; when they settle red on a new commit it starts a fix turn on the
//          thread. All decisions live in `pullRequestAutoFixDecision.ts`.
// Layer: Server background service (Beta-only; the loop never starts on Stable)

import {
  CommandId,
  EventId,
  MessageId,
  PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
  type OrchestrationThreadShell,
  type PullRequestAutoFixPauseReason,
  type PullRequestAutoFixState,
  type ThreadId,
} from "@synara/contracts";
import { PULL_REQUEST_AUTO_FIX_BETA_FEATURE } from "@synara/shared/betaFeatures";
import { buildAutoFixFailingChecksPrompt } from "@synara/shared/pullRequestFixPrompts";
import { Cause, Duration, Effect, Layer, Option, Schedule } from "effect";

import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestAutoFixRepository } from "../../persistence/Services/PullRequestAutoFixRepository.ts";
import {
  decidePullRequestAutoFix,
  isThreadBusyForAutoFix,
  type PullRequestAutoFixDecision,
} from "../pullRequestAutoFixDecision.ts";
import {
  PullRequestAutoFixError,
  PullRequestAutoFixService,
  type PullRequestAutoFixServiceShape,
} from "../Services/PullRequestAutoFixService.ts";

/** Matches the Environment panel's own PR poll, so auto-fix adds no extra GitHub cadence. */
const PULL_REQUEST_AUTO_FIX_POLL_INTERVAL = Duration.seconds(60);

const PAUSE_SUMMARIES: Record<PullRequestAutoFixPauseReason, string> = {
  "attempt-limit": `Auto-fix CI paused: checks still fail after ${PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS} fix attempts`,
  "no-push": "Auto-fix CI paused: the fix turn ended without pushing a commit",
};

const autoFixId = (threadId: ThreadId, label: string) =>
  `pull-request-auto-fix:${threadId}:${label}:${crypto.randomUUID()}`;

const make = Effect.gen(function* () {
  const repository = yield* PullRequestAutoFixRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const gitHubCli = yield* GitHubCli;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const enabled = isServerBetaFeatureEnabled(PULL_REQUEST_AUTO_FIX_BETA_FEATURE);

  const fail = (message: string) => new PullRequestAutoFixError({ message });
  const toError = (fallback: string) => (cause: unknown) =>
    fail(cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback);

  const requireEnabled = enabled
    ? Effect.void
    : Effect.fail(fail("Auto-fix CI is available in Synara Beta."));

  const resolveThreadCwd = Effect.fnUntraced(function* (thread: OrchestrationThreadShell) {
    const project = Option.getOrUndefined(
      yield* snapshotQuery.getProjectShellById(thread.projectId),
    );
    return project ? (resolveThreadWorkspaceCwd({ thread, projects: [project] }) ?? null) : null;
  });

  const get: PullRequestAutoFixServiceShape["get"] = (input) =>
    requireEnabled.pipe(
      Effect.andThen(repository.get({ threadId: input.threadId })),
      Effect.map((state) => ({ state: Option.getOrNull(state) })),
      Effect.mapError(toError("Failed to read Auto-fix CI.")),
    );

  const set: PullRequestAutoFixServiceShape["set"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      if (!input.enabled) {
        yield* repository.delete({ threadId: input.threadId });
        return { state: null };
      }
      if (!input.pullRequestUrl) {
        return yield* fail("Choose the pull request to auto-fix.");
      }
      const thread = Option.getOrUndefined(yield* snapshotQuery.getThreadShellById(input.threadId));
      if (!thread || thread.archivedAt != null) {
        return yield* fail("This thread is no longer available.");
      }
      const cwd = yield* resolveThreadCwd(thread);
      if (!cwd) {
        return yield* fail("This thread has no workspace to fix the pull request in.");
      }
      // Confirms the PR exists and is open from the thread's own checkout before watching it.
      const { summary } = yield* gitHubCli.getPullRequestWithChecks({
        cwd,
        reference: input.pullRequestUrl,
      });
      if ((summary.state ?? "open") !== "open") {
        return yield* fail("Only open pull requests can be auto-fixed.");
      }
      // Turning it on (again) always starts fresh, so a red PR gets a fix right away.
      const state: PullRequestAutoFixState = {
        threadId: input.threadId,
        pullRequestUrl: summary.url,
        status: "watching",
        pauseReason: null,
        attempts: 0,
        lastHandledHeadSha: null,
        updatedAt: new Date().toISOString(),
      };
      yield* repository.upsert(state);
      return { state };
    }).pipe(
      Effect.mapError((cause) =>
        cause instanceof PullRequestAutoFixError
          ? cause
          : toError("Failed to update Auto-fix CI.")(cause),
      ),
    );

  const appendActivity = (threadId: ThreadId, kind: string, summary: string) => {
    const createdAt = new Date().toISOString();
    return orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(autoFixId(threadId, kind)),
      threadId,
      requireUnarchived: true,
      activity: {
        id: EventId.makeUnsafe(autoFixId(threadId, kind)),
        kind: `pull-request.auto-fix.${kind}`,
        tone: "info",
        summary,
        payload: {},
        turnId: null,
        createdAt,
      },
      createdAt,
    });
  };

  const startFixTurn = Effect.fnUntraced(function* (input: {
    readonly state: PullRequestAutoFixState;
    readonly thread: OrchestrationThreadShell;
    readonly decision: Extract<PullRequestAutoFixDecision, { type: "fix" }>;
    readonly prNumber: number;
    readonly headBranch: string;
  }) {
    const { state, decision } = input;
    const now = new Date().toISOString();
    // Record the attempt before dispatching: if the dispatch is lost, the row says "fixing"
    // and the next poll waits instead of starting a second turn for the same commit.
    yield* repository.upsert({
      ...state,
      status: "fixing",
      pauseReason: null,
      attempts: decision.attempt,
      lastHandledHeadSha: decision.headSha,
      updatedAt: now,
    });
    yield* orchestrationEngine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.makeUnsafe(autoFixId(state.threadId, "turn")),
        threadId: state.threadId,
        message: {
          messageId: MessageId.makeUnsafe(autoFixId(state.threadId, "message")),
          role: "user",
          text: buildAutoFixFailingChecksPrompt({
            prNumber: input.prNumber,
            prUrl: state.pullRequestUrl,
            headBranch: input.headBranch,
            headSha: decision.headSha,
            checks: decision.failingChecks,
            attempt: decision.attempt,
            maxAttempts: PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS,
          }),
          attachments: [],
        },
        dispatchMode: "queue",
        dispatchOrigin: "automation",
        // The thread's own modes: an unattended fix turn never gets more access than the
        // user already gave this thread.
        runtimeMode: input.thread.runtimeMode,
        interactionMode: input.thread.interactionMode,
        createdAt: now,
      })
      .pipe(
        // Put the row back so the failure is retried on the next poll.
        Effect.tapError(() => repository.upsert(state)),
      );
  });

  const pollThread = Effect.fnUntraced(function* (state: PullRequestAutoFixState) {
    const thread = Option.getOrNull(yield* snapshotQuery.getThreadShellById(state.threadId));
    // A busy thread is skipped before touching GitHub: nothing can happen until it idles.
    if (thread && thread.archivedAt == null && isThreadBusyForAutoFix(thread)) return;

    const cwd = thread ? yield* resolveThreadCwd(thread) : null;
    if (thread && !cwd) return;
    const observed = cwd
      ? yield* gitHubCli.withRead(
          gitHubCli.getPullRequestWithChecks({ cwd, reference: state.pullRequestUrl }),
        )
      : null;

    const decision = decidePullRequestAutoFix({
      state,
      thread,
      pullRequest: observed
        ? {
            state: observed.summary.state ?? "open",
            url: observed.summary.url,
            headSha: observed.headSha,
            checks: observed.checks,
          }
        : { state: "open", url: state.pullRequestUrl, headSha: null, checks: [] },
    });

    switch (decision.type) {
      case "wait":
        return;
      case "disable":
        yield* repository.delete({ threadId: state.threadId });
        if (decision.reason === "pull-request-closed") {
          yield* appendActivity(
            state.threadId,
            "stopped",
            "Auto-fix CI turned off: the pull request was closed",
          );
        }
        return;
      case "pause":
        yield* repository.upsert({
          ...state,
          status: "paused",
          pauseReason: decision.reason,
          updatedAt: new Date().toISOString(),
        });
        yield* appendActivity(state.threadId, "paused", PAUSE_SUMMARIES[decision.reason]);
        return;
      case "update":
        yield* repository.upsert({
          ...state,
          status: decision.status,
          attempts: decision.attempts,
          updatedAt: new Date().toISOString(),
        });
        return;
      case "fix":
        if (!observed || !thread) return;
        yield* startFixTurn({
          state,
          thread,
          decision,
          prNumber: observed.summary.number,
          headBranch: observed.summary.headRefName,
        });
        return;
    }
  });

  const pollAll = repository.listActive().pipe(
    Effect.flatMap((states) =>
      Effect.forEach(
        states,
        (state) =>
          pollThread(state).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("auto-fix CI poll failed", {
                threadId: state.threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        { discard: true },
      ),
    ),
    Effect.catchCause((cause) =>
      Effect.logWarning("auto-fix CI poll failed", { cause: Cause.pretty(cause) }),
    ),
  );

  if (enabled) {
    yield* pollAll.pipe(
      Effect.repeat(Schedule.spaced(PULL_REQUEST_AUTO_FIX_POLL_INTERVAL)),
      Effect.forkScoped,
    );
  }

  return { get, set } satisfies PullRequestAutoFixServiceShape;
});

export const PullRequestAutoFixServiceLive = Layer.effect(PullRequestAutoFixService, make);
