// US-1698: Google Ads → local snapshot sync.
//
// Pulls our account STRUCTURE (campaigns / ad groups / ads / keywords) and the
// last-N-days DAILY METRICS via GAQL and upserts them idempotently into the
// ads_* operator tables, so the Command Center dashboard (US-1699) and the
// Claude analysis engine (US-1701) read fast local rows instead of hitting the
// Ads API on every view. Re-running a day overwrites the same row (upsert keyed
// on the Google resource id + date), so the sync is safe to repeat.
//
// The GAQL row→table-row mappers are PURE + exported so they're unit-tested with
// mocked data (no live call); the Ads API call is injected as `runQuery`.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { GaqlRow } from "./google-ads-client.ts";

export const GOOGLE_ADS_PLATFORM = "google_ads";

/** Last path segment of a resource name ("customers/1/campaigns/9" → "9"). */
export function resourceNameToId(resourceName: unknown): string {
  if (typeof resourceName !== "string" || !resourceName) return "";
  const parts = resourceName.split("/");
  return parts[parts.length - 1] ?? "";
}

/** Google Ads money is micros (1e6 = one currency unit). */
export function microsToDollars(micros: unknown): number {
  const n = typeof micros === "string" ? Number(micros) : (typeof micros === "number" ? micros : 0);
  return Number.isFinite(n) ? n / 1_000_000 : 0;
}

