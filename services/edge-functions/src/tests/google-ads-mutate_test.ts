// US-1703: guarded apply — allow-list rejection, dry-run-before-apply ordering,
// operation building, and revert-payload construction (mocked Ads client).
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  applyMutation,
  buildMutateOperation,
  isExecutableChangeType,
} from "../lib/google-ads-mutate.ts";
import type { GoogleAdsConfig } from "../lib/google-ads-client.ts";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test");

const CONFIG: GoogleAdsConfig = {
  developerToken: "dev",
  clientId: "cid",
  clientSecret: "sec",
  refreshToken: "ref",
  loginCustomerId: "111",
  customerId: "9999",
};

function mockFetch(searchRows: Record<string, unknown>[] = [], mutateStatus = 200) {
  const calls: Array<{ url: string; validateOnly?: boolean; kind: "search" | "mutate" }> = [];
  const fn = ((input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (url.includes(":search")) {
      calls.push({ url, kind: "search" });
      return Promise.resolve(new Response(JSON.stringify({ results: searchRows }), { status: 200 }));
    }
    calls.push({ url, kind: "mutate", validateOnly: body.validateOnly });
    return Promise.resolve(new Response(JSON.stringify({ mutateOperationResponses: [{}] }), { status: mutateStatus }));
  }) as typeof fetch;
  return { fn, calls };
}

Deno.test("isExecutableChangeType allows the mutate set, rejects report-only", () => {
  assert(isExecutableChangeType("pause_campaign"));
  assert(isExecutableChangeType("adjust_budget"));
  assert(!isExecutableChangeType("fix_rsa_gap"));
  assert(!isExecutableChangeType("totally_made_up"));
});

Deno.test("buildMutateOperation shapes a campaign pause + rejects bad payloads", () => {
  const op = buildMutateOperation("pause_campaign", { campaignId: "111" }, CONFIG);
  assert(op);
  const campaignOp = (op!.op as { campaignOperation: { update: { status: string }; updateMask: string } }).campaignOperation;
  assertEquals(campaignOp.update.status, "PAUSED");
  assertEquals(campaignOp.updateMask, "status");
  assert(op!.beforeQuery?.includes("campaign.status"));
  assertEquals(op!.afterValue, { status: "PAUSED" });

  // Missing id / non-listed type / missing budget amount → null.
  assertEquals(buildMutateOperation("pause_campaign", {}, CONFIG), null);
  assertEquals(buildMutateOperation("fix_rsa_gap", { anything: 1 }, CONFIG), null);
  assertEquals(buildMutateOperation("adjust_budget", { campaignBudgetId: "5" }, CONFIG), null);
});

Deno.test("applyMutation rejects a non-allow-listed change type (nothing sent)", async () => {
  const { fn, calls } = mockFetch();
  await assertRejects(
    () => applyMutation(CONFIG, "tok", { changeType: "fix_rsa_gap", payload: {}, dryRun: true }, fn),
    Error,
    "not allow-listed",
  );
  assertEquals(calls.length, 0);
});

Deno.test("applyMutation runs the dry-run BEFORE the real mutate", async () => {
  const { fn, calls } = mockFetch([{ campaign: { status: "ENABLED" } }]);
  const outcome = await applyMutation(CONFIG, "tok", { changeType: "pause_campaign", payload: { campaignId: "111" }, dryRun: false }, fn);

  // before-value read first, then dry-run mutate, then real mutate.
  assertEquals(calls[0].kind, "search");
  const mutates = calls.filter((c) => c.kind === "mutate");
  assertEquals(mutates.length, 2);
  assertEquals(mutates[0].validateOnly, true); // dry-run FIRST
  assertEquals(mutates[1].validateOnly, false); // then real
  assertEquals(outcome.before, { status: "ENABLED" });
  assertEquals(outcome.after, { status: "PAUSED" });
  assertEquals(outcome.success, true);
});

Deno.test("applyMutation with dryRun=true does the dry-run only (no real mutate)", async () => {
  const { fn, calls } = mockFetch([{ campaign: { status: "ENABLED" } }]);
  const outcome = await applyMutation(CONFIG, "tok", { changeType: "pause_campaign", payload: { campaignId: "111" }, dryRun: true }, fn);
  const mutates = calls.filter((c) => c.kind === "mutate");
  assertEquals(mutates.length, 1);
  assertEquals(mutates[0].validateOnly, true);
  assertEquals(outcome.dryRun, true);
});

Deno.test("buildRevertPayload reconstructs the before-value for update types", async () => {
  const { buildRevertPayload, idsFromResource } = await import("../lib/google-ads-apply-job.ts");

  assertEquals(idsFromResource("customers/9999/campaigns/111"), { campaignId: "111" });
  assertEquals(idsFromResource("customers/9999/adGroupCriteria/22~33"), { adGroupId: "22", criterionId: "33" });

  assertEquals(
    buildRevertPayload("pause_campaign", "customers/9999/campaigns/111", { status: "ENABLED" }),
    { campaignId: "111", status: "ENABLED" },
  );
  assertEquals(
    buildRevertPayload("adjust_budget", "customers/9999/campaignBudgets/5", { amountMicros: "1000000" }),
    { campaignBudgetId: "5", amountMicros: "1000000" },
  );
  // Create-type rollback is not auto-supported.
  assertEquals(buildRevertPayload("add_negative_keyword", "customers/9999/campaigns/111", {}), null);
});
