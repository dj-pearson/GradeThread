// US-2004 — the re-alert suppression rule for cron-fleet stall alerting.
//
// Suppression is the part of this job most likely to be wrong, and its failure
// direction is SILENT: too aggressive and a new stall never reaches anyone,
// which reproduces the exact invisibility the job was built to end. Too lax and
// the channel becomes noise and gets ignored, which produces the same outcome by
// a different route. So the rule is pure and pinned here.

import { assert, assertEquals } from "@std/assert";

// jobs-cron-fleet.ts pulls in the service-role client at module load, so set
// dummy env BEFORE the dynamic import (same pattern as item-photo-storage_test).
// Otherwise this file only passes when an earlier suite file happened to set it.
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { shouldAlert } = await import("../routes/jobs-cron-fleet.ts");

const NOW = 1_800_000_000_000;
const HOUR = 3600_000;

Deno.test("a healthy fleet never alerts", () => {
  assertEquals(
    shouldAlert({ stalledNames: [], lastAlert: null, nowMs: NOW }),
    false,
  );
  // Not even if we alerted recently — recovery is not an event to re-announce.
  assertEquals(
    shouldAlert({
      stalledNames: [],
      lastAlert: { atMs: NOW - HOUR, jobs: ["consignor-payouts"] },
      nowMs: NOW,
    }),
    false,
  );
});

Deno.test("a first stall always alerts", () => {
  assertEquals(
    shouldAlert({ stalledNames: ["data-retention"], lastAlert: null, nowMs: NOW }),
    true,
  );
});

Deno.test("the SAME stall inside the window stays quiet", () => {
  // A stall persists until a human fixes it. Re-alerting hourly is how an alert
  // channel becomes background noise.
  assertEquals(
    shouldAlert({
      stalledNames: ["data-retention"],
      lastAlert: { atMs: NOW - HOUR, jobs: ["data-retention"] },
      nowMs: NOW,
    }),
    false,
  );
  // A subset is still "nothing new" — one of two known stalls recovering does
  // not warrant a page.
  assertEquals(
    shouldAlert({
      stalledNames: ["data-retention"],
      lastAlert: { atMs: NOW - HOUR, jobs: ["data-retention", "affiliate-payouts"] },
      nowMs: NOW,
    }),
    false,
  );
});

Deno.test("A NEW stall during an open incident DOES alert", () => {
  // The load-bearing case. Suppressing on "something is already stalled" would
  // hide every subsequent failure precisely when failures matter most — e.g.
  // consignor-payouts dying while data-retention was already known-stalled.
  assertEquals(
    shouldAlert({
      stalledNames: ["data-retention", "consignor-payouts"],
      lastAlert: { atMs: NOW - HOUR, jobs: ["data-retention"] },
      nowMs: NOW,
    }),
    true,
  );
  // Even a completely different job, one minute later.
  assertEquals(
    shouldAlert({
      stalledNames: ["stuck-submissions"],
      lastAlert: { atMs: NOW - 60_000, jobs: ["data-retention"] },
      nowMs: NOW,
    }),
    true,
  );
});

Deno.test("an unfixed stall re-alerts once the window expires", () => {
  // Silence forever would be indistinguishable from "resolved". After the
  // window, the same stall speaks up again.
  assertEquals(
    shouldAlert({
      stalledNames: ["data-retention"],
      lastAlert: { atMs: NOW - 7 * HOUR, jobs: ["data-retention"] },
      nowMs: NOW,
    }),
    true,
  );
  // Boundary: exactly at the window edge is outside it (>= suppressMs).
  assertEquals(
    shouldAlert({
      stalledNames: ["x"],
      lastAlert: { atMs: NOW - 2 * HOUR, jobs: ["x"] },
      nowMs: NOW,
      suppressMs: 2 * HOUR,
    }),
    true,
  );
  assertEquals(
    shouldAlert({
      stalledNames: ["x"],
      lastAlert: { atMs: NOW - 2 * HOUR + 1, jobs: ["x"] },
      nowMs: NOW,
      suppressMs: 2 * HOUR,
    }),
    false,
  );
});

