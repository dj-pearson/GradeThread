import { assertEquals } from "@std/assert";

// US-2641: the relist that reported success and did nothing.
//
// A seller repriced a live eBay listing, ended it in FlipDesk, found it still
// live on eBay, ended it by hand in Seller Hub, and relisted from FlipDesk. The
// relist answered success, nothing went up, and "View on eBay" pointed at the
// listing they had just ended. Every step below is one of the inferences that
// made that possible.
//
// ebay-client.ts imports the service-role supabase client at load, so set dummy
// env BEFORE the dynamic import (same pattern as offer-already-ended_test).
Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const { livePublishedListingId, isOfferBoundToDeadListing, isOfferAlreadyEndedError } =
  await import("../lib/ebay-client.ts");

function ebayErr(status: number, message = "boom"): Error & { status: number } {
  const e = new Error(message) as Error & { status: number };
  e.status = status;
  return e;
}

// ── The adopt check ────────────────────────────────────────────────────────
// eBay does not clear offer.listing.listingId when a listing ends, so "has a
// listingId" was never the same question as "is live". The listingStatus rule
// caught the cases where eBay says so; this is the case where it does not.

Deno.test("an UNPUBLISHED offer is not live, whatever listingId it remembers", () => {
  assertEquals(
    livePublishedListingId({
      status: "UNPUBLISHED",
      listing: { listingId: "1101" },
    }),
    null,
  );
});

Deno.test("an UNPUBLISHED offer is not live even when eBay calls the listing ACTIVE", () => {
  // The exact shape a seller-side end leaves behind: the offer is back to
  // unpublished and the listing sub-object is stale.
  assertEquals(
    livePublishedListingId({
      status: "UNPUBLISHED",
      listing: { listingId: "1102", listingStatus: "ACTIVE" },
    }),
    null,
  );
});

Deno.test("a PUBLISHED offer still adopts (the US-464 duplicate guard survives)", () => {
  assertEquals(
    livePublishedListingId({ status: "PUBLISHED", listing: { listingId: "1103" } }),
    "1103",
  );
});

Deno.test("a MISSING offer status still adopts — unknown takes the safe side", () => {
  // Refusing to adopt a live listing costs a DUPLICATE live listing, which is
  // not recoverable; adopting a dead one costs a visible no-publish. Unknown
  // keeps the pre-existing behaviour.
  assertEquals(livePublishedListingId({ listing: { listingId: "1104" } }), "1104");
  assertEquals(
    livePublishedListingId({ status: null, listing: { listingId: "1105" } }),
    "1105",
  );
  assertEquals(
    livePublishedListingId({ status: "   ", listing: { listingId: "1106" } }),
    "1106",
  );
});

Deno.test("a dead listingStatus still wins, with or without an offer status", () => {
  for (const s of ["ENDED", "INACTIVE", "COMPLETED", "CANCELLED", "CANCELED"]) {
    assertEquals(
      livePublishedListingId({ status: "PUBLISHED", listing: { listingId: "9", listingStatus: s } }),
      null,
      `${s} should not be adoptable`,
    );
  }
});

Deno.test("no listingId is never live", () => {
  assertEquals(livePublishedListingId({ status: "PUBLISHED", listing: {} }), null);
  assertEquals(livePublishedListingId({}), null);
});

// ── The stuck-offer check ──────────────────────────────────────────────────
// eBay answers 25001 to every re-publish of an offer bound to a dead listing.
// The publish path recreates such an offer instead of retrying it forever, so
// this predicate has to be exact about which offers it destroys.

Deno.test("an offer bound to a dead listing is recognised", () => {
  assertEquals(
    isOfferBoundToDeadListing({ status: "UNPUBLISHED", listing: { listingId: "2201" } }),
    true,
  );
  assertEquals(
    isOfferBoundToDeadListing({
      listing: { listingId: "2202", listingStatus: "ENDED" },
    }),
    true,
  );
});

Deno.test("a live offer is NOT recreated (that would end the seller's listing)", () => {
  assertEquals(
    isOfferBoundToDeadListing({ status: "PUBLISHED", listing: { listingId: "2203" } }),
    false,
  );
});

Deno.test("an offer that merely failed to publish is left alone", () => {
  // A missing item specific leaves a fresh, never-published offer with no
  // listingId. Recreating it on every rejection would churn the offer id for
  // nothing and lose the syncExistingOffer correction that actually fixes it.
  assertEquals(isOfferBoundToDeadListing({ status: "UNPUBLISHED", listing: {} }), false);
  assertEquals(isOfferBoundToDeadListing({ status: "UNPUBLISHED" }), false);
  assertEquals(isOfferBoundToDeadListing({}), false);
});

// ── The withdraw classification ────────────────────────────────────────────
// "eBay refused the withdraw" was read as "the listing is not live", which
// marks the row ended while buyers can still buy. 401/403 say nothing about the
// listing at all.

Deno.test("401 / 403 are facts about the caller, not about the listing", () => {
  assertEquals(isOfferAlreadyEndedError(ebayErr(401)), false);
  assertEquals(
    isOfferAlreadyEndedError(ebayErr(403, "Insufficient permissions to fulfill the request.")),
    false,
  );
});

Deno.test("the other 4xx classifications are unchanged", () => {
  assertEquals(isOfferAlreadyEndedError(ebayErr(400)), true);
  assertEquals(isOfferAlreadyEndedError(ebayErr(404)), true);
  assertEquals(isOfferAlreadyEndedError(ebayErr(409)), true);
  assertEquals(isOfferAlreadyEndedError(ebayErr(429)), false);
  assertEquals(isOfferAlreadyEndedError(ebayErr(500)), false);
});
