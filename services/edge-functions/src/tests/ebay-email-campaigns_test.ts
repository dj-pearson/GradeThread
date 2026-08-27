// US-2953: eBay Store follower campaigns.
//
// The rule this pins hardest is the Store detection. Guessing from the account
// produces the worst possible message — "you need an eBay Store" shown to a
// seller who has one — so it is read off eBay's own response, and the matcher
// is narrow enough that a token error never masquerades as a missing Store.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { isStoreRequiredError, normalizeEmailCampaign } = await import(
  "../lib/ebay-email-campaigns.ts"
);

Deno.test("normalizeEmailCampaign reads both id spellings eBay has used", () => {
  assertEquals(normalizeEmailCampaign({ campaignId: "c1", campaignName: "Spring" }).campaignId, "c1");
  assertEquals(normalizeEmailCampaign({ emailCampaignId: "c2", name: "Autumn" }).campaignId, "c2");
});

Deno.test("counts that arrive as strings become numbers, and junk becomes null", () => {
  const out = normalizeEmailCampaign({
    campaignId: "c1",
    audienceSize: "412",
    openCount: 88,
    clickCount: "n/a",
  });
  assertEquals(out.recipientCount, 412);
  assertEquals(out.opens, 88);
  assertEquals(out.clicks, null, "unreadable is null, never zero");
});

Deno.test("a campaign with no counts yet reads as null, not zero", () => {
  // A draft has not been sent. "0 opens" would read as a campaign that failed.
  const out = normalizeEmailCampaign({ campaignId: "c1", status: "DRAFT" });
  assertEquals(out.opens, null);
  assertEquals(out.recipientCount, null);
});

Deno.test("isStoreRequiredError recognises the gate", () => {
  assert(isStoreRequiredError({ status: 403 }));
  assert(isStoreRequiredError({ status: 400, message: "Requires an eBay Store subscription" }));
  assert(isStoreRequiredError({ status: 400, message: "Seller is not a Store seller" }));
});

Deno.test("isStoreRequiredError does NOT swallow a token or server failure", () => {
  // The worst message this feature can produce is "you need an eBay Store"
  // shown to a seller who has one.
  assertEquals(isStoreRequiredError({ status: 401, message: "Invalid access token" }), false);
  assertEquals(isStoreRequiredError({ status: 500, message: "Internal error" }), false);
  assertEquals(isStoreRequiredError({ status: 400, message: "Missing subject" }), false);
});
