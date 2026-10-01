import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SaveInboxRecapRequest } from "@synara/contracts";
import { createAccountInboxReporter } from "./accountInboxReporter";
import { writeAccountCredentials } from "./accountAuth";
import { isServerBetaFeatureEnabled } from "./betaFeatureGate";
import { makeRecapStatsQuery } from "./recapStats";
import { SqlitePersistenceMemory } from "./persistence/Layers/Sqlite";

vi.mock("./betaFeatureGate", () => ({ isServerBetaFeatureEnabled: vi.fn(() => true) }));

const account = {
  accountUrl: "https://account.example.test",
  workosClientId: "client_test",
  workosApiUrl: "https://identity.example.test",
  userId: "user_1",
  organizationId: "org_1",
  hostId: "00000000-0000-4000-8000-000000000001",
  hostOwnerUserId: "user_1",
  hostKeyGeneration: 1,
  accessToken: "test-access",
  refreshToken: "test-refresh",
};
const now = new Date(2026, 9, 3, 12).getTime();
const stamp = (day: number) => new Date(2026, 9, day, 8).toISOString();
const homes: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.mocked(isServerBetaFeatureEnabled).mockReturnValue(true);
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true });
});

function run(effect: Effect.Effect<void, unknown, SqlClient.SqlClient>) {
  return effect.pipe(
    Effect.provide(SqlitePersistenceMemory.pipe(Layer.provide(NodeServices.layer))),
    Effect.scoped,
    Effect.runPromise,
  );
}

async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "synara-inbox-auto-"));
  homes.push(home);
  await writeAccountCredentials(home, account);
  const pushes: SaveInboxRecapRequest[] = [];
  let failDay: string | undefined;
  let failureStatus = 503;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/me"))
      return Response.json({
        id: "user_1",
        name: "Test",
        email: "test@example.test",
        organization: { id: "org_1", name: "Test" },
      });
    expect(url).toBe(`${account.accountUrl}/api/v1/inbox/recaps/sync`);
    expect(init?.method).toBe("POST");
    const request = Schema.decodeUnknownSync(SaveInboxRecapRequest)(JSON.parse(String(init?.body)));
    pushes.push(request);
    if (request.day === failDay)
      return Response.json(
        { error: { code: "internal_error", message: "offline" } },
        { status: failureStatus },
      );
    return new Response(null, { status: 204 });
  });
  vi.stubGlobal("fetch", fetch);
  vi.spyOn(Date, "now").mockReturnValue(now);
  return {
    home,
    pushes,
    fetch,
    fail(day?: string, status = 503) {
      failDay = day;
      failureStatus = status;
    },
  };
}

describe("automatic private Inbox history", () => {
  it.each([503, 200])(
    "catches up after restart without advancing on a failed or unacknowledged save (%i)",
    async (status) => {
      const f = await fixture();
      await run(
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES
        ('one', ${stamp(1)}), ('two', ${stamp(2)}), ('three', ${stamp(3)})`;
          const recapQuery = yield* makeRecapStatsQuery();
          const options = { baseDir: f.home, sql, recapQuery };
          const first = createAccountInboxReporter(options);
          f.fail("2026-10-02", status);
          yield* Effect.promise(() => first.flushNow());
          first.stop();
          expect(f.pushes.map((p) => p.day)).toEqual(["2026-10-03", "2026-10-01", "2026-10-02"]);
          expect(f.pushes.map((p) => p.recap.totals.prompts)).toEqual([1, 1, 1]);
          const [file] = yield* Effect.promise(() => readdir(join(f.home, "inbox-sync")));
          expect(
            JSON.parse(
              yield* Effect.promise(() => readFile(join(f.home, "inbox-sync", file!), "utf8")),
            ),
          ).toBe(new Date(2026, 9, 2, 4).getTime());
          f.fail();
          const restarted = createAccountInboxReporter(options);
          yield* Effect.promise(() => restarted.flushNow());
          expect(f.pushes.map((p) => p.day)).toEqual([
            "2026-10-03",
            "2026-10-01",
            "2026-10-02",
            "2026-10-03",
            "2026-10-02",
          ]);
          // Unchanged live data is not uploaded twice, but a new prompt updates the same day.
          yield* Effect.promise(() => restarted.flushNow());
          expect(f.pushes).toHaveLength(5);
          yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES ('four', ${stamp(3)})`;
          yield* Effect.promise(() => restarted.flushNow());
          expect(f.pushes.at(-1)?.recap.totals.prompts).toBe(2);
          vi.mocked(Date.now).mockReturnValue(new Date(2026, 9, 4, 12).getTime());
          yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES ('next', ${stamp(4)})`;
          yield* Effect.promise(() => restarted.flushNow());
          restarted.stop();
          expect(f.pushes.slice(-2).map((p) => p.day)).toEqual(["2026-10-04", "2026-10-03"]);
          expect(f.pushes.at(-1)?.recap.totals.prompts).toBe(2);
        }),
      );
    },
  );

  it("runs without a UI, remains inert on Stable or signed out, and stops its timer", async () => {
    const f = await fixture();
    await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES ('one', ${stamp(3)})`;
        const recapQuery = yield* makeRecapStatsQuery();
        vi.useFakeTimers();
        vi.setSystemTime(now);
        const reporter = createAccountInboxReporter({ baseDir: f.home, sql, recapQuery });
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(5_000));
        // Wait for the timer's own upload before joining it; a manual flush must
        // not make this test pass if automatic scheduling is accidentally removed.
        yield* Effect.promise(() => vi.waitFor(() => expect(f.pushes).toHaveLength(1)));
        yield* Effect.promise(() => reporter.flushNow());
        expect(f.pushes).toHaveLength(1);
        vi.mocked(isServerBetaFeatureEnabled).mockReturnValue(false);
        yield* sql`INSERT INTO profile_stats_deleted_prompts (thread_id, created_at) VALUES ('two', ${stamp(3)})`;
        yield* Effect.promise(() => reporter.flushNow());
        expect(f.pushes).toHaveLength(1);
        vi.mocked(isServerBetaFeatureEnabled).mockReturnValue(true);
        const { accessToken: _accessToken, refreshToken: _refreshToken, ...signedOut } = account;
        yield* Effect.promise(() => writeAccountCredentials(f.home, signedOut));
        yield* Effect.promise(() => reporter.flushNow());
        expect(f.pushes).toHaveLength(1);
        reporter.stop();
        yield* Effect.promise(() => vi.advanceTimersByTimeAsync(120_000));
        expect(f.pushes).toHaveLength(1);
      }),
    );
  });
});
