// US-1699: Ads Command Center aggregation — turns raw ads_metrics_daily rows
// into the KPIs / campaign breakdown / daily time-series the dashboard reads.
// PURE + exported so the money math (micros → dollars, CTR/CPC/CPA/ROAS) is
// unit-tested with no DB. The edge route (admin-ads.ts) does the DB reads and
// calls these.

import { microsToDollars } from "./google-ads-sync.ts";

/** One aggregated-or-raw metrics row (cost stays in micros until we roll up). */
export interface RawMetric {
  entity_id: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
  conversion_value: number;
}

export interface Kpis {
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  /** clicks / impressions */
  ctr: number;
  /** spend / clicks */
  cpc: number;
  /** spend / conversions */
  cpa: number;
  /** conversion value / spend */
  roas: number;
}

function ratio(numer: number, denom: number): number {
  return denom > 0 ? numer / denom : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Roll a set of metric rows up into one KPI block (spend in dollars). */
export function aggregateKpis(rows: readonly RawMetric[]): Kpis {
  let impressions = 0, clicks = 0, costMicros = 0, conversions = 0, conversionValue = 0;
  for (const r of rows) {
    impressions += r.impressions;
    clicks += r.clicks;
    costMicros += r.cost_micros;
    conversions += r.conversions;
    conversionValue += r.conversion_value;
  }
  const spend = microsToDollars(costMicros);
  return {
    spend: round2(spend),
    impressions,
    clicks,
    conversions: round2(conversions),
    conversionValue: round2(conversionValue),
    ctr: round2(ratio(clicks, impressions)),
    cpc: round2(ratio(spend, clicks)),
    cpa: round2(ratio(spend, conversions)),
    roas: round2(ratio(conversionValue, spend)),
  };
}

export interface DailyPoint {
  date: string;
  spend: number;
  clicks: number;
  conversions: number;
  cpa: number;
}

/** Sum metrics per day (across whatever entity rows are passed), sorted by date. */
export function dailyTimeseries(rows: readonly RawMetric[]): DailyPoint[] {
  const byDate = new Map<string, RawMetric[]>();
  for (const r of rows) {
    if (!r.metric_date) continue;
    const list = byDate.get(r.metric_date) ?? [];
    list.push(r);
    byDate.set(r.metric_date, list);
  }
  return [...byDate.keys()].sort().map((date) => {
    const k = aggregateKpis(byDate.get(date)!);
    return { date, spend: k.spend, clicks: k.clicks, conversions: k.conversions, cpa: k.cpa };
  });
}

export interface CampaignPerf extends Kpis {
  id: string;
  name: string;
  status: string | null;
}

/** Per-campaign KPI rows, joined to the campaign name/status, spend-sorted desc. */
export function campaignBreakdown(
  rows: readonly RawMetric[],
  campaigns: ReadonlyArray<{ external_id: string; name: string | null; status: string | null }>,
): CampaignPerf[] {
  const byCampaign = new Map<string, RawMetric[]>();
  for (const r of rows) {
    const list = byCampaign.get(r.entity_id) ?? [];
    list.push(r);
    byCampaign.set(r.entity_id, list);
  }
  const nameOf = new Map(campaigns.map((c) => [c.external_id, c] as const));
  return [...byCampaign.entries()]
    .map(([id, metricRows]) => {
      const meta = nameOf.get(id);
      return {
        id,
        name: meta?.name ?? `Campaign ${id}`,
        status: meta?.status ?? null,
        ...aggregateKpis(metricRows),
      };
    })
    .sort((a, b) => b.spend - a.spend);
}
