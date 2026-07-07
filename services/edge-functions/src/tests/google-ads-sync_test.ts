// US-1698: Google Ads sync — GAQL-row → table-row mapping (cost_micros → dollars,
// resource-name → id) and the upsert orchestration, all with mocked data.
import { assert, assertEquals } from "@std/assert";
import {
  type AdsEntityType,
  mapAd,
  mapAdGroup,
  mapCampaign,
  mapKeyword,
  mapMetric,
  metricEntityId,
  metricsQuery,
  microsToDollars,
  resourceNameToId,
  STRUCTURE_QUERIES,
  syncGoogleAds,
} from "../lib/google-ads-sync.ts";
import type { GaqlRow } from "../lib/google-ads-client.ts";

Deno.test("resourceNameToId takes the last path segment", () => {
  assertEquals(resourceNameToId("customers/123/campaigns/456"), "456");
  assertEquals(resourceNameToId("customers/1/adGroups/9"), "9");
  assertEquals(resourceNameToId(undefined), "");
  assertEquals(resourceNameToId(42), "");
});

Deno.test("microsToDollars converts micros (string or number)", () => {
  assertEquals(microsToDollars(1_500_000), 1.5);
  assertEquals(microsToDollars("2000000"), 2);
  assertEquals(microsToDollars(undefined), 0);
  assertEquals(microsToDollars("nope"), 0);
});

Deno.test("mapCampaign maps id/name/status/channel + budget micros", () => {
  const row: GaqlRow = {
    campaign: { id: "111", name: "Brand", status: "ENABLED", advertisingChannelType: "SEARCH" },
    campaignBudget: { amountMicros: "5000000" },
  };
  const c = mapCampaign(row, "owner-1");
  assertEquals(c.platform, "google_ads");
  assertEquals(c.owner_user_id, "owner-1");
  assertEquals(c.external_id, "111");
  assertEquals(c.name, "Brand");
  assertEquals(c.channel_type, "SEARCH");
  assertEquals(c.budget_micros, 5_000_000);
});

Deno.test("mapAdGroup resolves the campaign resource name to an id", () => {
  const row: GaqlRow = {
    adGroup: { id: "222", name: "AG", status: "ENABLED", type: "SEARCH_STANDARD", campaign: "customers/1/campaigns/111" },
  };
  const g = mapAdGroup(row);
  assertEquals(g.external_id, "222");
  assertEquals(g.campaign_external_id, "111");
  assertEquals(g.type, "SEARCH_STANDARD");
});

Deno.test("mapAd maps nested ad + final urls + ad_group id", () => {
  const row: GaqlRow = {
    adGroupAd: {
      status: "ENABLED",
      adGroup: "customers/1/adGroups/222",
      ad: { id: "333", type: "RESPONSIVE_SEARCH_AD", finalUrls: ["https://x.test"] },
    },
  };
  const a = mapAd(row);
  assertEquals(a.external_id, "333");
  assertEquals(a.ad_group_external_id, "222");
  assertEquals(a.ad_type, "RESPONSIVE_SEARCH_AD");
  assertEquals(a.final_urls, ["https://x.test"]);
});

Deno.test("mapKeyword maps criterion id + keyword text/match", () => {
  const row: GaqlRow = {
    adGroupCriterion: {
      criterionId: "444",
      status: "ENABLED",
      adGroup: "customers/1/adGroups/222",
      keyword: { text: "vintage denim", matchType: "PHRASE" },
    },
  };
  const k = mapKeyword(row);
  assertEquals(k.external_id, "444");
  assertEquals(k.ad_group_external_id, "222");
  assertEquals(k.text, "vintage denim");
  assertEquals(k.match_type, "PHRASE");
});

