// US-1611: cron-fleet governance pure logic — expected ticks, missed-tick
// detection (incl. maintenance suppression), duration creep, and the fleet
// report. Imports cron-runs.ts (nextCronRun) which pulls supabase.ts; prime env.
import { assert, assertEquals } from "@std/assert";


Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
const {
  assembleCronFleetReport,
  detectDurationCreep,
  detectMissedTicks,
  expectedTicks,
  inMaintenance,
} = await import("../lib/cron-fleet-governance.ts");

const HOUR = 3600_000;
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);
const { CRON_REGISTRY } = await import("../lib/cron-runs.ts");

const NOW = Date.parse("2026-07-05T12:00:00.000Z");

// ── Expected ticks ───────────────────────────────────────────────────────────

Deno.test("expectedTicks: enumerates an hourly schedule across a window", () => {
  const { ticks, capped } = expectedTicks("0 * * * *", NOW - 3 * HOUR, NOW);
  // 09:00, 10:00, 11:00, 12:00 are in (09:00, 12:00] → 10,11,12 (09:00 excluded as == from)
  assertEquals(capped, false);
  assert(ticks.length >= 3);
  for (const t of ticks) assertEquals(new Date(t).getUTCMinutes(), 0);
});

// ── Missed-tick detection ────────────────────────────────────────────────────

Deno.test("detectMissedTicks: no runs → every fully-elapsed hourly slot missed", () => {
  const r = detectMissedTicks({ schedule: "0 * * * *", runMs: [], nowMs: NOW, lookbackMs: 5 * HOUR });
  assert(r.missed >= 3);
  assertEquals(r.suppressed, 0);
  assertEquals(r.consecutive_missed, r.missed); // all trailing
  assertEquals(r.last_run_ms, null);
});

Deno.test("detectMissedTicks: a run inside each slot → nothing missed", () => {
  // Put a run 5 min into each of the last several hours.
  const runs: number[] = [];
  for (let h = 1; h <= 6; h++) {
    const base = new Date(NOW - h * HOUR);
    base.setUTCMinutes(5, 0, 0);
    runs.push(base.getTime());
  }
  const r = detectMissedTicks({ schedule: "0 * * * *", runMs: runs, nowMs: NOW, lookbackMs: 5 * HOUR });
  assertEquals(r.missed, 0);
  assert(r.last_run_ms !== null);
});

Deno.test("detectMissedTicks: a maintenance window suppresses the miss in that slot", () => {
  // A window covering the 10:00–11:00 slot start suppresses that one miss.
  const winStart = Date.parse("2026-07-05T09:50:00.000Z");
  const winEnd = Date.parse("2026-07-05T10:10:00.000Z");
  const withWin = detectMissedTicks({
    schedule: "0 * * * *",
    runMs: [],
    nowMs: NOW,
    lookbackMs: 5 * HOUR,
    maintenance: [{ startMs: winStart, endMs: winEnd }],
  });
  const without = detectMissedTicks({ schedule: "0 * * * *", runMs: [], nowMs: NOW, lookbackMs: 5 * HOUR });
  assertEquals(withWin.suppressed, 1);
  assertEquals(withWin.missed, without.missed - 1);
});

Deno.test("inMaintenance: open-ended window covers everything after its start", () => {
  const w = [{ startMs: NOW - HOUR, endMs: Infinity }];
  assertEquals(inMaintenance(NOW, w), true);
  assertEquals(inMaintenance(NOW - 2 * HOUR, w), false);
});

// ── Duration creep ───────────────────────────────────────────────────────────

Deno.test("detectDurationCreep: recent half materially slower → creeping", () => {
  const d = detectDurationCreep([100, 110, 90, 100, 300, 320, 310, 305]);
  assertEquals(d.creeping, true);
  assert((d.creep_pct ?? 0) > 0.5);
});

Deno.test("detectDurationCreep: steady durations → not creeping; too few samples → inconclusive", () => {
  assertEquals(detectDurationCreep([100, 100, 100, 100, 100, 100]).creeping, false);
  assertEquals(detectDurationCreep([100, 300]).creeping, false); // < min samples
  assertEquals(detectDurationCreep([100, 300]).creep_pct, null);
});

// ── Fleet report ─────────────────────────────────────────────────────────────

