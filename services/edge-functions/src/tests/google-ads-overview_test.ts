// US-1699: Ads Command Center aggregation — KPI math (micros → dollars,
// CTR/CPC/CPA/ROAS), daily time-series, and per-campaign breakdown.
import { assertEquals } from "@std/assert";
import {
  aggregateKpis,
  campaignBreakdown,
  dailyTimeseries,
  type RawMetric,
} from "../lib/google-ads-overview.ts";

function metric(p: Partial<RawMetric>): RawMetric {
  return {
    entity_id: "1",
    metric_date: "2026-07-01",
    impressions: 0,
    clicks: 0,
    cost_micros: 0,
    conversions: 0,
    conversion_value: 0,
    ...p,
  };
}

Deno.test("aggregateKpis sums + derives CTR/CPC/CPA/ROAS (micros→dollars)", () => {
  const k = aggregateKpis([
    metric({ impressions: 1000, clicks: 100, cost_micros: 50_000_000, conversions: 10, conversion_value: 200 }),
    metric({ impressions: 1000, clicks: 100, cost_micros: 50_000_000, conversions: 10, conversion_value: 200 }),
  ]);
  assertEquals(k.spend, 100); // 100_000_000 micros
  assertEquals(k.impressions, 2000);
  assertEquals(k.clicks, 200);
  assertEquals(k.conversions, 20);
  assertEquals(k.conversionValue, 400);
  assertEquals(k.ctr, 0.1); // 200/2000
  assertEquals(k.cpc, 0.5); // 100/200
  assertEquals(k.cpa, 5); // 100/20
  assertEquals(k.roas, 4); // 400/100
});

Deno.test("aggregateKpis guards divide-by-zero (empty → all zeros)", () => {
  const k = aggregateKpis([]);
  assertEquals(k.spend, 0);
  assertEquals(k.ctr, 0);
  assertEquals(k.cpc, 0);
  assertEquals(k.cpa, 0);
  assertEquals(k.roas, 0);
});

Deno.test("dailyTimeseries groups by date, sorted ascending", () => {
  const ts = dailyTimeseries([
    metric({ metric_date: "2026-07-02", clicks: 5, cost_micros: 2_000_000, conversions: 1 }),
    metric({ metric_date: "2026-07-01", clicks: 3, cost_micros: 1_000_000, conversions: 2 }),
    metric({ metric_date: "2026-07-01", clicks: 1, cost_micros: 1_000_000, conversions: 0 }),
  ]);
  assertEquals(ts.length, 2);
  assertEquals(ts[0].date, "2026-07-01");
  assertEquals(ts[0].spend, 2); // 2_000_000 micros
  assertEquals(ts[0].clicks, 4);
  assertEquals(ts[0].conversions, 2);
  assertEquals(ts[1].date, "2026-07-02");
  assertEquals(ts[1].spend, 2);
});

Deno.test("campaignBreakdown joins names + sorts by spend desc", () => {
  const rows: RawMetric[] = [
    metric({ entity_id: "111", cost_micros: 10_000_000, clicks: 5 }),
    metric({ entity_id: "222", cost_micros: 40_000_000, clicks: 8 }),
    metric({ entity_id: "222", cost_micros: 10_000_000, clicks: 2 }),
  ];
  const out = campaignBreakdown(rows, [
    { external_id: "111", name: "Brand", status: "ENABLED" },
    { external_id: "222", name: "Prospecting", status: "PAUSED" },
  ]);
  assertEquals(out.length, 2);
  // 222 (spend 50) sorts before 111 (spend 10).
  assertEquals(out[0].id, "222");
  assertEquals(out[0].name, "Prospecting");
  assertEquals(out[0].spend, 50);
  assertEquals(out[0].clicks, 10);
  assertEquals(out[1].id, "111");
  assertEquals(out[1].spend, 10);
});

Deno.test("campaignBreakdown falls back to a generated name for unknown ids", () => {
  const out = campaignBreakdown([metric({ entity_id: "999", cost_micros: 1_000_000 })], []);
  assertEquals(out[0].name, "Campaign 999");
  assertEquals(out[0].status, null);
});