function num(v: unknown): number {
  const n = typeof v === "string" ? Number(v) : (typeof v === "number" ? v : 0);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

// ── Structure mappers ──────────────────────────────────────────────────
export interface CampaignRow {
  platform: string;
  owner_user_id: string | null;
  external_id: string;
  name: string | null;
  status: string | null;
  channel_type: string | null;
  budget_micros: number | null;
}

export function mapCampaign(row: GaqlRow, ownerUserId: string | null = null): CampaignRow {
  const c = (row.campaign ?? {}) as Record<string, unknown>;
  const budget = (row.campaignBudget ?? {}) as Record<string, unknown>;
  return {
    platform: GOOGLE_ADS_PLATFORM,
    owner_user_id: ownerUserId,
    external_id: String(c.id ?? resourceNameToId(c.resourceName)),
    name: str(c.name),
    status: str(c.status),
    channel_type: str(c.advertisingChannelType),
    budget_micros: budget.amountMicros != null ? num(budget.amountMicros) : null,
  };
}

export interface AdGroupRow {
  platform: string;
  owner_user_id: string | null;
  external_id: string;
  campaign_external_id: string | null;
  name: string | null;
  status: string | null;
  type: string | null;
}

export function mapAdGroup(row: GaqlRow, ownerUserId: string | null = null): AdGroupRow {
  const g = (row.adGroup ?? {}) as Record<string, unknown>;
  return {
    platform: GOOGLE_ADS_PLATFORM,
    owner_user_id: ownerUserId,
    external_id: String(g.id ?? resourceNameToId(g.resourceName)),
    campaign_external_id: resourceNameToId(g.campaign) || null,
    name: str(g.name),
    status: str(g.status),
    type: str(g.type),
  };
}

export interface AdRow {
  platform: string;
  owner_user_id: string | null;
  external_id: string;
  ad_group_external_id: string | null;
  ad_type: string | null;
  status: string | null;
  final_urls: string[] | null;
}

export function mapAd(row: GaqlRow, ownerUserId: string | null = null): AdRow {
  const aga = (row.adGroupAd ?? {}) as Record<string, unknown>;
  const ad = (aga.ad ?? {}) as Record<string, unknown>;
  const urls = Array.isArray(ad.finalUrls) ? ad.finalUrls.map(String) : null;
  return {
    platform: GOOGLE_ADS_PLATFORM,
    owner_user_id: ownerUserId,
    external_id: String(ad.id ?? resourceNameToId(ad.resourceName)),
    ad_group_external_id: resourceNameToId(aga.adGroup) || null,
    ad_type: str(ad.type),
    status: str(aga.status),
    final_urls: urls,
  };
}

export interface KeywordRow {
  platform: string;
  owner_user_id: string | null;
  external_id: string;
  ad_group_external_id: string | null;
  text: string | null;
  match_type: string | null;
  status: string | null;
}

export function mapKeyword(row: GaqlRow, ownerUserId: string | null = null): KeywordRow {
  const crit = (row.adGroupCriterion ?? {}) as Record<string, unknown>;
  const kw = (crit.keyword ?? {}) as Record<string, unknown>;
  return {
    platform: GOOGLE_ADS_PLATFORM,
    owner_user_id: ownerUserId,
    external_id: String(crit.criterionId ?? resourceNameToId(crit.resourceName)),
    ad_group_external_id: resourceNameToId(crit.adGroup) || null,
    text: str(kw.text),
    match_type: str(kw.matchType),
    status: str(crit.status),
  };
}

// ── Metric mapper ──────────────────────────────────────────────────────
export type AdsEntityType = "campaign" | "ad_group" | "ad" | "keyword";

export interface MetricRow {
  platform: string;
  owner_user_id: string | null;
  entity_type: AdsEntityType;
  entity_id: string;
  metric_date: string;
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
  conversion_value: number;
}

/** entityId is read from `row` at `idPath` (a resource-name or id field). */
export function mapMetric(
  row: GaqlRow,
  entityType: AdsEntityType,
  entityId: string,
  ownerUserId: string | null = null,
): MetricRow {
  const m = (row.metrics ?? {}) as Record<string, unknown>;
  const seg = (row.segments ?? {}) as Record<string, unknown>;
  return {
    platform: GOOGLE_ADS_PLATFORM,
    owner_user_id: ownerUserId,
    entity_type: entityType,
    entity_id: entityId,
    metric_date: String(seg.date ?? ""),
    impressions: num(m.impressions),
    clicks: num(m.clicks),
    cost_micros: num(m.costMicros),
    conversions: num(m.conversions),
    conversion_value: num(m.conversionsValue),
  };
}

// ── GAQL queries ───────────────────────────────────────────────────────
export const STRUCTURE_QUERIES = {
  campaigns:
    "SELECT campaign.id, campaign.name, campaign.status, campaign.advertising_channel_type, campaign_budget.amount_micros FROM campaign",
  adGroups:
    "SELECT ad_group.id, ad_group.name, ad_group.status, ad_group.type, ad_group.campaign FROM ad_group",
  ads:
    "SELECT ad_group_ad.ad.id, ad_group_ad.ad.type, ad_group_ad.ad.final_urls, ad_group_ad.status, ad_group_ad.ad_group FROM ad_group_ad",
  keywords:
    "SELECT ad_group_criterion.criterion_id, ad_group_criterion.keyword.text, ad_group_criterion.keyword.match_type, ad_group_criterion.status, ad_group_criterion.ad_group FROM ad_group_criterion WHERE ad_group_criterion.type = 'KEYWORD'",
} as const;

/** Per-entity daily-metrics query for a date window (YYYY-MM-DD inclusive). */
export function metricsQuery(entity: AdsEntityType, since: string, until: string): string {
  const metrics =
    "metrics.impressions, metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value, segments.date";
  const where = `WHERE segments.date BETWEEN '${since}' AND '${until}'`;
  switch (entity) {
    case "campaign":
      return `SELECT campaign.id, ${metrics} FROM campaign ${where}`;
    case "ad_group":
      return `SELECT ad_group.id, ${metrics} FROM ad_group ${where}`;
    case "ad":
      return `SELECT ad_group_ad.ad.id, ${metrics} FROM ad_group_ad ${where}`;
    case "keyword":
      return `SELECT ad_group_criterion.criterion_id, ${metrics} FROM keyword_view ${where}`;
  }
}

/** Read the entity's external id out of a metrics row for the given level. */
export function metricEntityId(row: GaqlRow, entity: AdsEntityType): string {
  switch (entity) {
    case "campaign":
      return String(((row.campaign ?? {}) as Record<string, unknown>).id ?? "");
    case "ad_group":
      return String(((row.adGroup ?? {}) as Record<string, unknown>).id ?? "");
    case "ad": {
      const ad = (((row.adGroupAd ?? {}) as Record<string, unknown>).ad ?? {}) as Record<string, unknown>;
      return String(ad.id ?? "");
    }
    case "keyword":
      return String(((row.adGroupCriterion ?? {}) as Record<string, unknown>).criterionId ?? "");
  }
}

// ── Search terms (US-1706) ─────────────────────────────────────────────
export interface SearchTermRow {
  platform: string;
  owner_user_id: string | null;
  search_term: string;
  matched_keyword: string | null;
  match_type: string | null;
  campaign_external_id: string | null;
  ad_group_external_id: string | null;
  impressions: number;
  clicks: number;
  cost_micros: number;
  conversions: number;
  conversion_value: number;
  window_start: string;
  window_end: string;
}

export function searchTermsQuery(since: string, until: string): string {
  return "SELECT search_term_view.search_term, segments.keyword.info.text, " +
    "segments.keyword.info.match_type, campaign.id, ad_group.id, metrics.impressions, " +
    "metrics.clicks, metrics.cost_micros, metrics.conversions, metrics.conversions_value " +
    `FROM search_term_view WHERE segments.date BETWEEN '${since}' AND '${until}'`;
}

export function mapSearchTerm(
  row: GaqlRow,
  ownerUserId: string | null,
  since: string,
  until: string,
): SearchTermRow | null {
  const stv = (row.searchTermView ?? {}) as Record<string, unknown>;
  const term = typeof stv.searchTerm === "string" ? stv.searchTerm.trim() : "";
  if (!term) return null;
  const seg = (row.segments ?? {}) as Record<string, unknown>;
  const kw = ((seg.keyword ?? {}) as Record<string, unknown>).info as
    | { text?: string; matchType?: string }
    | undefined;
  const m = (row.metrics ?? {}) as Record<string, unknown>;
  return {
    platform: GOOGLE_ADS_PLATFORM,
    owner_user_id: ownerUserId,
    search_term: term,
    matched_keyword: str(kw?.text),
    match_type: str(kw?.matchType),
    campaign_external_id: String(((row.campaign ?? {}) as { id?: unknown }).id ?? "") || null,
    ad_group_external_id: String(((row.adGroup ?? {}) as { id?: unknown }).id ?? "") || null,
    impressions: num(m.impressions),
    clicks: num(m.clicks),
    cost_micros: num(m.costMicros),
    conversions: num(m.conversions),
    conversion_value: num(m.conversionsValue),
    window_start: since,
    window_end: until,
  };
}

// ── Orchestration ──────────────────────────────────────────────────────
export interface AdsSyncDeps {
  /** Runs a GAQL query and returns its result rows (inject runGaql bound to a token). */
  runQuery: (query: string) => Promise<GaqlRow[]>;
  supabase: SupabaseClient;
  ownerUserId?: string | null;
  /** Inclusive metric window; the route computes real dates. */
  since: string;
  until: string;
}

export interface AdsSyncCounts {
  campaigns: number;
  adGroups: number;
  ads: number;
  keywords: number;
  metrics: number;
  searchTerms: number;
}

async function upsertRows(
  supabase: SupabaseClient,
  table: string,
  rows: readonly unknown[],
  onConflict: string,
): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await supabase
    .from(table)
    .upsert(rows as Record<string, unknown>[], { onConflict, ignoreDuplicates: false });
  if (error) throw new Error(`${table} upsert failed: ${error.message}`);
  return rows.length;
}