Deno.test("assembleCronFleetReport: a job with no runs is stalled; a fresh one is healthy", () => {
  const registry = [
    { name: "hourly-stalled", label: "Hourly", schedule: "0 * * * *", category: "x", endpoint: "/x", recorded: true },
    { name: "hourly-ok", label: "OK", schedule: "0 * * * *", category: "x", endpoint: "/y", recorded: true },
    { name: "oneoff", label: "One-off", schedule: "0 0 * * *", category: "x", endpoint: "/z", recorded: true, oneOff: true },
  ];
  const okRuns = [];
  for (let h = 1; h <= 6; h++) {
    const b = new Date(NOW - h * HOUR);
    b.setUTCMinutes(5, 0, 0);
    okRuns.push({ created_at: new Date(b.getTime()).toISOString(), duration_ms: 100 });
  }
  const report = assembleCronFleetReport({
    registry,
    runsByJob: { "hourly-ok": okRuns },
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 5 * HOUR,
  });
  assertEquals(report.jobs_total, 2); // the one-off is excluded
  assertEquals(report.all_clear, false);
  assertEquals(report.stalled.map((s) => s.name), ["hourly-stalled"]);
  assertEquals(report.scorecards.find((s) => s.name === "hourly-ok")?.verdict, "healthy");
});

// ── US-2312: ran-but-failed / ran-but-did-nothing ───────────────────────────
//
// Before this the report could only see WHETHER a job ticked. A payout sweep
// that ran every 30 minutes and failed every transfer inside it was "healthy".

/** Six on-schedule hourly runs, so nothing is ever counted as missed. */
function onScheduleRuns(
  overrides: Partial<{ status: string; rows_processed: number }> = {},
) {
  const runs = [];
  for (let h = 1; h <= 6; h++) {
    const b = new Date(NOW - h * HOUR);
    b.setUTCMinutes(5, 0, 0);
    runs.push({
      created_at: new Date(b.getTime()).toISOString(),
      duration_ms: 100,
      ...overrides,
    });
  }
  return runs;
}

const HOURLY_REGISTRY = [
  { name: "payouts", label: "Payouts", schedule: "0 * * * *", category: "x", endpoint: "/p", recorded: true },
];

function reportFor(runs: ReturnType<typeof onScheduleRuns>) {
  return assembleCronFleetReport({
    registry: HOURLY_REGISTRY,
    runsByJob: { payouts: runs },
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 5 * HOUR,
  });
}

Deno.test("US-2312: a job that ticks on schedule but errors is 'failing', not healthy", () => {
  const report = reportFor(onScheduleRuns({ status: "error", rows_processed: 40 }));
  assertEquals(report.failing.map((s) => s.name), ["payouts"]);
  assertEquals(report.stalled.length, 0); // it IS running — that is the point
  assertEquals(report.all_clear, false);
  const card = report.scorecards[0];
  assertEquals(card.verdict, "failing");
  assertEquals(card.runs, 6);
  assertEquals(card.failed_runs, 6);
});

Deno.test("US-2312: stalled outranks failing so one incident is not reported twice", () => {
  // No runs at all → stalled. Even with error rows present in the window, a job
  // that is not running is the more urgent fact.
  const report = assembleCronFleetReport({
    registry: HOURLY_REGISTRY,
    runsByJob: {},
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 5 * HOUR,
  });
  assertEquals(report.stalled.map((s) => s.name), ["payouts"]);
  assertEquals(report.failing.length, 0);
});

Deno.test("US-2312: 'ran but did nothing' is visible without being an alert", () => {
  const report = reportFor(onScheduleRuns({ status: "success", rows_processed: 0 }));
  const card = report.scorecards[0];
  assertEquals(card.verdict, "healthy"); // idling is usually correct, not broken
  assertEquals(card.idle_runs, 6);
  assertEquals(card.all_idle, true);
  assertEquals(report.all_clear, true);
});

Deno.test("US-2312: a job doing real work is not flagged idle", () => {
  const card = reportFor(onScheduleRuns({ status: "success", rows_processed: 12 }))
    .scorecards[0];
  assertEquals(card.idle_runs, 0);
  assertEquals(card.all_idle, false);
  assertEquals(card.failed_runs, 0);
  assertEquals(card.verdict, "healthy");
});

Deno.test("US-2312 REGRESSION: runs with no outcome columns stay healthy", () => {
  // Rows written before this shipped carry neither status nor rows_processed.
  // They must not read as failures, or every fleet report backfills an incident.
  const card = reportFor(onScheduleRuns()).scorecards[0];
  assertEquals(card.verdict, "healthy");
  assertEquals(card.failed_runs, 0);
  assertEquals(card.idle_runs, 0);
  assertEquals(card.all_idle, false);
});

