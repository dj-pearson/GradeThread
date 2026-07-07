// US-1701: Claude ads analysis — input shaping, recommendation validation +
// parsing, and a report-only analyzeAds run with a MOCKED model + fake DB.
import { assert, assertEquals } from "@std/assert";
import {
  analyzeAds,
  buildAnalysisInput,
  buildSystemPrompt,
  parseRecommendations,
  validateRecommendation,
  type AnalysisSnapshot,
} from "../lib/ads-analysis.ts";
import type { RawMetric } from "../lib/google-ads-overview.ts";

function metric(entity_id: string, cost_micros: number, extra: Partial<RawMetric> = {}): RawMetric {
  return {
    entity_id,
    metric_date: "2026-07-01",
    impressions: 0,
    clicks: 0,
    cost_micros,
    conversions: 0,
    conversion_value: 0,
    ...extra,
  };
}

Deno.test("buildAnalysisInput shapes account/campaigns/keywords (PII-free)", () => {
  const snap: AnalysisSnapshot = {
    campaignMetrics: [metric("c1", 10_000_000, { clicks: 100 })],
    keywordMetrics: [metric("k1", 4_000_000, { clicks: 20 })],
    campaigns: [{ external_id: "c1", name: "Brand", status: "ENABLED" }],
    keywords: [{ external_id: "k1", text: "vintage denim", match_type: "PHRASE", ad_group_external_id: "a1" }],
    conversionCount: 5,
    conversionValue: 150,
    windowDays: 30,
  };
  const input = buildAnalysisInput(snap);
  assertEquals(input.windowDays, 30);
  assertEquals(input.account.spend, 10);
  assertEquals(input.conversions, { count: 5, value: 150 });
  assertEquals(input.campaigns[0].name, "Brand");
  assertEquals(input.keywords[0].text, "vintage denim");
  assertEquals(input.keywords[0].spend, 4);
});

Deno.test("validateRecommendation accepts a well-formed rec, clamps confidence", () => {
  const rec = validateRecommendation({
    target_type: "campaign",
    target_resource: "c1",
    target_name: "Brand",
    change_type: "pause_campaign",
    rationale: "Spends with zero conversions over 30 days.",
    confidence: 1.4,
    severity: "high",
    projected_impact: { spend_saved: 42.5, junk: "x" },
    payload: { campaignId: "c1" },
  });
  assert(rec);
  assertEquals(rec?.confidence, 1); // clamped
  assertEquals(rec?.change_type, "pause_campaign");
  assertEquals(rec?.projected_impact, { spend_saved: 42.5 }); // non-number dropped
});

Deno.test("validateRecommendation rejects bad enum / missing rationale", () => {
  assertEquals(validateRecommendation({ target_type: "campaign", change_type: "delete_everything", rationale: "x" }), null);
  assertEquals(validateRecommendation({ target_type: "galaxy", change_type: "pause_campaign", rationale: "x" }), null);
  assertEquals(validateRecommendation({ target_type: "campaign", change_type: "pause_campaign", rationale: "  " }), null);
  assertEquals(validateRecommendation(null), null);
});

Deno.test("parseRecommendations handles wrapper, array, code fence, junk", () => {
  const ok = parseRecommendations(JSON.stringify({
    recommendations: [
      { target_type: "keyword", target_resource: "k1", change_type: "add_negative_keyword", rationale: "No conversions." },
      { target_type: "nope", change_type: "x", rationale: "bad" },
    ],
  }));
  assertEquals(ok.length, 1);
  assertEquals(ok[0].severity, "medium"); // default
  assertEquals(parseRecommendations("```json\n[]\n```").length, 0);
  assertEquals(parseRecommendations("not json").length, 0);
});

Deno.test("buildSystemPrompt carries the injection-defense instruction", () => {
  const sys = buildSystemPrompt();
  assert(sys.includes("UNTRUSTED"));
  assert(sys.toLowerCase().includes("never"));
});

// Chainable fake supabase keyed by table (+ entity_type for metrics).
function fakeSupabase(dataByKey: Record<string, unknown[]>) {
  const inserted: Array<{ table: string; rows: unknown[] }> = [];
  const deleted: Array<{ table: string }> = [];
  function builder(table: string) {
    const state: { op: string; entityType?: string } = { op: "select" };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (rows: unknown[]) => {
        inserted.push({ table, rows });
        return Promise.resolve({ error: null });
      },
      delete: () => {
        state.op = "delete";
        return b;
      },
      eq: (k: string, v: string) => {
        if (k === "entity_type") state.entityType = v;
        return b;
      },
      gte: () => b,
      not: () => b,
      order: () => b,
      limit: () => b,
      then: (resolve: (r: { data: unknown[]; error: null }) => void) => {
        if (state.op === "delete") {
          deleted.push({ table });
          return resolve({ data: [], error: null });
        }
        const key = state.entityType ? `${table}:${state.entityType}` : table;
        return resolve({ data: dataByKey[key] ?? [], error: null });
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { client: { from: (t: string) => builder(t) } as any, inserted, deleted };
}

Deno.test("analyzeAds is report-only: writes recommendations, no mutate", async () => {
  const { client, inserted, deleted } = fakeSupabase({
    "ads_metrics_daily:campaign": [metric("c1", 20_000_000, { clicks: 200 })],
    "ads_metrics_daily:keyword": [metric("k1", 5_000_000)],
    "ads_campaigns": [{ external_id: "c1", name: "Brand", status: "ENABLED" }],
    "ads_keywords": [{ external_id: "k1", text: "denim", match_type: "PHRASE", ad_group_external_id: "a1" }],
    "ad_click_attributions": [{ value: 30 }, { value: 30 }],
  });

  const mockClient = {
    messages: {
      create: () =>
        Promise.resolve({
          content: [{
            type: "text",
            text: JSON.stringify({
              recommendations: [{
                target_type: "campaign",
                target_resource: "c1",
                change_type: "adjust_budget",
                rationale: "Strong ROAS — scale budget.",
                confidence: 0.8,
                severity: "high",
                projected_impact: { conv_delta: 5 },
                payload: { campaignId: "c1", newBudgetMicros: 30000000 },
              }],
            }),
          }],
        }),
    },
  };

  const result = await analyzeAds({
    supabase: client,
    // deno-lint-ignore no-explicit-any
    client: mockClient as any,
    ownerUserId: "admin-1",
  });

  assertEquals(result.generated, 1);
  // Replaced open proposals, then inserted the new set.
  assert(deleted.some((d) => d.table === "ads_recommendations"));
  const ins = inserted.find((i) => i.table === "ads_recommendations");
  assert(ins);
  assertEquals((ins!.rows as Array<{ status: string }>)[0].status, "proposed");
});

Deno.test("analyzeAds skips the model call when there's no data", async () => {
  const { client, inserted } = fakeSupabase({});
  let called = false;
  const mockClient = { messages: { create: () => { called = true; return Promise.resolve({ content: [] }); } } };
  const result = await analyzeAds({
    supabase: client,
    // deno-lint-ignore no-explicit-any
    client: mockClient as any,
  });
  assertEquals(result.generated, 0);
  assertEquals(called, false);
  assertEquals(inserted.length, 0);
});
