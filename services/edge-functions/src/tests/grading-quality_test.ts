// US-1594: Grading Quality memo assembly + the lifecycle-safety classification.
// The pure functions live alongside impure gather (which imports supabase), so
// prime env + dynamic-import (mirrors agent-budget_test.ts).
import { assert, assertEquals } from "@std/assert";
import type { GradingTelemetryInput } from "../lib/grading-quality.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-key");
const { assembleGradingMemo, classifyGradingIntent } = await import("../lib/grading-quality.ts");

function telemetry(over: Partial<GradingTelemetryInput> = {}): GradingTelemetryInput {
  return {
    global: { mae: 0.32, agreement: 0.91 },
    categories: [
      { category: "jeans", mae: 0.28, agreement: 0.94, count: 40 }, // good
      { category: "dresses", mae: 0.95, agreement: 0.7, count: 22 }, // regressed
      { category: "shoes", mae: 0.5, agreement: 0.85, count: 3 }, // thin → ignored
    ],
    versions: [{ name: "v7", mae: 0.31, agreement: 0.92 }],
    calibration: {
      enabled: true,
      targetErrorRate: 0.1,
      categories: [{ category: "jeans", threshold: 0.72, shippedErrorRate: 0.05, sampleSize: 200 }],
    },
    reviewQueueOpen: 12,
    exemplarCoverage: [{ category: "jeans", count: 8 }],
    ...over,
  };
}

// ── Memo structure ───────────────────────────────────────────────────────────

Deno.test("assembleGradingMemo: surfaces regressions, improvements, gaps, holes", () => {
  const m = assembleGradingMemo(telemetry());
  // dresses regressed (MAE 0.95 > 0.75, 22 samples); shoes ignored (thin).
  assertEquals(m.regressions.map((r) => r.category), ["dresses"]);
  // jeans is good (MAE 0.28 ≤ 0.45).
  assertEquals(m.improvements.map((r) => r.category), ["jeans"]);
  // dresses has no calibration curve → a gap; jeans is fine.
  assert(m.calibrationGaps.some((g) => g.category === "dresses"));
  // dresses has no exemplar coverage → a hole; jeans has 8 (≥3) → not.
  assertEquals(m.exemplarHoles, ["dresses"]);
  assertEquals(m.reviewQueueOpen, 12);
  assert(m.headline.includes("regressed"));
});

Deno.test("assembleGradingMemo: a clean week reads as healthy", () => {
  const m = assembleGradingMemo(telemetry({
    categories: [{ category: "jeans", mae: 0.3, agreement: 0.95, count: 50 }],
    calibration: {
      enabled: true,
      targetErrorRate: 0.1,
      categories: [{ category: "jeans", threshold: 0.72, shippedErrorRate: 0.04, sampleSize: 300 }],
    },
    exemplarCoverage: [{ category: "jeans", count: 6 }],
  }));
  assertEquals(m.regressions.length, 0);
  assertEquals(m.calibrationGaps.length, 0);
  assertEquals(m.exemplarHoles.length, 0);
  assert(m.headline.includes("No regressions"));
});

Deno.test("assembleGradingMemo: disabled calibration is one gap, not one per category", () => {
  const m = assembleGradingMemo(telemetry({
    calibration: { enabled: false, targetErrorRate: 0.1, categories: [] },
  }));
  assertEquals(m.calibrationGaps.length, 1);
  assertEquals(m.calibrationGaps[0].category, "*");
});

// ── Lifecycle safety ─────────────────────────────────────────────────────────

Deno.test("classifyGradingIntent: EVERY grading change is a file_task (never executed)", () => {
  for (const kind of ["prompt_version", "threshold", "calibration", "exemplar", "reorder_review_queue", "anything"]) {
    assertEquals(classifyGradingIntent(kind), "file_task");
  }
});