// ── US-2668: failure RATE, not failure count ────────────────────────────────
//
// trial-expiry, ads-sync, content-refresh and keyword-research failed on 100% of
// their runs for nine days. Every one was inside `failing` the whole time, and
// nobody escalated, because the evidence arrived as a COUNT: "7 failures in 7
// days, about once a day" reads as flaky infrastructure. They are daily crons,
// so 7 in 7 days is every run — deterministic app bugs (trial-expiry's was a
// PostgREST limit-without-order on a mutation, proven against a real schema).

/** Six on-schedule hourly runs with a per-run http_status. */
function runsWithStatuses(statuses: readonly number[]) {
  return statuses.map((http, i) => {
    const b = new Date(NOW - (statuses.length - i) * HOUR);
    b.setUTCMinutes(5, 0, 0);
    return {
      created_at: new Date(b.getTime()).toISOString(),
      duration_ms: 100,
      status: http >= 400 ? "error" : "success",
      http_status: http,
      rows_processed: 3,
    };
  });
}

function reportForStatuses(statuses: readonly number[]) {
  return assembleCronFleetReport({
    registry: HOURLY_REGISTRY,
    runsByJob: { payouts: runsWithStatuses(statuses) },
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 5 * HOUR,
  });
}

Deno.test("US-2668: a job that failed EVERY run is separated from one that failed some", () => {
  const every = reportForStatuses([500, 500, 500, 500, 500, 500]);
  assertEquals(every.always_failing.map((s) => s.name), ["payouts"]);
  const card = every.scorecards[0];
  assertEquals(card.runs, 6);
  assertEquals(card.hard_failed_runs, 6);
  assertEquals(card.hard_failure_rate, 1);
  assertEquals(card.always_failing, true);

  // One bad run in six is the same COUNT reading that hid this, and a different
  // incident: it must not reach the 100% bucket.
  const some = reportForStatuses([200, 200, 500, 200, 200, 200]);
  assertEquals(some.always_failing, []);
  assertEquals(some.scorecards[0].hard_failed_runs, 1);
  assertEquals(some.scorecards[0].hard_failure_rate, 0.1667);
  assertEquals(some.scorecards[0].always_failing, false);
});

Deno.test("US-2668: a 4xx counts, because the incident that wrote this rule WAS a 400", () => {
  // FOUND BY SABOTAGE. Every case above uses 500, so narrowing the threshold
  // from >= 400 to >= 500 left the whole file green — and trial-expiry, the
  // job whose cause this story proved, answered PGRST109 / HTTP 400. The
  // guard written for that incident had no test at the status the incident
  // actually produced.
  const report = reportForStatuses([400, 400, 400, 400, 400, 400]);
  assertEquals(report.always_failing.map((s) => s.name), ["payouts"]);
  assertEquals(report.scorecards[0].hard_failed_runs, 6);
  assertEquals(report.scorecards[0].hard_failure_rate, 1);

  // And the boundary itself: 399 is not a failure, 400 is.
  const justUnder = reportForStatuses([399, 399, 399, 399, 399, 399]);
  assertEquals(justUnder.scorecards[0].hard_failed_runs, 0);
  assertEquals(justUnder.always_failing, []);
});

Deno.test("US-2668: MOST is not EVERY — a majority failure stays out of the 100% bucket", () => {
  // ALSO FOUND BY SABOTAGE. The cases above test 1-of-6 and 6-of-6, and
  // nothing sat between them, so replacing `=== runs.length` with
  // `> runs.length / 2` stayed green. That mutation is the story's own
  // failure mode running backwards: a job failing four times in six is bad
  // luck or a partial outage, and escalating it as a deterministic bug is
  // how the 100% signal stops meaning anything.
  const most = reportForStatuses([500, 500, 500, 500, 200, 200]);
  assertEquals(most.scorecards[0].hard_failed_runs, 4);
  assertEquals(most.scorecards[0].hard_failure_rate, 0.6667);
  assertEquals(most.always_failing, [], "4 of 6 is not every run");
  // Still `failing`, so the existing warning keeps covering it — the subset
  // rule this file already asserts.
  assertEquals(most.failing.map((s) => s.name), ["payouts"]);

  // One short of every run is the tightest case, and the one a boundary
  // slip would land on first.
  const allButOne = reportForStatuses([500, 500, 500, 500, 500, 200]);
  assertEquals(allButOne.scorecards[0].hard_failed_runs, 5);
  assertEquals(allButOne.always_failing, [], "5 of 6 is still not every run");
});

