// Unit tests for Verified 360 evaluation (US-1281).
//
// evaluateVerified360 is pure (clock injected). No DB/env dependency — the module
// only reads optional tuning env vars that default.
//
//   deno test --allow-env src/tests/verified-360_test.ts

import { assert, assertEquals } from "@std/assert";
import {
  type Capture360Report,
  evaluateVerified360,
  verified360Boost,
  verified360MinAngles,
} from "../lib/verified-360.ts";

const NOW = Date.parse("2026-06-27T12:00:00Z");

function evalReport(optedIn: boolean, report: Capture360Report | null) {
  return evaluateVerified360({ optedIn, report, nowMs: NOW });
}

Deno.test("not opted in → never verified", () => {
  const r = evalReport(false, {
    angles: 16,
    geometric_coverage: 0.99,
    depth_available: true,
    capture_complete: true,
  });
  assertEquals(r.verified, false);
  assertEquals(r.badge, null);
});

Deno.test("capable device, complete pass over thresholds → 360-Verified (depth-backed)", () => {
  const r = evalReport(true, {
    angles: 12,
    geometric_coverage: 0.93,
    depth_available: true,
    capture_complete: true,
  });
  assertEquals(r.verified, true);
  assertEquals(r.badge, "verified_360");
  assertEquals(r.depth_used, true);
  assertEquals(r.geometric_coverage_pct, 93);
});

Deno.test("photogrammetry-only (no depth) still earns the badge when thresholds met", () => {
  const r = evalReport(true, {
    angles: verified360MinAngles(),
    geometric_coverage: 0.9,
    depth_available: false,
    capture_complete: true,
  });
  assertEquals(r.verified, true);
  assertEquals(r.badge, "verified_360");
  assertEquals(r.depth_used, false);
});

Deno.test("too few angles → no badge, fallback (never penalized)", () => {
  const r = evalReport(true, {
    angles: 3,
    geometric_coverage: 0.99,
    depth_available: true,
    capture_complete: true,
  });
  assertEquals(r.verified, false);
  assertEquals(r.badge, null);
  assert(r.reasons[0].includes("capture angles"));
});

Deno.test("low geometric coverage → no badge", () => {
  const r = evalReport(true, {
    angles: 16,
    geometric_coverage: 0.4,
    depth_available: true,
    capture_complete: true,
  });
  assertEquals(r.verified, false);
  assert(r.reasons[0].includes("geometric coverage"));
});

Deno.test("incomplete capture pass → no badge", () => {
  const r = evalReport(true, {
    angles: 16,
    geometric_coverage: 0.99,
    depth_available: true,
    capture_complete: false,
  });
  assertEquals(r.verified, false);
  assert(r.reasons[0].includes("not completed"));
});

Deno.test("opted in but no metrics reported → no badge, no throw", () => {
  const r = evalReport(true, null);
  assertEquals(r.verified, false);
  assertEquals(r.badge, null);
  assert(r.reasons[0].includes("no 360 capture metrics"));
});

Deno.test("confidence boost is small and bounded", () => {
  const b = verified360Boost();
  assert(b >= 0 && b <= 0.3);
});
