import { ThreadId, type PullRequestAutoFixState } from "@synara/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { PullRequestAutoFixRepository } from "../Services/PullRequestAutoFixRepository";
import { PullRequestAutoFixRepositoryLive } from "./PullRequestAutoFixRepository";
import { SqlitePersistenceMemory } from "./Sqlite";

const layer = it.layer(
  PullRequestAutoFixRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

function state(
  threadId: string,
  overrides: Partial<PullRequestAutoFixState> = {},
): PullRequestAutoFixState {
  return {
    threadId: ThreadId.makeUnsafe(threadId),
    pullRequestUrl: "https://github.com/o/r/pull/1",
    status: "watching",
    pauseReason: null,
    attempts: 0,
    lastHandledHeadSha: null,
    updatedAt: "2026-10-03T10:00:00.000Z",
    ...overrides,
  };
}

layer("PullRequestAutoFixRepository", (it) => {
  it.effect("round-trips, updates in place, lists only active rows, and deletes", () =>
    Effect.gen(function* () {
      const repository = yield* PullRequestAutoFixRepository;
      const threadId = ThreadId.makeUnsafe("thread-a");

      assert.isTrue(Option.isNone(yield* repository.get({ threadId })));

      yield* repository.upsert(state("thread-a"));
      yield* repository.upsert(
        state("thread-b", { status: "paused", pauseReason: "attempt-limit", attempts: 3 }),
      );
      yield* repository.upsert(
        state("thread-a", { status: "fixing", attempts: 1, lastHandledHeadSha: "abc123" }),
      );

      assert.deepStrictEqual(
        yield* repository.get({ threadId }),
        Option.some(
          state("thread-a", { status: "fixing", attempts: 1, lastHandledHeadSha: "abc123" }),
        ),
      );
      assert.deepStrictEqual(
        (yield* repository.listActive()).map((row) => row.threadId),
        [threadId],
      );

      yield* repository.delete({ threadId });
      assert.isTrue(Option.isNone(yield* repository.get({ threadId })));
    }),
  );
});
