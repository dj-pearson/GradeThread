// US-1705: budget pacing + anomaly detection.
//
// Pure math (detection + pacing projection) is unit-tested; scanAdsAnomalies
// reads recent metrics, runs detection, and broadcasts any anomaly to super-admins
// via the existing admin-notification path. Thresholds live in system_settings.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSetting } from "./system-settings.ts";
import { routeOpsEventToAdmins } from "./admin-notifications.ts";
import { microsToDollars } from "./google-ads-sync.ts";

export const ADS_ANOMALY_SETTING_KEY = "ads_anomaly_thresholds";

export interface AnomalyThresholds {
  /** Latest-day spend above trailing avg by this % → spike. */
  spendSpikePct: number;
  /** Latest-day CTR below trailing CTR by this % → drop. */
  ctrDropPct: number;
  /** Latest-day CPA above trailing CPA by this % → blowout. */
  cpaBlowoutPct: number;
}

export const DEFAULT_ANOMALY_THRESHOLDS: AnomalyThresholds = {
  spendSpikePct: 100,
  ctrDropPct: 40,
  cpaBlowoutPct: 100,
};

export async function getAnomalyThresholds(): Promise<AnomalyThresholds> {
  const t = await getSetting<Partial<AnomalyThresholds>>(ADS_ANOMALY_SETTING_KEY, {});
  return {
    spendSpikePct: num(t.spendSpikePct, DEFAULT_ANOMALY_THRESHOLDS.spendSpikePct),
    ctrDropPct: num(t.ctrDropPct, DEFAULT_ANOMALY_THRESHOLDS.ctrDropPct),
    cpaBlowoutPct: num(t.cpaBlowoutPct, DEFAULT_ANOMALY_THRESHOLDS.cpaBlowoutPct),
  };
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface DailySeriesPoint {
  date: string;
  spend: number;
  clicks: number;
  impressions: number;
  conversions: number;
}

export interface Anomaly {
  kind: "spend_spike" | "ctr_drop" | "cpa_blowout";
  message: string;
}

const MIN_DAYS = 4;

function avg(nums: number[]): number {
  return nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
}

/**
 * Compare the LATEST day against the trailing average of the prior days and flag
 * spend spikes, CTR drops, and CPA blowouts beyond their thresholds. Needs at
 * least MIN_DAYS points; returns [] otherwise (not enough signal).
 */
export function detectAnomalies(
  series: DailySeriesPoint[],
  thresholds: AnomalyThresholds,
): Anomaly[] {
  if (series.length < MIN_DAYS) return [];
  const sorted = [...series].sort((a, b) => a.date.localeCompare(b.date));
  const latest = sorted[sorted.length - 1];
  const prior = sorted.slice(0, -1);

  const out: Anomaly[] = [];

  const trailingSpend = avg(prior.map((p) => p.spend));
  if (trailingSpend > 0 && latest.spend > trailingSpend * (1 + thresholds.spendSpikePct / 100)) {
    out.push({
      kind: "spend_spike",
      message: `Spend spike on ${latest.date}: $${latest.spend.toFixed(2)} vs ~$${trailingSpend.toFixed(2)} trailing avg.`,
    });
  }

  const ctr = (p: DailySeriesPoint) => (p.impressions > 0 ? p.clicks / p.impressions : 0);
  const trailingCtr = avg(prior.map(ctr));
  const latestCtr = ctr(latest);
  if (trailingCtr > 0 && latestCtr < trailingCtr * (1 - thresholds.ctrDropPct / 100)) {
    out.push({
      kind: "ctr_drop",
      message: `CTR drop on ${latest.date}: ${(latestCtr * 100).toFixed(2)}% vs ~${(trailingCtr * 100).toFixed(2)}% trailing avg.`,
    });
  }

  const cpa = (p: DailySeriesPoint) => (p.conversions > 0 ? p.spend / p.conversions : 0);
  const trailingCpa = avg(prior.map(cpa).filter((v) => v > 0));
  const latestCpa = cpa(latest);
  if (trailingCpa > 0 && latestCpa > trailingCpa * (1 + thresholds.cpaBlowoutPct / 100)) {
    out.push({
      kind: "cpa_blowout",
      message: `CPA blowout on ${latest.date}: $${latestCpa.toFixed(2)} vs ~$${trailingCpa.toFixed(2)} trailing avg.`,
    });
  }

  return out;
}

export interface Pacing {
  mtdSpend: number;
  dayOfMonth: number;
  daysInMonth: number;
  dailyAvg: number;
  projectedEom: number;
  monthlyBudget: number;
  /** projectedEom / monthlyBudget (0 when no budget). */
  projectedUtilization: number;
}

/** Month-to-date spend + straight-line end-of-month projection vs the budget. */
export function computePacing(
  dailySpends: Array<{ date: string; spend: number }>,
  monthlyBudget: number,
  now: Date = new Date(),
): Pacing {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  const monthPrefix = `${y}-${String(m + 1).padStart(2, "0")}-`;
  const mtdSpend = dailySpends
    .filter((d) => d.date.startsWith(monthPrefix))
    .reduce((s, d) => s + d.spend, 0);
  const dayOfMonth = now.getUTCDate();
  const daysInMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  const dailyAvg = dayOfMonth > 0 ? mtdSpend / dayOfMonth : 0;
  const projectedEom = dailyAvg * daysInMonth;
  return {
    mtdSpend: round2(mtdSpend),
    dayOfMonth,
    daysInMonth,
    dailyAvg: round2(dailyAvg),
    projectedEom: round2(projectedEom),
    monthlyBudget,
    projectedUtilization: monthlyBudget > 0 ? round2(projectedEom / monthlyBudget) : 0,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read ~14d of account metrics, detect anomalies, and alert super-admins. */
export async function scanAdsAnomalies(supabase: SupabaseClient): Promise<Anomaly[]> {
  const since = new Date(Date.now() - 14 * 86_400_000).toISOString().slice(0, 10);
  const { data, error } = await supabase
    .from("ads_metrics_daily")
    .select("metric_date, impressions, clicks, cost_micros, conversions")
    .eq("platform", "google_ads")
    .eq("entity_type", "campaign")
    .gte("metric_date", since);
  if (error || !data) return [];

  const byDate = new Map<string, DailySeriesPoint>();
  for (const row of data as Array<Record<string, unknown>>) {
    const date = String(row.metric_date ?? "");
    if (!date) continue;
    const p = byDate.get(date) ?? { date, spend: 0, clicks: 0, impressions: 0, conversions: 0 };
    p.spend += microsToDollars(row.cost_micros);
    p.clicks += Number(row.clicks) || 0;
    p.impressions += Number(row.impressions) || 0;
    p.conversions += Number(row.conversions) || 0;
    byDate.set(date, p);
  }

  const anomalies = detectAnomalies([...byDate.values()], await getAnomalyThresholds());
  if (anomalies.length > 0) {
    await routeOpsEventToAdmins({
      type: "ads.anomaly",
      severity: "critical",
      title: `Google Ads anomaly detected: ${anomalies.map((a) => a.kind).join(", ")}. ${anomalies[0].message}`,
      link: "/admin/ads",
      opsEventId: null,
    });
  }
  return anomalies;
}