Deno.test("mapMetric maps metrics + segments.date (cost stays micros)", () => {
  const row: GaqlRow = {
    campaign: { id: "111" },
    metrics: { impressions: "1000", clicks: "50", costMicros: "1500000", conversions: 3, conversionsValue: 120 },
    segments: { date: "2026-07-01" },
  };
  const m = mapMetric(row, "campaign", "111", "owner-1");
  assertEquals(m.entity_type, "campaign");
  assertEquals(m.entity_id, "111");
  assertEquals(m.metric_date, "2026-07-01");
  assertEquals(m.impressions, 1000);
  assertEquals(m.clicks, 50);
  assertEquals(m.cost_micros, 1_500_000);
  // The mapper keeps micros; microsToDollars is the display conversion.
  assertEquals(microsToDollars(m.cost_micros), 1.5);
  assertEquals(m.conversions, 3);
  assertEquals(m.conversion_value, 120);
});

Deno.test("metricsQuery + metricEntityId are consistent per entity level", () => {
  assert(metricsQuery("campaign", "2026-06-01", "2026-06-30").includes("FROM campaign"));
  assert(metricsQuery("keyword", "2026-06-01", "2026-06-30").includes("FROM keyword_view"));
  assert(metricsQuery("campaign", "2026-06-01", "2026-06-30").includes("BETWEEN '2026-06-01' AND '2026-06-30'"));
  assertEquals(metricEntityId({ campaign: { id: "9" } }, "campaign"), "9");
  assertEquals(metricEntityId({ adGroupCriterion: { criterionId: "7" } }, "keyword"), "7");
});

// A minimal fake supabase that records upsert calls and reports success.
function fakeSupabase() {
  const upserts: Array<{ table: string; rows: unknown[]; onConflict?: string }> = [];
  const client = {
    from(table: string) {
      return {
        upsert(rows: unknown[], opts?: { onConflict?: string }) {
          upserts.push({ table, rows, onConflict: opts?.onConflict });
          return Promise.resolve({ error: null });
        },
      };
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return { client, upserts };
}

Deno.test("syncGoogleAds maps + upserts structure and metrics idempotently", async () => {
  const { client, upserts } = fakeSupabase();
  const runQuery = (query: string): Promise<GaqlRow[]> => {
    if (query === STRUCTURE_QUERIES.campaigns) return Promise.resolve([{ campaign: { id: "111", name: "Brand" } }]);
    if (query === STRUCTURE_QUERIES.adGroups) return Promise.resolve([{ adGroup: { id: "222", campaign: "customers/1/campaigns/111" } }]);
    if (query === STRUCTURE_QUERIES.ads) return Promise.resolve([{ adGroupAd: { ad: { id: "333" }, adGroup: "customers/1/adGroups/222" } }]);
    if (query === STRUCTURE_QUERIES.keywords) return Promise.resolve([{ adGroupCriterion: { criterionId: "444", keyword: { text: "denim" } } }]);
    // Metrics queries (one per entity) — return a single dated row for campaigns only.
    if (query.includes("FROM campaign") && query.includes("BETWEEN")) {
      return Promise.resolve([{ campaign: { id: "111" }, metrics: { costMicros: "1000000" }, segments: { date: "2026-07-01" } }]);
    }
    return Promise.resolve([]);
  };

  const counts = await syncGoogleAds({
    runQuery,
    supabase: client,
    ownerUserId: "owner-1",
    since: "2026-06-07",
    until: "2026-07-07",
  });

  assertEquals(counts.campaigns, 1);
  assertEquals(counts.adGroups, 1);
  assertEquals(counts.ads, 1);
  assertEquals(counts.keywords, 1);
  assertEquals(counts.metrics, 1);

  // Metrics upsert must use the composite idempotency key.
  const metricUpsert = upserts.find((u) => u.table === "ads_metrics_daily");
  assert(metricUpsert);
  assertEquals(metricUpsert?.onConflict, "platform,entity_type,entity_id,metric_date");
  const campaignUpsert = upserts.find((u) => u.table === "ads_campaigns");
  assertEquals(campaignUpsert?.onConflict, "platform,external_id");
});

// Type-only export use so `AdsEntityType` stays referenced.
const _entities: AdsEntityType[] = ["campaign", "ad_group", "ad", "keyword"];
