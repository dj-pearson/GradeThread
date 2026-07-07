// US-1706: search-terms mining.
//
// Deterministic (non-LLM) classification of the search-terms snapshot into:
//   • WASTE  — a query that spent with zero conversions → negative-keyword rec
//              (change_type add_negative_keyword, applyable via US-1703)
//   • OPPORTUNITY — a converting query not already covered by an exact keyword →
//              report-only add_keyword rec (operator adds it via Copy Studio)
// Thresholds live in system_settings. The classifier is pure + unit-tested.

import type { SupabaseClient } from "@supabase/supabase-js";
import { getSetting } from "./system-settings.ts";
import { microsToDollars } from "./google-ads-sync.ts";

export const ADS_SEARCH_TERM_SETTING_KEY = "ads_search_term_thresholds";

export interface SearchTermThresholds {
  /** Min spend (dollars) for a zero-conversion query to become a negative. */
  minWasteCost: number;
  /** Min clicks for a zero-conversion query to become a negative. */
  minWasteClicks: number;
  /** Min conversions for a non-exact query to become an opportunity. */
  minOpportunityConversions: number;
}

export const DEFAULT_SEARCH_TERM_THRESHOLDS: SearchTermThresholds = {
  minWasteCost: 10,
  minWasteClicks: 5,
  minOpportunityConversions: 1,
};

export async function getSearchTermThresholds(): Promise<SearchTermThresholds> {
  const t = await getSetting<Partial<SearchTermThresholds>>(ADS_SEARCH_TERM_SETTING_KEY, {});
  return {
    minWasteCost: num(t.minWasteCost, DEFAULT_SEARCH_TERM_THRESHOLDS.minWasteCost),
    minWasteClicks: num(t.minWasteClicks, DEFAULT_SEARCH_TERM_THRESHOLDS.minWasteClicks),
    minOpportunityConversions: num(t.minOpportunityConversions, DEFAULT_SEARCH_TERM_THRESHOLDS.minOpportunityConversions),
  };
}

function num(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

export interface SearchTermMetric {
  search_term: string;
  matched_keyword: string | null;
  match_type: string | null;
  campaign_external_id: string | null;
  ad_group_external_id: string | null;
  clicks: number;
  cost_micros: number;
  conversions: number;
  conversion_value: number;
}

export interface MinedTerms {
  negatives: Array<{ term: SearchTermMetric; spend: number }>;
  opportunities: Array<{ term: SearchTermMetric; conversions: number }>;
}

/** Classify search-term rows into waste (negatives) + opportunities. */
export function mineSearchTerms(rows: SearchTermMetric[], t: SearchTermThresholds): MinedTerms {
  const negatives: MinedTerms["negatives"] = [];
  const opportunities: MinedTerms["opportunities"] = [];
  for (const row of rows) {
    const spend = microsToDollars(row.cost_micros);
    const conversions = Number(row.conversions) || 0;
    const clicks = Number(row.clicks) || 0;

    // Waste: spent (clicks + cost) with zero conversions.
    if (conversions === 0 && spend >= t.minWasteCost && clicks >= t.minWasteClicks) {
      negatives.push({ term: row, spend });
      continue;
    }
    // Opportunity: converting query NOT already an exact-match keyword.
    const isExact = (row.match_type ?? "").toUpperCase() === "EXACT";
    if (conversions >= t.minOpportunityConversions && !isExact) {
      opportunities.push({ term: row, conversions });
    }
  }
  return { negatives, opportunities };
}

/** Row shape for an ads_recommendations insert (matches analyzeAds' rows). */
export interface RecommendationInsert {
  platform: string;
  owner_user_id: string | null;
  target_type: string;
  target_resource: string;
  target_name: string | null;
  change_type: string;
  rationale: string;
  confidence: number;
  projected_impact: Record<string, number>;
  payload: Record<string, unknown>;
  severity: string;
  status: string;
  generated_at: string;
}

/** Turn mined terms into proposed recommendation rows. */
export function buildSearchTermRecommendationRows(
  mined: MinedTerms,
  ownerUserId: string | null,
  generatedAt: string,
): RecommendationInsert[] {
  const rows: RecommendationInsert[] = [];
  for (const n of mined.negatives) {
    rows.push({
      platform: "google_ads",
      owner_user_id: ownerUserId,
      target_type: "keyword",
      target_resource: n.term.campaign_external_id ?? "",
      target_name: n.term.search_term,
      change_type: "add_negative_keyword",
      rationale: `"${n.term.search_term}" spent $${n.spend.toFixed(2)} with no conversions — add as a negative.`,
      confidence: 0.8,
      projected_impact: { spend_saved: round2(n.spend) },
      payload: { campaignId: n.term.campaign_external_id ?? "", text: n.term.search_term, matchType: "EXACT" },
      severity: n.spend >= 50 ? "high" : "medium",
      status: "proposed",
      generated_at: generatedAt,
    });
  }
  for (const o of mined.opportunities) {
    rows.push({
      platform: "google_ads",
      owner_user_id: ownerUserId,
      target_type: "keyword",
      target_resource: o.term.ad_group_external_id ?? "",
      target_name: o.term.search_term,
      change_type: "add_keyword",
      rationale: `"${o.term.search_term}" converted ${o.conversions}× but isn't an exact keyword — consider adding it.`,
      confidence: 0.7,
      projected_impact: { conversions: round2(o.conversions) },
      payload: { text: o.term.search_term, adGroupId: o.term.ad_group_external_id ?? "", matchType: "EXACT" },
      severity: "medium",
      status: "proposed",
      generated_at: generatedAt,
    });
  }
  return rows;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Read the search-terms snapshot + build the recommendation rows to insert. */
export async function mineSearchTermRecommendations(
  supabase: SupabaseClient,
  ownerUserId: string | null,
  generatedAt: string,
): Promise<RecommendationInsert[]> {
  const { data, error } = await supabase
    .from("ads_search_terms")
    .select("search_term, matched_keyword, match_type, campaign_external_id, ad_group_external_id, clicks, cost_micros, conversions, conversion_value")
    .eq("platform", "google_ads")
    .order("cost_micros", { ascending: false })
    .limit(2000);
  if (error || !data) return [];
  const mined = mineSearchTerms(data as SearchTermMetric[], await getSearchTermThresholds());
  return buildSearchTermRecommendationRows(mined, ownerUserId, generatedAt);
}
