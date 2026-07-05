// US-1593: Sentinel incident correlation. sentinel.ts is pure (no imports) so
// no env/DB dance. Proves N related failures collapse to ONE incident.
import { assert, assertEquals } from "@std/assert";
import { correlateIncidents, type Signal } from "../lib/sentinel.ts";

const T0 = Date.parse("2026-07-05T12:00:00.000Z");
function at(mins: number): string {
  return new Date(T0 + mins * 60_000).toISOString();
}

// ── The core AC: N related → ONE incident ────────────────────────────────────

Deno.test("correlateIncidents: N related failures (same subsystem, same window) → ONE incident", () => {
  const signals: Signal[] = [
    { subsystem: "reprice-scan", kind: "cron_failure", ref: "reprice-scan", at: at(0) },
    { subsystem: "reprice-scan", kind: "cron_failure", ref: "reprice-scan", at: at(2) },
    { subsystem: "reprice-scan", kind: "cron_failure", ref: "reprice-scan", at: at(5) },
    { subsystem: "reprice-scan", kind: "cron_failure", ref: "reprice-scan", at: at(9) },
  ];
  const incidents = correlateIncidents(signals);
  assertEquals(incidents.length, 1);
  assertEquals(incidents[0].subsystem, "reprice-scan");
  assertEquals(incidents[0].count, 4);
  assert(incidents[0].rootCauseHypothesis.includes("reprice-scan"));
});

Deno.test("correlateIncidents: unrelated failures (different subsystems) → separate incidents", () => {
  const signals: Signal[] = [
    { subsystem: "reprice-scan", kind: "cron_failure", ref: "reprice-scan", at: at(0) },
    { subsystem: "email:stripe", kind: "dead_letter", ref: "d1", at: at(1) },
    { subsystem: "grading-monitor", kind: "cron_failure", ref: "grading-monitor", at: at(2) },
  ];
  const incidents = correlateIncidents(signals);
  assertEquals(incidents.length, 3);
});

Deno.test("correlateIncidents: a large time gap in one subsystem splits into two incidents", () => {
  const signals: Signal[] = [
    { subsystem: "reprice-scan", kind: "cron_failure", ref: "reprice-scan", at: at(0) },
    { subsystem: "reprice-scan", kind: "cron_failure", ref: "reprice-scan", at: at(5) },
    // 90 min later — a separate episode.
    { subsystem: "reprice-scan", kind: "cron_failure", ref: "reprice-scan", at: at(95) },
  ];
  const incidents = correlateIncidents(signals, 30 * 60_000);
  assertEquals(incidents.length, 2);
  // Most-signals-first.
  assertEquals(incidents[0].count, 2);
  assertEquals(incidents[1].count, 1);
});

Deno.test("correlateIncidents: mixed kinds in one subsystem correlate together", () => {
  const signals: Signal[] = [
    { subsystem: "email:stripe", kind: "dead_letter", ref: "d1", at: at(0) },
    { subsystem: "email:stripe", kind: "ops_event", ref: "e1", at: at(3) },
  ];
  const incidents = correlateIncidents(signals);
  assertEquals(incidents.length, 1);
  assertEquals(incidents[0].kinds, ["dead_letter", "ops_event"]);
  assertEquals(incidents[0].count, 2);
});

Deno.test("correlateIncidents: empty in, empty out (the healthy no-op path)", () => {
  assertEquals(correlateIncidents([]), []);
});
