import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

// Additive: Stable never reads this table (Auto-fix CI is Beta-only). One row per watched
// pull request of a chat, so a chat can watch every PR of a stack.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS pull_request_auto_fix (
      thread_id TEXT NOT NULL,
      pull_request_url TEXT NOT NULL,
      status TEXT NOT NULL,
      pause_reason TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      last_handled_head_sha TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, pull_request_url)
    )
  `;
});