Deno.test("US-2668: always_failing stays a SUBSET of failing, so nothing loses its existing alert", () => {
  const report = reportForStatuses([502, 502, 502, 502, 502, 502]);
  assertEquals(report.failing.map((s) => s.name), ["payouts"]);
  assertEquals(report.scorecards[0].verdict, "failing", "not a new verdict — a reading of the same one");
  assert(
    report.failing.some((s) => s.name === report.always_failing[0].name),
    "every always_failing job must also be in failing",
  );
});

Deno.test("US-2668: a sweep that reports failed UNITS on every run is not 'always failing'", () => {
  // The false alarm this signal has to avoid. affiliate-payouts answers 200 with
  // `{failed: 1}` while one Connect account stays broken; cronRunStatusFor makes
  // that an `error` row on every run, forever. It is a real problem and it is
  // already covered at warning — waking someone at critical every six hours for
  // it is how an alert channel dies.
  const report = reportForStatuses([200, 200, 200, 200, 200, 200]);
  const withBodyFailures = assembleCronFleetReport({
    registry: HOURLY_REGISTRY,
    runsByJob: {
      payouts: runsWithStatuses([200, 200, 200, 200, 200, 200]).map((r) => ({ ...r, status: "error" })),
    },
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 5 * HOUR,
  });
  assertEquals(report.always_failing, []);
  assertEquals(withBodyFailures.failing.map((s) => s.name), ["payouts"]);
  assertEquals(withBodyFailures.always_failing, [], "2xx-with-failed-units is failing, not always_failing");
  assertEquals(withBodyFailures.scorecards[0].failure_rate, 1);
  assertEquals(withBodyFailures.scorecards[0].hard_failure_rate, 0);
});

Deno.test("US-2668 REGRESSION: runs with no http_status cannot trip the critical signal", () => {
  // Rows that never recorded a status cannot prove 100%, and this signal pages
  // someone. It fails toward silence; the warning-level `failing` still covers
  // them.
  const report = reportFor(onScheduleRuns({ status: "error", rows_processed: 4 }));
  assertEquals(report.failing.map((s) => s.name), ["payouts"]);
  assertEquals(report.always_failing, []);
  assertEquals(report.scorecards[0].hard_failed_runs, 0);
  assertEquals(report.scorecards[0].always_failing, false);
});

Deno.test("US-2668: a job with no runs has no rate at all", () => {
  // A stalled job's failure rate is undefined, not 0% and not 100%. Reporting
  // either would be a claim the data does not support.
  const report = assembleCronFleetReport({
    registry: HOURLY_REGISTRY,
    runsByJob: {},
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 5 * HOUR,
  });
  const card = report.scorecards[0];
  assertEquals(card.verdict, "stalled");
  assertEquals(card.failure_rate, null);
  assertEquals(card.hard_failure_rate, null);
  assertEquals(card.always_failing, false);
  assertEquals(report.always_failing, []);
});

Deno.test("US-2668: the summary states the RATE, so it cannot be re-read as a count", () => {
  const report = reportForStatuses([500, 500, 500, 500, 500, 500]);
  assert(
    report.summary.includes("failing on EVERY run"),
    `the summary must name the rate, got: ${report.summary}`,
  );
  assert(
    report.summary.includes("payouts (6/6)"),
    `and show the sample it is a rate over, got: ${report.summary}`,
  );
  // A healthy fleet says nothing extra.
  assert(!reportForStatuses([200, 200, 200, 200, 200, 200]).summary.includes("EVERY run"));
});

// ---------------------------------------------------------------------------
// US-2616: the report must say what it could not see.
//
// assembleCronFleetReport skips every `recorded: false` and `oneOff` entry,
// correctly — neither has a ledger cadence to check. But the summary read
// "70 recorded jobs, all ticking on schedule" while EIGHT of the seventy-eight
// registry entries were never examined, including `ebay-token-refresh` (hourly)
// and `ebay-orders-sync` (every 30 minutes). Those are jobs whose silent
// failure expires seller connections and stops orders arriving — the exact
// blast radius the fleet alert exists for.
//
// The word "recorded" was carrying the whole caveat and no reader was going to
// unpack it.

