// US-2318 AC3: "a test with a synthetic ledger where a daily job's last run is
// older than the window."
//
// This could not be written before, and the reason is the point: the reduce and
// the back-fill lived inline in `GET /admin-jobs/crons`, reading `supabaseAdmin`
// directly. There was no seam to hand a fixture to, so the only way to exercise
// the defect was to have a real ledger with fourteen hours of history in it.
//
// The defect: a fixed 2,000-row window is ~14 hours at the current fleet
// cadence, so every daily job fell outside it and rendered as never-run —
// identical to never-configured, on exactly the jobs an operator most needs to
// check (trial-expiry, data-retention, guarantee-pool, billing-reconciliation).
import { assertEquals } from "@std/assert";
import {
  type CronRunRow,
  resolveLatestRuns,
} from "../lib/cron-latest-runs.ts";

const row = (
  job_name: string,
  created_at: string,
  status = "ok",
): CronRunRow => ({
  job_name,
  status,
  http_status: 200,
  duration_ms: 12,
  created_at,
});

Deno.test("US-2318: a daily job older than the window is still found", async () => {
  // The exact shape of the bug. The window holds only the busy */5 jobs; the
  // daily one ran 20 hours ago and is nowhere in it.
  const windowRows = [
    row("reprice-scan", "2026-08-02T20:00:00Z"),
    row("reprice-scan", "2026-08-02T19:55:00Z"),
    row("ebay-sync", "2026-08-02T19:50:00Z"),
  ];
  const asked: string[] = [];
  const latest = await resolveLatestRuns(
    windowRows,
    ["reprice-scan", "ebay-sync", "trial-expiry"],
    (name) => {
      asked.push(name);
      return Promise.resolve(
        name === "trial-expiry"
          ? row("trial-expiry", "2026-08-02T00:15:00Z")
          : null,
      );
    },
  );
  assertEquals(latest.get("trial-expiry")?.created_at, "2026-08-02T00:15:00Z");
  // ONLY the miss is asked for. Asking for jobs already in the window would
  // make this N queries per dashboard load instead of "the daily ones".
  assertEquals(asked, ["trial-expiry"]);
});

Deno.test("US-2318 AC2: never-recorded stays distinguishable from stale", async () => {
  // The half that is easy to lose while fixing the other. A job with no runs at
  // all must be ABSENT from the map, not present with a placeholder — otherwise
  // "never configured" and "ran a while ago" render identically again, which is
  // the original complaint pointed the other way.
  const latest = await resolveLatestRuns(
    [],
    ["never-ran"],
    () => Promise.resolve(null),
  );
  assertEquals(latest.has("never-ran"), false);
});

Deno.test("US-2318: the window wins, and only its FIRST row per job", async () => {
  // The reduce keeps the newest row and must not be re-queried. If the window
  // already answered, the back-fill must not fire — that is what keeps this
  // cheap on a healthy fleet.
  const windowRows = [
    row("daily-job", "2026-08-02T04:00:00Z"),
    row("daily-job", "2026-08-01T04:00:00Z"),
  ];
  let called = 0;
  const latest = await resolveLatestRuns(windowRows, ["daily-job"], () => {
    called++;
    return Promise.resolve(null);
  });
  assertEquals(latest.get("daily-job")?.created_at, "2026-08-02T04:00:00Z");
  assertEquals(called, 0);
});

Deno.test("US-2318: an empty expected list does nothing", async () => {
  const latest = await resolveLatestRuns([row("a", "2026-08-02T00:00:00Z")], [], () => {
    throw new Error("must not be called");
  });
  assertEquals(latest.size, 1);
});

Deno.test("US-2318: the answer does not depend on window SIZE", async () => {
  // The property the whole fix exists for. The old code's answer for a daily
  // job changed when an unrelated */5 job was added, because that shortened the
  // window. Here the same daily job resolves identically whether the window is
  // nearly empty or full of noise from other jobs.
  const noise = Array.from({ length: 50 }, (_, i) =>
    row("busy-job", `2026-08-02T20:${String(i).padStart(2, "0")}:00Z`));
  const fetchOne = (name: string) =>
    Promise.resolve(name === "daily-job" ? row("daily-job", "2026-08-01T04:00:00Z") : null);

  const small = await resolveLatestRuns([], ["daily-job"], fetchOne);
  const large = await resolveLatestRuns(noise, ["busy-job", "daily-job"], fetchOne);

  assertEquals(
    small.get("daily-job")?.created_at,
    large.get("daily-job")?.created_at,
    "the daily job's answer moved when unrelated fleet noise was added",
  );
});
