// US-1708: Apple Search Ads guarded apply — allow-list, op building, dry-run
// (read-only) ordering, and revert-payload construction (mocked ASA client).
import { assert, assertEquals, assertRejects } from "@std/assert";
import {
  applyAppleMutation,
  buildAppleMutation,
  buildAppleRevertPayload,
  idsFromAppleResource,
  isAppleExecutableChangeType,
} from "../lib/apple-search-ads-mutate.ts";
import type { AppleSearchAdsConfig } from "../lib/apple-search-ads-client.ts";

const CONFIG: AppleSearchAdsConfig = {
  orgId: "1", keyId: "k", clientId: "c", teamId: "t", privateKey: "",
};

Deno.test("isAppleExecutableChangeType — status/bid/budget/negative yes; report-only no", () => {
  assert(isAppleExecutableChangeType("pause_campaign"));
  assert(isAppleExecutableChangeType("adjust_bid"));
  assert(isAppleExecutableChangeType("add_negative_keyword"));
  assert(!isAppleExecutableChangeType("add_keyword"));
  assert(!isAppleExecutableChangeType("fix_rsa_gap"));
  assert(!isAppleExecutableChangeType("adjust_tcpa")); // ASA has no tCPA change here
});

Deno.test("buildAppleMutation shapes a campaign pause + rejects bad payloads", () => {
  const op = buildAppleMutation("pause_campaign", { campaignId: "111" });
  assert(op);
  assertEquals(op!.method, "PUT");
  assertEquals(op!.path, "/campaigns/111");
  assertEquals((op!.body as { campaign: { status: string } }).campaign.status, "PAUSED");
  assertEquals(op!.afterValue, { status: "PAUSED" });

  assertEquals(buildAppleMutation("pause_campaign", {}), null);
  assertEquals(buildAppleMutation("adjust_bid", { campaignId: "1", adGroupId: "2", keywordId: "3" }), null); // no bid
  assertEquals(buildAppleMutation("add_keyword", { campaignId: "1" }), null); // not executable
});

function mockRequest(getData: Record<string, unknown> = {}) {
  const calls: Array<{ method: string; path: string }> = [];
  const fn = (<T>(method: "GET" | "POST" | "PUT", path: string): Promise<T> => {
    calls.push({ method, path });
    return Promise.resolve((method === "GET" ? getData : { ok: true }) as T);
  });
  return { fn, calls };
}

Deno.test("applyAppleMutation rejects a non-allow-listed type (nothing sent)", async () => {
  const { fn, calls } = mockRequest();
  await assertRejects(
    () => applyAppleMutation(CONFIG, "tok", { changeType: "add_keyword", payload: { campaignId: "1" }, dryRun: true }, fn),
    Error,
    "not allow-listed",
  );
  assertEquals(calls.length, 0);
});

Deno.test("applyAppleMutation dry-run reads the before-value but does NOT mutate", async () => {
  const { fn, calls } = mockRequest({ data: { status: "ENABLED" } });
  const outcome = await applyAppleMutation(CONFIG, "tok", { changeType: "pause_campaign", payload: { campaignId: "111" }, dryRun: true }, fn);
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "GET"); // before-read only, no PUT
  assertEquals(outcome.dryRun, true);
  assertEquals(outcome.before, { status: "ENABLED" });
  assertEquals(outcome.after, { status: "PAUSED" });
});

Deno.test("applyAppleMutation real apply reads before then PUTs", async () => {
  const { fn, calls } = mockRequest({ data: { status: "ENABLED" } });
  await applyAppleMutation(CONFIG, "tok", { changeType: "pause_campaign", payload: { campaignId: "111" }, dryRun: false }, fn);
  assertEquals(calls.length, 2);
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[1].method, "PUT");
});

Deno.test("buildAppleRevertPayload + idsFromAppleResource reconstruct the before-value", () => {
  assertEquals(idsFromAppleResource("campaigns/111"), { campaignId: "111" });
  assertEquals(
    idsFromAppleResource("campaigns/111/adgroups/222/targetingkeywords/333"),
    { campaignId: "111", adGroupId: "222", keywordId: "333" },
  );
  assertEquals(
    buildAppleRevertPayload("pause_campaign", "campaigns/111", { status: "ENABLED" }),
    { campaignId: "111", status: "ENABLED" },
  );
  assertEquals(
    buildAppleRevertPayload("adjust_bid", "campaigns/111/adgroups/222/targetingkeywords/333", { amount: "1.50", currency: "USD" }),
    { campaignId: "111", adGroupId: "222", keywordId: "333", bidAmount: "1.50", currency: "USD" },
  );
  assertEquals(buildAppleRevertPayload("add_negative_keyword", "campaigns/111/adgroups/222", {}), null);
});
