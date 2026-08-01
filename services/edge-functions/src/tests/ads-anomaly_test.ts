// US-1705: anomaly detection fires past thresholds; pacing projection.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  computePacing,
  DEFAULT_ANOMALY_THRESHOLDS,
  detectAnomalies,
  type DailySeriesPoint,
} from "../lib/ads-anomaly.ts";

function pt(date: string, spend: number, clicks: number, impressions: number, conversions: number): DailySeriesPoint {
  return { date, spend, clicks, impressions, conversions };
}

Deno.test("detectAnomalies flags a spend spike vs trailing avg", () => {
  const series = [
    pt("2026-07-01", 10, 50, 1000, 5),
    pt("2026-07-02", 10, 50, 1000, 5),
    pt("2026-07-03", 10, 50, 1000, 5),
    pt("2026-07-04", 60, 50, 1000, 5), // spend 6x → spike (>100% over ~10)
  ];
  const anomalies = detectAnomalies(series, DEFAULT_ANOMALY_THRESHOLDS);
  assert(anomalies.some((a) => a.kind === "spend_spike"));
});

Deno.test("detectAnomalies flags a CTR drop", () => {
  const series = [
    pt("2026-07-01", 10, 50, 1000, 5), // 5% CTR
    pt("2026-07-02", 10, 50, 1000, 5),
    pt("2026-07-03", 10, 50, 1000, 5),
    pt("2026-07-04", 10, 10, 1000, 5), // 1% CTR → >40% drop
  ];
  assert(detectAnomalies(series, DEFAULT_ANOMALY_THRESHOLDS).some((a) => a.kind === "ctr_drop"));
});

Deno.test("detectAnomalies flags a CPA blowout", () => {
  const series = [
    pt("2026-07-01", 10, 50, 1000, 5), // CPA $2
    pt("2026-07-02", 10, 50, 1000, 5),
    pt("2026-07-03", 10, 50, 1000, 5),
    pt("2026-07-04", 50, 50, 1000, 5), // CPA $10 → >100% blowout
  ];
  assert(detectAnomalies(series, DEFAULT_ANOMALY_THRESHOLDS).some((a) => a.kind === "cpa_blowout"));
});

Deno.test("detectAnomalies is quiet on a steady series and on too-few days", () => {
  const steady = [
    pt("2026-07-01", 10, 50, 1000, 5),
    pt("2026-07-02", 11, 52, 1010, 5),
    pt("2026-07-03", 9, 49, 990, 5),
    pt("2026-07-04", 10, 50, 1000, 5),
  ];
  assertEquals(detectAnomalies(steady, DEFAULT_ANOMALY_THRESHOLDS).length, 0);
  assertEquals(detectAnomalies(steady.slice(0, 2), DEFAULT_ANOMALY_THRESHOLDS).length, 0);
});

Deno.test("computePacing projects end-of-month from MTD spend", () => {
  const spends = Array.from({ length: 10 }, (_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, "0")}`,
    spend: 10,
  }));
  // Include a prior-month day that must be excluded from MTD.
  spends.push({ date: "2026-06-30", spend: 999 });
  const p = computePacing(spends, 400, new Date("2026-07-10T00:00:00Z"));
  assertEquals(p.mtdSpend, 100); // 10 days * $10, June excluded
  assertEquals(p.dayOfMonth, 10);
  assertEquals(p.daysInMonth, 31);
  assertEquals(p.dailyAvg, 10);
  assertEquals(p.projectedEom, 310);
  assertEquals(p.projectedUtilization, round2(310 / 400));
});

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
