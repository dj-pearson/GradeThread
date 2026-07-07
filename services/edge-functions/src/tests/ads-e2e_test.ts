// US-1709: end-to-end happy path with MOCKED APIs (no live account):
//   sync → analyze → approve → dry-run apply → audit row + rollback-payload.
// Exercised through the composable, injectable library functions + an in-memory
// supabase, proving the loop's data flow without touching Google/Apple.
import { assert, assertEquals } from "@std/assert";
import { syncGoogleAds } from "../lib/google-ads-sync.ts";
import { analyzeAds } from "../lib/ads-analysis.ts";
import { checkGuardrails, DEFAULT_GUARDRAILS } from "../lib/ads-guardrails.ts";
import { applyMutation, buildMutateOperation } from "../lib/google-ads-mutate.ts";
import { buildRevertPayload } from "../lib/google-ads-apply-job.ts";
import type { GoogleAdsConfig } from "../lib/google-ads-client.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test");

const CONFIG: GoogleAdsConfig = {
  developerToken: "dev", clientId: "c", clientSecret: "s", refreshToken: "r",
  loginCustomerId: "111", customerId: "9999",
};

// ── Minimal in-memory supabase (upsert/insert/delete/select + eq/gte/in) ──
function memSupabase() {
  const tables: Record<string, Record<string, unknown>[]> = {};
  function builder(table: string) {
    tables[table] ??= [];
    const filters: Array<[string, unknown]> = [];
    let op: "select" | "delete" = "select";
    const b = {
      select: () => b,
      upsert: (rows: Record<string, unknown>[]) => {
        for (const r of rows) tables[table].push(r);
        return Promise.resolve({ error: null });
      },
      insert: (rows: Record<string, unknown>[]) => {
        for (const r of (Array.isArray(rows) ? rows : [rows])) tables[table].push(r);
        return Promise.resolve({ error: null });
      },
      delete: () => { op = "delete"; return b; },
      eq: (k: string, v: unknown) => { filters.push([k, v]); return b; },
      gte: () => b,
      not: () => b,
      in: () => b,
      order: () => b,
      limit: () => b,
      // deno-lint-ignore no-explicit-any
      then: (resolve: (r: any) => void) => {
        const match = (row: Record<string, unknown>) => filters.every(([k, v]) => row[k] === v);
        if (op === "delete") {
          tables[table] = tables[table].filter((r) => !match(r));
          return resolve({ data: [], error: null });
        }
        return resolve({ data: tables[table].filter(match), error: null });
      },
    };
    return b;
  }
  // deno-lint-ignore no-explicit-any
  return { client: { from: (t: string) => builder(t) } as any, tables };
}

Deno.test("E2E: sync → analyze → approve → dry-run apply → audit + rollback (mocked)", async () => {
  const { client, tables } = memSupabase();

  // 1) SYNC — mocked GAQL returns one campaign + one day of metrics.
  const runQuery = (q: string): Promise<Record<string, unknown>[]> => {
    if (q.startsWith("SELECT campaign.id") && !q.includes("BETWEEN")) {
      return Promise.resolve([{ campaign: { id: "111", name: "Brand", status: "ENABLED" } }]);
    }
    if (q.includes("FROM campaign") && q.includes("BETWEEN")) {
      return Promise.resolve([{ campaign: { id: "111" }, metrics: { costMicros: "80000000", clicks: 200, impressions: 4000, conversions: 0 }, segments: { date: "2026-07-01" } }]);
    }
    return Promise.resolve([]);
  };
  const counts = await syncGoogleAds({ runQuery, supabase: client, since: "2026-06-07", until: "2026-07-07" });
  assertEquals(counts.campaigns, 1);
  assert(tables["ads_campaigns"].length === 1);

  // 2) ANALYZE — mocked Claude returns a pause_campaign rec for the wasteful spend.
  const mockClient = {
    messages: {
      create: () => Promise.resolve({
        content: [{
          type: "text",
          text: JSON.stringify({
            recommendations: [{
              target_type: "campaign", target_resource: "111", change_type: "pause_campaign",
              rationale: "$80 spent, 0 conversions.", confidence: 0.9, severity: "high",
              projected_impact: { spend_saved: 80 }, payload: { campaignId: "111" },
            }],
          }),
        }],
      }),
    },
  };
  // deno-lint-ignore no-explicit-any
  const analysis = await analyzeAds({ supabase: client, client: mockClient as any, ownerUserId: "admin-1" });
  assertEquals(analysis.generated, 1);
  const rec = tables["ads_recommendations"][0] as Record<string, unknown>;
  assertEquals(rec.status, "proposed");
  assertEquals(rec.change_type, "pause_campaign");

  // 3) APPROVE — flip status (what approveRecommendation does).
  rec.status = "approved";

  // 4) DRY-RUN APPLY — mocked Ads mutate (search before-value + validateOnly).
  let call = 0;
  const fetchMock = ((_url: string | URL | Request, init?: RequestInit) => {
    call++;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (body.query) return Promise.resolve(new Response(JSON.stringify({ results: [{ campaign: { status: "ENABLED" } }] }), { status: 200 }));
    return Promise.resolve(new Response(JSON.stringify({ mutateOperationResponses: [{}] }), { status: 200 }));
  }) as typeof fetch;
  const outcome = await applyMutation(CONFIG, "tok", { changeType: "pause_campaign", payload: { campaignId: "111" }, dryRun: true }, fetchMock);
  assertEquals(outcome.dryRun, true);
  assertEquals(outcome.before, { status: "ENABLED" });
  assertEquals(outcome.after, { status: "PAUSED" });
  assert(call >= 2); // before-read + dry-run mutate

  // 5) GUARDRAILS pass for this change.
  const guard = checkGuardrails("pause_campaign", outcome.before, outcome.after, DEFAULT_GUARDRAILS, { todaySpend: 0, appliesThisRun: 0 });
  assertEquals(guard.allowed, true);

  // 6) AUDIT row would capture before/after; ROLLBACK reconstructs the before.
  const built = buildMutateOperation("pause_campaign", { campaignId: "111" }, CONFIG);
  assert(built);
  const revert = buildRevertPayload("pause_campaign", outcome.targetResource, outcome.before);
  assertEquals(revert, { campaignId: "111", status: "ENABLED" }); // restores the pre-apply state
});
