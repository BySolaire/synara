// FILE: PullRequestAutoFixService.ts (layer)
// Purpose: Auto-fix CI. Stores which pull requests each chat watches and, every minute,
//          polls their checks; when one settles red on a new commit it starts a fix turn in
//          that chat, one fix per chat at a time (like Claude Code's CI monitor, which wakes
//          the one session for every bound PR). All decisions live in
//          `pullRequestAutoFixDecision.ts`.
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
import { Cause, Duration, Effect, Layer, Option, Schedule } from "effect";

import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { GitCore } from "../../git/Services/GitCore.ts";
import { GitHubCli } from "../../git/Services/GitHubCli.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PullRequestAutoFixRepository } from "../../persistence/Services/PullRequestAutoFixRepository.ts";
import {
  buildPullRequestAutoFixPrompt,
  decidePullRequestAutoFix,
  isThreadBusyForAutoFix,
  type PullRequestAutoFixCheckout,
  type PullRequestAutoFixDecision,
} from "../pullRequestAutoFixDecision.ts";
import {
  PullRequestAutoFixError,
  PullRequestAutoFixService,
  type PullRequestAutoFixServiceShape,
} from "../Services/PullRequestAutoFixService.ts";

/** Matches the Environment panel's own PR poll, so auto-fix adds no extra GitHub cadence. */
const PULL_REQUEST_AUTO_FIX_POLL_INTERVAL = Duration.seconds(60);
/** Chats polled side by side; GitHub reads still go through the shared read queue. */
const PULL_REQUEST_AUTO_FIX_THREAD_CONCURRENCY = 4;

const PAUSE_SUMMARIES: Record<PullRequestAutoFixPauseReason, string> = {
  "attempt-limit": `checks still fail after ${PULL_REQUEST_AUTO_FIX_MAX_ATTEMPTS} fix attempts`,
  "no-push": "the fix turn ended without pushing a commit",
};

const autoFixId = (threadId: ThreadId, label: string) =>
  `pull-request-auto-fix:${threadId}:${label}:${crypto.randomUUID()}`;

const pullRequestLabel = (url: string) => {
  const number = /\/pull\/(\d+)/.exec(url)?.[1];
  return number ? `PR #${number}` : "the pull request";
};

const make = Effect.gen(function* () {
  const repository = yield* PullRequestAutoFixRepository;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const gitCore = yield* GitCore;
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
      Effect.andThen(repository.listByThread({ threadId: input.threadId })),
      Effect.map((states) => ({ states })),
      Effect.mapError(toError("Failed to read Auto-fix CI.")),
    );

  const set: PullRequestAutoFixServiceShape["set"] = (input) =>
    Effect.gen(function* () {
      yield* requireEnabled;
      if (!input.enabled) {
        yield* repository.delete({
          threadId: input.threadId,
          pullRequestUrl: input.pullRequestUrl,
        });
        return { state: null };
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
          text: buildPullRequestAutoFixPrompt({
            prNumber: input.prNumber,
            headSha: decision.headSha,
            switchBranch: decision.switchBranch,
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

  const readCheckout = (cwd: string) =>
    gitCore.statusDetails(cwd).pipe(
      Effect.map(
        (details): PullRequestAutoFixCheckout => ({
          branch: details.branch,
          clean: !details.hasWorkingTreeChanges,
        }),
      ),
      Effect.orElseSucceed(() => null),
    );

  /** Applies one PR's decision; returns true when it started a fix turn. */
  const pollPullRequest = Effect.fnUntraced(function* (input: {
    readonly state: PullRequestAutoFixState;
    readonly thread: OrchestrationThreadShell | null;
    readonly cwd: string | null;
    readonly checkout: PullRequestAutoFixCheckout | null;
  }) {
    const { state, thread, cwd, checkout } = input;
    const observed = cwd
      ? yield* gitHubCli.withRead(
          gitHubCli.getPullRequestWithChecks({ cwd, reference: state.pullRequestUrl }),
        )
      : null;

    const decision = decidePullRequestAutoFix({
      state,
      thread,
      checkout,
      pullRequest: observed
        ? {
            state: observed.summary.state ?? "open",
            url: observed.summary.url,
            headBranch: observed.summary.headRefName,
            headSha: observed.headSha,
            checks: observed.checks,
          }
        : { state: "open", url: state.pullRequestUrl, headBranch: null, headSha: null, checks: [] },
    });

    const key = { threadId: state.threadId, pullRequestUrl: state.pullRequestUrl };
    switch (decision.type) {
      case "wait":
        return false;
      case "disable":
        yield* repository.delete(key);
        if (decision.reason === "pull-request-closed") {
          yield* appendActivity(
            state.threadId,
            "stopped",
            `Auto-fix CI turned off: ${pullRequestLabel(state.pullRequestUrl)} was closed`,
          );
        }
        return false;
      case "pause":
        yield* repository.upsert({
          ...state,
          status: "paused",
          pauseReason: decision.reason,
          updatedAt: new Date().toISOString(),
        });
        yield* appendActivity(
          state.threadId,
          "paused",
          `Auto-fix CI paused on ${pullRequestLabel(state.pullRequestUrl)}: ${PAUSE_SUMMARIES[decision.reason]}`,
        );
        return false;
      case "update":
        yield* repository.upsert({
          ...state,
          status: decision.status,
          attempts: decision.attempts,
          updatedAt: new Date().toISOString(),
        });
        return false;
      case "fix":
        if (!observed || !thread) return false;
        yield* startFixTurn({ state, thread, decision, prNumber: observed.summary.number });
        return true;
    }
  });

  // Every watched PR of a chat is checked each poll, but a chat runs one turn at a time:
  // once a fix starts, the rest wait for the next poll (the chat is busy until it ends).
  const pollThread = Effect.fnUntraced(function* (
    threadId: ThreadId,
    states: ReadonlyArray<PullRequestAutoFixState>,
  ) {
    const thread = Option.getOrNull(yield* snapshotQuery.getThreadShellById(threadId));
    // A busy chat is skipped before touching git or GitHub: nothing can start until it idles.
    if (thread && thread.archivedAt == null && isThreadBusyForAutoFix(thread)) return;
    const cwd = thread ? yield* resolveThreadCwd(thread) : null;
    if (thread && !cwd) return;
    const checkout = cwd ? yield* readCheckout(cwd) : null;

    for (const state of states) {
      const started = yield* pollPullRequest({ state, thread, cwd, checkout }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("auto-fix CI poll failed", {
            threadId,
            pullRequestUrl: state.pullRequestUrl,
            cause: Cause.pretty(cause),
          }).pipe(Effect.as(false)),
        ),
      );
      if (started) return;
    }
  });

  const pollAll = repository.listActive().pipe(
    Effect.flatMap((states) => {
      const byThread = new Map<ThreadId, PullRequestAutoFixState[]>();
      for (const state of states) {
        const group = byThread.get(state.threadId);
        if (group) group.push(state);
        else byThread.set(state.threadId, [state]);
      }
      return Effect.forEach(
        byThread,
        ([threadId, group]) =>
          pollThread(threadId, group).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("auto-fix CI poll failed", {
                threadId,
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        { concurrency: PULL_REQUEST_AUTO_FIX_THREAD_CONCURRENCY, discard: true },
      );
    }),
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
