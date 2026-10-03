/**
 * Durable per-thread "Auto-fix CI" state. A row exists only while auto-fix is on for
 * the thread; turning it off deletes the row.
 */
import { PullRequestAutoFixState, ThreadId } from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect, Option } from "effect";

import type { PersistenceDecodeError, PersistenceSqlError } from "../Errors.ts";

export type PullRequestAutoFixRepositoryError = PersistenceSqlError | PersistenceDecodeError;

export const PullRequestAutoFixThreadInput = Schema.Struct({ threadId: ThreadId });
export type PullRequestAutoFixThreadInput = typeof PullRequestAutoFixThreadInput.Type;

export interface PullRequestAutoFixRepositoryShape {
  readonly get: (
    input: PullRequestAutoFixThreadInput,
  ) => Effect.Effect<Option.Option<PullRequestAutoFixState>, PullRequestAutoFixRepositoryError>;

  /** Rows the watcher should poll: everything not paused. */
  readonly listActive: () => Effect.Effect<
    ReadonlyArray<PullRequestAutoFixState>,
    PullRequestAutoFixRepositoryError
  >;

  readonly upsert: (
    state: PullRequestAutoFixState,
  ) => Effect.Effect<void, PullRequestAutoFixRepositoryError>;

  readonly delete: (
    input: PullRequestAutoFixThreadInput,
  ) => Effect.Effect<void, PullRequestAutoFixRepositoryError>;
}

export class PullRequestAutoFixRepository extends ServiceMap.Service<
  PullRequestAutoFixRepository,
  PullRequestAutoFixRepositoryShape
>()("synara/persistence/Services/PullRequestAutoFixRepository/PullRequestAutoFixRepository") {}