Deno.test("US-2616: unmonitored jobs are named, not silently dropped", () => {
  const report = assembleCronFleetReport({
    registry: [
      { name: "a", label: "A", schedule: "0 * * * *", category: "sync", endpoint: "/api/jobs/a", recorded: true },
      { name: "skipped-unrecorded", label: "U", schedule: "0 * * * *", category: "sync", endpoint: "/api/flipdesk/u", recorded: false },
      { name: "skipped-oneoff", label: "O", schedule: "0 4 * * *", category: "maintenance", endpoint: "/api/jobs/o", recorded: true, oneOff: true },
    ],
    runsByJob: { a: [{ created_at: new Date(NOW - 30 * 60_000).toISOString(), status: "ok", duration_ms: 100 }] },
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 2 * 3600_000,
  });

  assertEquals(report.unmonitored, ["skipped-oneoff", "skipped-unrecorded"]);
  assertEquals(report.jobs_total, 1, "jobs_total still counts only what was examined");
  assert(
    report.summary.includes("2 not monitored"),
    `the summary must state the gap, got: ${report.summary}`,
  );
  assert(report.summary.includes("skipped-unrecorded"), "and name them");
});

Deno.test("US-2616: an unmonitored job does NOT flip all_clear", () => {
  // These are the edge of what the detector can observe, not failures. Raising
  // the fleet alert on a permanent condition would train the on-call to ignore
  // it — the same reasoning as the re-alert suppression in jobs-cron-fleet.ts.
  const report = assembleCronFleetReport({
    registry: [
      { name: "a", label: "A", schedule: "0 * * * *", category: "sync", endpoint: "/api/jobs/a", recorded: true },
      { name: "u", label: "U", schedule: "0 * * * *", category: "sync", endpoint: "/api/flipdesk/u", recorded: false },
    ],
    runsByJob: { a: [{ created_at: new Date(NOW - 30 * 60_000).toISOString(), status: "ok", duration_ms: 100 }] },
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 2 * 3600_000,
  });
  assertEquals(report.all_clear, true);
  assertEquals(report.unmonitored, ["u"]);
});

Deno.test("US-2616: a fully-monitored fleet says nothing extra", () => {
  const report = assembleCronFleetReport({
    registry: [
      { name: "a", label: "A", schedule: "0 * * * *", category: "sync", endpoint: "/api/jobs/a", recorded: true },
    ],
    runsByJob: { a: [{ created_at: new Date(NOW - 30 * 60_000).toISOString(), status: "ok", duration_ms: 100 }] },
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 2 * 3600_000,
  });
  assertEquals(report.unmonitored, []);
  assert(!report.summary.includes("not monitored"), report.summary);
});

Deno.test("US-2616: the REAL registry's blind spot is enumerated, and it is now only the one-offs", () => {
  // Reads the shipped registry rather than a fixture, because the number that
  // matters is the live one.
  //
  // It began at EIGHT and is down to two, both of them permanent: a one-off
  // backfill has no cadence to miss, so it is correctly outside the monitor
  // rather than a gap. That is why this case is not deleted now the fixable
  // part is closed — it is what stops a future job being quietly parked in the
  // blind spot alongside them.
  const report = assembleCronFleetReport({
    registry: CRON_REGISTRY,
    runsByJob: {},
    maintenance: [],
    nowMs: NOW,
    lookbackMs: 3600_000,
  });
  // SHRINK-ONLY. The list is pinned by name, so closing a gap fails here and the
  // fix is to delete that entry — the same discipline as the tracked-and-ignored
  // and dead-module allowlists. Adding a name back is not how you make this pass.
  //
  // Six names came off during US-2617 — ebay-token-refresh (a recorder mount),
  // content-tick and content-digest (the same), ebay-orders-sync (deleted as a
  // duplicate), photo-archive and reconciliation-sweep (new /jobs/ routes with
  // fleet loops). This case caught every one of them: it asserts the specific
  // jobs by name, so fixing one reddens the guard rather than the guard quietly
  // continuing to pass on a smaller set.
  assertEquals(
    report.unmonitored,
    [
      "cert-integrity-backfill", // oneOff — a backfill has no cadence to miss
      "passport-backfill", // oneOff
    ],
    "the fleet monitor's blind spot changed — shrink it by fixing a job, and " +
      "delete its name here; do not add one back to make this pass",
  );
  assertEquals(
    report.jobs_total + report.unmonitored.length,
    CRON_REGISTRY.length,
    "every registry entry is either examined or named as unmonitored — no third state",
  );
});
