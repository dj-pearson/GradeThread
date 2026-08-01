// US-1706: search-terms mining — waste/opportunity classification + rec rows.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildSearchTermRecommendationRows,
  DEFAULT_SEARCH_TERM_THRESHOLDS,
  mineSearchTerms,
  type SearchTermMetric,
} from "../lib/ads-search-terms.ts";

function term(p: Partial<SearchTermMetric>): SearchTermMetric {
  return {
    search_term: "vintage tee",
    matched_keyword: "tee",
    match_type: "BROAD",
    campaign_external_id: "c1",
    ad_group_external_id: "a1",
    clicks: 0,
    cost_micros: 0,
    conversions: 0,
    conversion_value: 0,
    ...p,
  };
}

Deno.test("mineSearchTerms flags zero-conversion spend as a negative", () => {
  const { negatives, opportunities } = mineSearchTerms(
    [term({ search_term: "free stuff", clicks: 20, cost_micros: 25_000_000, conversions: 0 })],
    DEFAULT_SEARCH_TERM_THRESHOLDS,
  );
  assertEquals(negatives.length, 1);
  assertEquals(negatives[0].term.search_term, "free stuff");
  assertEquals(negatives[0].spend, 25);
  assertEquals(opportunities.length, 0);
});

Deno.test("mineSearchTerms flags a converting non-exact query as an opportunity", () => {
  const { negatives, opportunities } = mineSearchTerms(
    [term({ search_term: "band tee vintage", match_type: "BROAD", clicks: 10, cost_micros: 8_000_000, conversions: 3 })],
    DEFAULT_SEARCH_TERM_THRESHOLDS,
  );
  assertEquals(opportunities.length, 1);
  assertEquals(opportunities[0].conversions, 3);
  assertEquals(negatives.length, 0);
});

Deno.test("mineSearchTerms ignores an exact-match converting query (already covered)", () => {
  const { opportunities } = mineSearchTerms(
    [term({ match_type: "EXACT", clicks: 10, cost_micros: 8_000_000, conversions: 3 })],
    DEFAULT_SEARCH_TERM_THRESHOLDS,
  );
  assertEquals(opportunities.length, 0);
});

Deno.test("mineSearchTerms respects the waste thresholds (low spend/clicks stays quiet)", () => {
  const { negatives } = mineSearchTerms(
    [term({ clicks: 2, cost_micros: 3_000_000, conversions: 0 })], // $3, 2 clicks — below thresholds
    DEFAULT_SEARCH_TERM_THRESHOLDS,
  );
  assertEquals(negatives.length, 0);
});

Deno.test("buildSearchTermRecommendationRows emits applyable negatives + report-only add_keyword", () => {
  const rows = buildSearchTermRecommendationRows(
    {
      negatives: [{ term: term({ search_term: "free", campaign_external_id: "c1" }), spend: 60 }],
      opportunities: [{ term: term({ search_term: "band tee", ad_group_external_id: "a1" }), conversions: 4 }],
    },
    "admin-1",
    "2026-07-07T00:00:00.000Z",
  );
  assertEquals(rows.length, 2);
  const neg = rows.find((r) => r.change_type === "add_negative_keyword");
  assert(neg);
  assertEquals(neg?.payload.campaignId, "c1");
  assertEquals(neg?.payload.text, "free");
  assertEquals(neg?.severity, "high"); // spend >= 50
  assertEquals(neg?.projected_impact.spend_saved, 60);
  const opp = rows.find((r) => r.change_type === "add_keyword");
  assert(opp);
  assertEquals(opp?.payload.adGroupId, "a1");
  assertEquals(opp?.status, "proposed");
});
