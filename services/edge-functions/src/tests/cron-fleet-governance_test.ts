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
