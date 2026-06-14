// US-883: System health dashboard — pure threshold / tile-building tests.

import { assertEquals } from "@std/assert";
import {
  buildHealthReport,
  classify,
  DEFAULT_HEALTH_THRESHOLDS,
  type EdgeRuntime,
  formatBytes,
  type HealthMetrics,
  mergeThresholds,
  overallStatus,
  storagePct,
} from "../lib/ops-health.ts";

const RUNTIME: EdgeRuntime = {
  uptimeSeconds: 1234,
  version: "abc123",
  env: "test",
  supabaseReachable: true,
  dbLatencyMs: 5,
};

function baseMetrics(over: Partial<HealthMetrics> = {}): HealthMetrics {
  return {
    tables: [{ name: "submissions", rows: 100, bytes: 1024 }],
    storage: { buckets: [], totalObjects: 0, totalBytes: 0 },
    queues: { disputesOpen: 0, reviewsOpen: 0, webhookDlqOpen: 0, emailDlqOpen: 0 },
    jobs: { failuresLast24h: 0, maxDurationMs: 0, slowest: [] },
    trends: { jobFailuresByDay: [], submissionErrorsByDay: [] },
    thresholds: {},
    generatedAt: "2026-06-14T12:00:00Z",
    ...over,
  };
}

Deno.test("classify: green/amber/red bands (higher = worse)", () => {
  const band = { amber: 5, red: 20 };
  assertEquals(classify(0, band), "green");
  assertEquals(classify(4, band), "green");
  assertEquals(classify(5, band), "amber");
  assertEquals(classify(19, band), "amber");
  assertEquals(classify(20, band), "red");
  assertEquals(classify(999, band), "red");
});

Deno.test("classify: missing / non-finite value → unknown", () => {
  const band = { amber: 1, red: 10 };
  assertEquals(classify(null, band), "unknown");
  assertEquals(classify(undefined, band), "unknown");
  assertEquals(classify(NaN, band), "unknown");
});

Deno.test("mergeThresholds: defaults fill missing keys", () => {
  const merged = mergeThresholds({});
  assertEquals(merged, DEFAULT_HEALTH_THRESHOLDS);
});

Deno.test("mergeThresholds: registry overrides apply over defaults", () => {
  const merged = mergeThresholds({
    webhookDlqOpen: { amber: 2, red: 5 },
    storageBytesCapGb: 100,
  });
  assertEquals(merged.webhookDlqOpen, { amber: 2, red: 5 });
  assertEquals(merged.storageBytesCapGb, 100);
  // Untouched keys keep their defaults.
  assertEquals(merged.emailDlqOpen, DEFAULT_HEALTH_THRESHOLDS.emailDlqOpen);
});

Deno.test("mergeThresholds: malformed band falls back to default", () => {
  const merged = mergeThresholds({
    disputesOpen: { amber: "oops" } as unknown,
    storageBytesCapGb: -1,
  });
  assertEquals(merged.disputesOpen, DEFAULT_HEALTH_THRESHOLDS.disputesOpen);
  assertEquals(merged.storageBytesCapGb, DEFAULT_HEALTH_THRESHOLDS.storageBytesCapGb);
});

Deno.test("storagePct: bytes vs GB cap", () => {
  const GB = 1024 * 1024 * 1024;
  assertEquals(Math.round(storagePct(50 * GB, 100)), 50);
  assertEquals(storagePct(0, 100), 0);
  assertEquals(storagePct(10, 0), 0); // zero cap → 0, no divide-by-zero
});

Deno.test("formatBytes", () => {
  assertEquals(formatBytes(0), "0 B");
  assertEquals(formatBytes(512), "512 B");
  assertEquals(formatBytes(1024), "1.0 KB");
  assertEquals(formatBytes(5 * 1024 * 1024), "5.0 MB");
});

Deno.test("overallStatus: worst wins, unknown ignored", () => {
  assertEquals(overallStatus([{ key: "a", label: "", status: "green", value: "" }]), "green");
  assertEquals(
    overallStatus([
      { key: "a", label: "", status: "green", value: "" },
      { key: "b", label: "", status: "unknown", value: "" },
    ]),
    "green",
  );
  assertEquals(
    overallStatus([
      { key: "a", label: "", status: "green", value: "" },
      { key: "b", label: "", status: "amber", value: "" },
    ]),
    "amber",
  );
  assertEquals(
    overallStatus([
      { key: "a", label: "", status: "amber", value: "" },
      { key: "b", label: "", status: "red", value: "" },
    ]),
    "red",
  );
});

Deno.test("buildHealthReport: all green when healthy", () => {
  const report = buildHealthReport(baseMetrics(), RUNTIME);
  assertEquals(report.overall, "green");
  assertEquals(report.runtime.supabaseReachable, true);
  // db tile reflects reachability
  const db = report.tiles.find((t) => t.key === "supabase");
  assertEquals(db?.status, "green");
});

Deno.test("buildHealthReport: DLQ over red threshold flips overall red", () => {
  const report = buildHealthReport(
    baseMetrics({
      queues: { disputesOpen: 0, reviewsOpen: 0, webhookDlqOpen: 30, emailDlqOpen: 0 },
    }),
    RUNTIME,
  );
  const tile = report.tiles.find((t) => t.key === "webhookDlq");
  assertEquals(tile?.status, "red");
  assertEquals(report.overall, "red");
});

Deno.test("buildHealthReport: unreachable DB → red db tile", () => {
  const report = buildHealthReport(baseMetrics(), { ...RUNTIME, supabaseReachable: false, dbLatencyMs: null });
  const db = report.tiles.find((t) => t.key === "supabase");
  assertEquals(db?.status, "red");
  assertEquals(report.overall, "red");
});

Deno.test("buildHealthReport: job-failures tile carries trend sparkline", () => {
  const report = buildHealthReport(
    baseMetrics({
      jobs: { failuresLast24h: 3, maxDurationMs: 1000, slowest: [] },
      trends: {
        jobFailuresByDay: [
          { day: "d1", count: 0 },
          { day: "d2", count: 1 },
          { day: "d3", count: 3 },
        ],
        submissionErrorsByDay: [],
      },
    }),
    RUNTIME,
  );
  const tile = report.tiles.find((t) => t.key === "jobFailures");
  assertEquals(tile?.trend, [0, 1, 3]);
  assertEquals(tile?.status, "amber"); // 3 >= amber(1), < red(10)
});

Deno.test("buildHealthReport: registry threshold makes storage amber", () => {
  const GB = 1024 * 1024 * 1024;
  const report = buildHealthReport(
    baseMetrics({
      storage: { buckets: [], totalObjects: 10, totalBytes: 8 * GB },
      thresholds: { storageBytesCapGb: 10, storagePct: { amber: 70, red: 90 } },
    }),
    RUNTIME,
  );
  const tile = report.tiles.find((t) => t.key === "storage");
  assertEquals(tile?.status, "amber"); // 80% of 10GB cap
});
