// US-1707: Apple Search Ads → shared ads_* snapshot sync.
//
// Pulls ASA campaigns / ad groups / keywords + daily report metrics into the
// SAME ads_* tables Google Ads uses, tagged platform='apple_search_ads', so the
// Command Center + analysis treat both platforms uniformly. Pure mappers are
// unit-tested; the API calls go through an injected `request`.

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  APPLE_SEARCH_ADS_PLATFORM,
  type AppleSearchAdsConfig,
  appleRequest,
} from "./apple-search-ads-client.ts";

/** ASA money is a decimal string amount; our tables store micros. */
export function amountToMicros(amount: unknown): number {
  const n = typeof amount === "string" ? Number(amount) : (typeof amount === "number" ? amount : 0);
  return Number.isFinite(n) ? Math.round(n * 1_000_000) : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}
function numv(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (typeof v === "number" ? v : 0);
  return Number.isFinite(n) ? n : 0;
}

export interface AppleCampaign { id?: unknown; name?: unknown; status?: unknown; budgetAmount?: { amount?: unknown } }

export function mapAppleCampaign(row: AppleCampaign, owner: string | null) {
  return {
    platform: APPLE_SEARCH_ADS_PLATFORM,
    owner_user_id: owner,
    external_id: String(row.id ?? ""),
    name: str(row.name),
    status: str(row.status),
    channel_type: "SEARCH",
    budget_micros: row.budgetAmount?.amount != null ? amountToMicros(row.budgetAmount.amount) : null,
  };
}

export function mapAppleAdGroup(row: { id?: unknown; name?: unknown; status?: unknown }, campaignId: string, owner: string | null) {
  return {
    platform: APPLE_SEARCH_ADS_PLATFORM,
    owner_user_id: owner,
    external_id: String(row.id ?? ""),
    campaign_external_id: campaignId,
    name: str(row.name),
    status: str(row.status),
    type: null,
  };
}

export function mapAppleKeyword(
  row: { id?: unknown; text?: unknown; matchType?: unknown; status?: unknown },
  adGroupId: string,
  owner: string | null,
) {
  return {
    platform: APPLE_SEARCH_ADS_PLATFORM,
    owner_user_id: owner,
    external_id: String(row.id ?? ""),
    ad_group_external_id: adGroupId,
    text: str(row.text),
    match_type: str(row.matchType),
    status: str(row.status),
  };
}

export interface AppleReportRow {
  metadata?: { campaignId?: unknown };
  granularity?: Array<{
    date?: unknown;
    localSpend?: { amount?: unknown };
    impressions?: unknown;
    taps?: unknown;
    totalInstalls?: unknown;
    totalAvgCPI?: { amount?: unknown };
  }>;
}

/** Map one ASA reporting row (campaign, with a daily granularity) → metric rows. */
export function mapAppleReportRow(row: AppleReportRow, owner: string | null) {
  const campaignId = String(row.metadata?.campaignId ?? "");
  if (!campaignId) return [];
  return (row.granularity ?? [])
    .map((g) => {
      const date = String(g.date ?? "");
      if (!date) return null;
      const spendMicros = amountToMicros(g.localSpend?.amount);
      const installs = numv(g.totalInstalls);
      // conversion value ≈ installs × avg CPI (a rough downstream value proxy).
      const conversionValue = amountToMicros(g.totalAvgCPI?.amount) / 1_000_000 * installs;
      return {
        platform: APPLE_SEARCH_ADS_PLATFORM,
        owner_user_id: owner,
        entity_type: "campaign",
        entity_id: campaignId,
        metric_date: date,
        impressions: numv(g.impressions),
        clicks: numv(g.taps),
        cost_micros: spendMicros,
        conversions: installs,
        conversion_value: Math.round(conversionValue * 100) / 100,
      };
    })
    .filter((r): r is NonNullable<typeof r> => r !== null);
}

export interface AppleSyncCounts {
  campaigns: number;
  adGroups: number;
  keywords: number;
  metrics: number;
}

async function upsert(supabase: SupabaseClient, table: string, rows: unknown[], onConflict: string): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await supabase.from(table).upsert(rows as Record<string, unknown>[], { onConflict, ignoreDuplicates: false });
  if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  return rows.length;
}

/**
 * Pull ASA structure + daily campaign metrics and upsert into the shared tables.
 * `request` is injected (defaults to a live appleRequest bound to config+token).
 */
export async function syncAppleSearchAds(deps: {
  config: AppleSearchAdsConfig;
  token: string;
  supabase: SupabaseClient;
  since: string;
  until: string;
  ownerUserId?: string | null;
  request?: <T>(method: "GET" | "POST", path: string, body?: unknown) => Promise<T>;
}): Promise<AppleSyncCounts> {
  const owner = deps.ownerUserId ?? null;
  const request = deps.request ??
    (<T>(method: "GET" | "POST", path: string, body?: unknown) =>
      appleRequest<T>(deps.config, deps.token, method, path, body));

  const campaignsResp = await request<{ data?: AppleCampaign[] }>("GET", "/campaigns?limit=1000");
  const campaigns = (campaignsResp.data ?? []).map((c) => mapAppleCampaign(c, owner));

  const adGroupRows: ReturnType<typeof mapAppleAdGroup>[] = [];
  const keywordRows: ReturnType<typeof mapAppleKeyword>[] = [];
  for (const c of campaigns) {
    if (!c.external_id) continue;
    const ags = await request<{ data?: Array<{ id?: unknown; name?: unknown; status?: unknown }> }>(
      "GET",
      `/campaigns/${c.external_id}/adgroups?limit=1000`,
    );
    for (const ag of ags.data ?? []) {
      const mapped = mapAppleAdGroup(ag, c.external_id, owner);
      adGroupRows.push(mapped);
      if (!mapped.external_id) continue;
      const kws = await request<{ data?: Array<{ id?: unknown; text?: unknown; matchType?: unknown; status?: unknown }> }>(
        "GET",
        `/campaigns/${c.external_id}/adgroups/${mapped.external_id}/targetingkeywords?limit=1000`,
      );
      for (const kw of kws.data ?? []) keywordRows.push(mapAppleKeyword(kw, mapped.external_id, owner));
    }
  }

  // Campaign-level daily report.
  const report = await request<{ data?: { reportingDataResponse?: { row?: AppleReportRow[] } } }>(
    "POST",
    "/reports/campaigns",
    {
      startTime: deps.since,
      endTime: deps.until,
      granularity: "DAILY",
      selector: { orderBy: [{ field: "localSpend", sortOrder: "DESCENDING" }], pagination: { offset: 0, limit: 1000 } },
      returnRowTotals: false,
      returnRecordsWithNoMetrics: false,
    },
  );
  const metricRows = (report.data?.reportingDataResponse?.row ?? []).flatMap((r) => mapAppleReportRow(r, owner));

  return {
    campaigns: await upsert(deps.supabase, "ads_campaigns", campaigns, "platform,external_id"),
    adGroups: await upsert(deps.supabase, "ads_ad_groups", adGroupRows, "platform,external_id"),
    keywords: await upsert(deps.supabase, "ads_keywords", keywordRows, "platform,external_id"),
    metrics: await upsert(deps.supabase, "ads_metrics_daily", metricRows, "platform,entity_type,entity_id,metric_date"),
  };
}