/**
 * Pull structure + daily metrics and upsert snapshots. Returns per-entity counts.
 * Throws on a query/upsert failure — the caller records the failure on the
 * ads_sync_runs row.
 */
export async function syncGoogleAds(deps: AdsSyncDeps): Promise<AdsSyncCounts> {
  const { runQuery, supabase, since, until } = deps;
  const owner = deps.ownerUserId ?? null;

  // Structure.
  const campaigns = (await runQuery(STRUCTURE_QUERIES.campaigns)).map((r) => mapCampaign(r, owner));
  const adGroups = (await runQuery(STRUCTURE_QUERIES.adGroups)).map((r) => mapAdGroup(r, owner));
  const ads = (await runQuery(STRUCTURE_QUERIES.ads)).map((r) => mapAd(r, owner));
  const keywords = (await runQuery(STRUCTURE_QUERIES.keywords)).map((r) => mapKeyword(r, owner));

  const counts: AdsSyncCounts = {
    campaigns: await upsertRows(supabase, "ads_campaigns", campaigns, "platform,external_id"),
    adGroups: await upsertRows(supabase, "ads_ad_groups", adGroups, "platform,external_id"),
    ads: await upsertRows(supabase, "ads_ads", ads, "platform,external_id"),
    keywords: await upsertRows(supabase, "ads_keywords", keywords, "platform,external_id"),
    metrics: 0,
    searchTerms: 0,
  };

  // Daily metrics, per entity level.
  const entities: AdsEntityType[] = ["campaign", "ad_group", "ad", "keyword"];
  const metricRows: MetricRow[] = [];
  for (const entity of entities) {
    const rows = await runQuery(metricsQuery(entity, since, until));
    for (const row of rows) {
      const id = metricEntityId(row, entity);
      if (!id) continue;
      const mapped = mapMetric(row, entity, id, owner);
      if (mapped.metric_date) metricRows.push(mapped);
    }
  }
  counts.metrics = await upsertRows(
    supabase,
    "ads_metrics_daily",
    metricRows,
    "platform,entity_type,entity_id,metric_date",
  );

  // US-1706: search-terms report (queries that triggered our ads).
  const searchTermRows = (await runQuery(searchTermsQuery(since, until)))
    .map((r) => mapSearchTerm(r, owner, since, until))
    .filter((r): r is SearchTermRow => r !== null);
  counts.searchTerms = await upsertRows(
    supabase,
    "ads_search_terms",
    searchTermRows,
    "platform,ad_group_external_id,search_term",
  );

  return counts;
}
