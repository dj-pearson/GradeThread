// US-2946/2947/2948: the campaign operations FlipDesk could not perform.
//
// The test weight is almost entirely on normalizeBulkResponse, because eBay's
// bulk endpoints return 200 while rejecting half the batch. Collapsing that
// into a single ok is the silent-success shape this codebase keeps running
// into: the seller believes a hundred items are promoted, forty are not, and
// nothing says which.
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  BULK_AD_BATCH_SIZE,
  batched,
  isCampaignAlreadyInState,
  normalizeBulkResponse,
  normalizeSuggestedItem,
} = await import("../lib/ebay-campaign-ops.ts");

Deno.test("normalizeBulkResponse reports every listing, success and failure alike", () => {
  const out = normalizeBulkResponse(["a", "b"], {
    responses: [
      { listingId: "a", adId: "ad1", statusCode: 200 },
      {
        listingId: "b",
        statusCode: 400,
        errors: [{ longMessage: "Listing is not eligible for promotion." }],
      },
    ],
  });
  assertEquals(out.length, 2);
  assertEquals(out[0], { listingId: "a", ok: true, error: null, adId: "ad1" });
  assertEquals(out[1]!.ok, false);
  assertEquals(out[1]!.error, "Listing is not eligible for promotion.");
});

Deno.test("a listing eBay says NOTHING about is a failure, not a success", () => {
  // The direction that matters. Reporting silence as success is how forty
  // unpromoted listings look promoted.
  const out = normalizeBulkResponse(["a", "missing"], {
    responses: [{ listingId: "a", adId: "ad1", statusCode: 200 }],
  });
  assertEquals(out[1]!.ok, false);
  assert(out[1]!.error!.includes("did not answer"));
});

Deno.test("a response for a listing that was not requested is dropped", () => {
  const out = normalizeBulkResponse(["a"], {
    responses: [
      { listingId: "a", adId: "ad1", statusCode: 200 },
      { listingId: "stranger", adId: "ad9", statusCode: 200 },
    ],
  });
  assertEquals(out.map((r) => r.listingId), ["a"]);
});

Deno.test("an error with no status code still reads as a failure", () => {
  const out = normalizeBulkResponse(["a"], {
    responses: [{ listingId: "a", errors: [{ message: "Nope." }] }],
  });
  assertEquals(out[0]!.ok, false);
  assertEquals(out[0]!.error, "Nope.");
});

Deno.test("an empty response marks every requested listing as unanswered", () => {
  const out = normalizeBulkResponse(["a", "b", "c"], {});
  assertEquals(out.filter((r) => r.ok).length, 0);
});

Deno.test("batched respects eBay's ceiling and loses nothing", () => {
  const items = Array.from({ length: BULK_AD_BATCH_SIZE * 2 + 3 }, (_, i) => i);
  const chunks = batched(items);
  assertEquals(chunks.length, 3);
  assertEquals(chunks[0]!.length, BULK_AD_BATCH_SIZE);
  assertEquals(chunks[2]!.length, 3);
  assertEquals(chunks.flat().length, items.length);
  assertEquals(batched([]).length, 0);
});

Deno.test("normalizeSuggestedItem reads either spelling and tolerates neither", () => {
  assertEquals(
    normalizeSuggestedItem({ listingId: "l1", suggestedBidPercentage: "4.5" }),
    { listingId: "l1", suggestedBidPercentage: 4.5 },
  );
  assertEquals(normalizeSuggestedItem({ listingId: "l2", bidPercentage: 3 }).suggestedBidPercentage, 3);
  assertEquals(normalizeSuggestedItem({ listingId: "l3" }).suggestedBidPercentage, null);
});

Deno.test("isCampaignAlreadyInState is narrow: a real failure stays a failure", () => {
  assert(isCampaignAlreadyInState({ status: 404 }));
  assert(isCampaignAlreadyInState({ status: 400, message: "Campaign is already PAUSED" }));
  assert(isCampaignAlreadyInState({ status: 400, message: "Invalid campaign status" }));
  // Telling a seller their campaign is paused when the call actually failed
  // means it keeps spending.
  assertEquals(isCampaignAlreadyInState({ status: 401, message: "Invalid access token" }), false);
  assertEquals(isCampaignAlreadyInState({ status: 500, message: "Internal error" }), false);
});