Deno.test("a prior alert with no recorded job list is treated as unknown, so we alert", () => {
  // Defensive: if the payload shape ever changes and `jobs` comes back empty,
  // fail toward NOTIFYING rather than toward silence.
  assertEquals(
    shouldAlert({
      stalledNames: ["data-retention"],
      lastAlert: { atMs: NOW - HOUR, jobs: [] },
      nowMs: NOW,
    }),
    true,
  );
});

// ── US-2004 AC2/AC3: the detector against the REAL registry ─────────
//
// AC2 says "a stall detector that has never detected a stall is not known to
// work" and asks for a live disable/re-enable in Coolify. That needs the UI and
// a configured alert channel. What CAN be proven here — and is the half that
// actually rots — is that the detector fires against the REAL CRON_REGISTRY
// under the exact failure mode LAUNCH_CHECKLIST.md documents: curl missing from
// the container, so EVERY task silently no-ops and cron_runs stays empty for
// every job.
//
// These use the real registry on purpose. A synthetic fixture would pass
// forever while someone flipped a money job to recorded:false and quietly
// removed it from monitoring.

const { assembleCronFleetReport } = await import("../lib/cron-fleet-governance.ts");
const { CRON_REGISTRY } = await import("../lib/cron-runs.ts");

// A week of nothing — every recorded job has missed every tick.
function deadFleetReport() {
  const nowMs = Date.parse("2026-07-19T12:00:00.000Z");
  return assembleCronFleetReport({
    registry: CRON_REGISTRY,
    runsByJob: {},
    maintenance: [],
    nowMs,
    lookbackMs: 7 * 24 * 60 * 60 * 1000,
  });
}

Deno.test("US-2004: a totally dead fleet is detected, not reported all-clear", () => {
  const report = deadFleetReport();
  assertEquals(report.all_clear, false);
  assert(report.stalled.length > 0, "a fleet with zero runs must report stalls");
  // The documented failure mode takes out EVERY task at once, so this should be
  // most of the recorded fleet — not one or two jobs.
  const recorded = CRON_REGISTRY.filter((j) => j.recorded).length;
  assert(
    report.stalled.length >= Math.floor(recorded / 2),
    `expected most of ${recorded} recorded jobs stalled, got ${report.stalled.length}`,
  );
});

// AC3 names these four specifically, and each has a concrete consequence:
// consignor-payouts / affiliate-payouts → sellers and affiliates silently
// unpaid; stuck-submissions → the auto-refund path INCIDENT_RESPONSE.md depends
// on (and the recursive failure: if it dies, users are charged for grades that
// never complete AND the remediation for that incident is the dead cron);
// data-retention → the GDPR storage-limitation control.
Deno.test("US-2004 AC3: the money and compliance crons are covered by name", () => {
  const stalled = new Set(deadFleetReport().stalled.map((s) => s.name));
  for (const name of [
    "consignor-payouts",
    "affiliate-payouts",
    "stuck-submissions",
    "data-retention",
  ]) {
    assert(
      stalled.has(name),
      `${name} must be monitored — if it is missing, check it is still recorded:true in CRON_REGISTRY`,
    );
  }
});

// The end-to-end wiring question: a detected stall must actually reach the
// alert decision. shouldAlert is tested above in isolation; this pins that the
// report the ROUTE builds feeds it a non-empty job list.
Deno.test("US-2004: a dead fleet's report drives shouldAlert to true", () => {
  const stalledNames = deadFleetReport().stalled.map((s) => s.name);
  assertEquals(
    shouldAlert({ stalledNames, lastAlert: null, nowMs: Date.now() }),
    true,
    "a dead fleet with no prior alert must alert",
  );
});
