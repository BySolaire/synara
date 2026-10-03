import { PullRequestAutoFixState } from "@synara/contracts";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlOrDecodeError } from "../Errors.ts";
import {
  PullRequestAutoFixRepository,
  type PullRequestAutoFixRepositoryShape,
  PullRequestAutoFixThreadInput,
} from "../Services/PullRequestAutoFixRepository.ts";

const makePullRequestAutoFixRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const getRow = SqlSchema.findOneOption({
    Request: PullRequestAutoFixThreadInput,
    Result: PullRequestAutoFixState,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        pull_request_url AS "pullRequestUrl",
        status AS "status",
        pause_reason AS "pauseReason",
        attempts AS "attempts",
        last_handled_head_sha AS "lastHandledHeadSha",
        updated_at AS "updatedAt"
      FROM pull_request_auto_fix
      WHERE thread_id = ${threadId}
    `,
  });

  const listActiveRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: PullRequestAutoFixState,
    execute: () => sql`
      SELECT
        thread_id AS "threadId",
        pull_request_url AS "pullRequestUrl",
        status AS "status",
        pause_reason AS "pauseReason",
        attempts AS "attempts",
        last_handled_head_sha AS "lastHandledHeadSha",
        updated_at AS "updatedAt"
      FROM pull_request_auto_fix
      WHERE status <> 'paused'
      ORDER BY thread_id ASC
    `,
  });

  const upsertRow = SqlSchema.void({
    Request: PullRequestAutoFixState,
    execute: (state) => sql`
      INSERT INTO pull_request_auto_fix (
        thread_id,
        pull_request_url,
        status,
        pause_reason,
        attempts,
        last_handled_head_sha,
        updated_at
      )
      VALUES (
        ${state.threadId},
        ${state.pullRequestUrl},
        ${state.status},
        ${state.pauseReason},
        ${state.attempts},
        ${state.lastHandledHeadSha},
        ${state.updatedAt}
      )
      ON CONFLICT (thread_id) DO UPDATE SET
        pull_request_url = excluded.pull_request_url,
        status = excluded.status,
        pause_reason = excluded.pause_reason,
        attempts = excluded.attempts,
        last_handled_head_sha = excluded.last_handled_head_sha,
        updated_at = excluded.updated_at
    `,
  });

  const deleteRow = SqlSchema.void({
    Request: PullRequestAutoFixThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM pull_request_auto_fix
      WHERE thread_id = ${threadId}
    `,
  });

  const get: PullRequestAutoFixRepositoryShape["get"] = (input) =>
    getRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PullRequestAutoFixRepository.get:query",
          "PullRequestAutoFixRepository.get:decodeRow",
        ),
      ),
    );

  const listActive: PullRequestAutoFixRepositoryShape["listActive"] = () =>
    listActiveRows(undefined).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PullRequestAutoFixRepository.listActive:query",
          "PullRequestAutoFixRepository.listActive:decodeRows",
        ),
      ),
    );

  const upsert: PullRequestAutoFixRepositoryShape["upsert"] = (state) =>
    upsertRow(state).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PullRequestAutoFixRepository.upsert:query",
          "PullRequestAutoFixRepository.upsert:encodeRequest",
        ),
      ),
    );

  const deleteState: PullRequestAutoFixRepositoryShape["delete"] = (input) =>
    deleteRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "PullRequestAutoFixRepository.delete:query",
          "PullRequestAutoFixRepository.delete:encodeRequest",
        ),
      ),
    );

  return {
    get,
    listActive,
    upsert,
    delete: deleteState,
  } satisfies PullRequestAutoFixRepositoryShape;
});

export const PullRequestAutoFixRepositoryLive = Layer.effect(
  PullRequestAutoFixRepository,
  makePullRequestAutoFixRepository,
);
