import type {
  PullRequestAutoFixGetInput,
  PullRequestAutoFixResult,
  PullRequestAutoFixSetInput,
} from "@synara/contracts";
import { Schema, ServiceMap } from "effect";
import type { Effect } from "effect";

export class PullRequestAutoFixError extends Schema.TaggedErrorClass<PullRequestAutoFixError>()(
  "PullRequestAutoFixError",
  { message: Schema.String },
) {}

/**
 * Auto-fix CI (Beta-only): the per-thread switch behind the Environment panel's PR menu.
 * The live layer also runs the watcher that polls each watched PR's checks and starts a
 * fix turn on the thread when they fail.
 */
export interface PullRequestAutoFixServiceShape {
  readonly get: (
    input: PullRequestAutoFixGetInput,
  ) => Effect.Effect<PullRequestAutoFixResult, PullRequestAutoFixError>;
  readonly set: (
    input: PullRequestAutoFixSetInput,
  ) => Effect.Effect<PullRequestAutoFixResult, PullRequestAutoFixError>;
}

export class PullRequestAutoFixService extends ServiceMap.Service<
  PullRequestAutoFixService,
  PullRequestAutoFixServiceShape
>()("synara/pullRequestAutoFix/Services/PullRequestAutoFixService/PullRequestAutoFixService") {}
