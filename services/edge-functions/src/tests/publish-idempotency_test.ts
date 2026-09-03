// US-528: the offer-already-exists detector must key off eBay's structured
// errorId (25002), not a brittle message regex, so it keeps working when eBay
// rewords/localizes the message — while still falling back to the message
// heuristic for non-JSON error bodies.

// ebay-client.ts imports the service-role supabase client at load, so set
// dummy env BEFORE the dynamic import (same pattern as ebay-auth-failure_test).
//   deno test --allow-env src/tests/publish-idempotency_test.ts
import { assert, assertEquals } from "@std/assert";

Deno.env.set("SUPABASE_URL", Deno.env.get("SUPABASE_URL") ?? "http://localhost:54321");
Deno.env.set(
  "SUPABASE_SERVICE_ROLE_KEY",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "test-service-key",
);

const {
  isOfferAlreadyExistsError,
  livePublishedListingId,
  isOfferNotFoundError,
  OFFER_ALREADY_EXISTS_ERROR_ID,
  OFFER_NOT_AVAILABLE_ERROR_ID,
  publishOrAdoptOffer,
} = await import("../lib/ebay-client.ts");

function ebayErr(
  message: string,
  ebayErrorIds?: number[],
): Error & { ebayErrorIds?: number[] } {
  const e = new Error(message) as Error & { ebayErrorIds?: number[] };
  if (ebayErrorIds) e.ebayErrorIds = ebayErrorIds;
  return e;
}

Deno.test("matches on structured errorId 25002 regardless of message wording", () => {
  // A reworded/localized message that the old regex would MISS, but errorId hits.
  assert(
    isOfferAlreadyExistsError(
      ebayErr("Es ist bereits ein Angebot vorhanden.", [
        OFFER_ALREADY_EXISTS_ERROR_ID,
      ]),
    ),
  );
});

Deno.test("matches when 25002 appears among several errorIds", () => {
  assert(isOfferAlreadyExistsError(ebayErr("user error", [25709, 25002])));
});

Deno.test("falls back to the message heuristic when no errorId is parsed", () => {
  assert(
    isOfferAlreadyExistsError(
      ebayErr("A user error has occurred: an offer already exists for this SKU"),
    ),
  );
});

Deno.test("does not match an unrelated error", () => {
  assertEquals(
    isOfferAlreadyExistsError(ebayErr("Invalid category", [25002 + 1])),
    false,
  );
  assertEquals(isOfferAlreadyExistsError(ebayErr("Some other failure")), false);
  assertEquals(isOfferAlreadyExistsError(null), false);
});

Deno.test("OFFER_ALREADY_EXISTS_ERROR_ID is eBay's documented code", () => {
  assertEquals(OFFER_ALREADY_EXISTS_ERROR_ID, 25002);
});

// ── US-464: idempotent publish (adopt an already-published listing) ──────

Deno.test("publishOrAdoptOffer: publishes when the offer isn't live yet", async () => {
  let publishCalls = 0;
  const r = await publishOrAdoptOffer("u", "o1", {
    getPublishedListingId: () => Promise.resolve(null),
    publishOffer: () => {
      publishCalls++;
      return Promise.resolve({ listingId: "L1" });
    },
  });
  assertEquals(r, { listingId: "L1", adopted: false });
  assertEquals(publishCalls, 1);
});

Deno.test("publishOrAdoptOffer: adopts an already-published listing without re-publishing", async () => {
  let publishCalls = 0;
  const r = await publishOrAdoptOffer("u", "o1", {
    getPublishedListingId: () => Promise.resolve("L-existing"),
    publishOffer: () => {
      publishCalls++;
      return Promise.resolve({ listingId: "L-NEW" });
    },
  });
  assertEquals(r, { listingId: "L-existing", adopted: true });
  assertEquals(publishCalls, 0); // must NOT re-publish → no duplicate listing
});

Deno.test("publishOrAdoptOffer: post-publish-crash + retry adopts the same listing (no duplicate)", async () => {
  // Simulate the audit's failure window: attempt 1 publishes remotely and
  // returns L1, then the caller 'crashes' before persisting the local row.
  // Attempt 2 (manual re-publish / publish-due cron) sees the offer already
  // live and adopts it instead of publishing a second time.
  let live: string | null = null;
  let publishCalls = 0;
  const ops = {
    getPublishedListingId: () => Promise.resolve(live),
    publishOffer: () => {
      publishCalls++;
      live = "L1"; // eBay now has a live listing for this offer
      return Promise.resolve({ listingId: "L1" });
    },
  };
  const a1 = await publishOrAdoptOffer("u", "o1", ops);
  assertEquals(a1, { listingId: "L1", adopted: false });
  // 'crash before persist' — retry the whole publish:
  const a2 = await publishOrAdoptOffer("u", "o1", ops);
  assertEquals(a2, { listingId: "L1", adopted: true });
  assertEquals(publishCalls, 1); // the retry adopts, never re-publishes
});

// ── An ENDED listing is not something to adopt ──────────────────────────
//
// eBay does not clear offer.listing.listingId when a listing ends, so "the
// offer has a listingId" answers a different question than "the offer is
// live". Conflating them made end-then-republish a silent no-op: the adopt
// branch handed back the ENDED listing's id, the seller was told the listing
// was live, and the item was off eBay. That is the exact sequence a seller
// follows to escape a bad category, so the escape hatch failed in the same
// place as the thing it was escaping.

Deno.test("livePublishedListingId: adopts a live listing", () => {
  assertEquals(
    livePublishedListingId({ listing: { listingId: "L1", listingStatus: "ACTIVE" } }),
    "L1",
  );
});

Deno.test("livePublishedListingId: refuses an ENDED listing", () => {
  assertEquals(
    livePublishedListingId({ listing: { listingId: "L1", listingStatus: "ENDED" } }),
    null,
  );
  // eBay's casing is not something to depend on.
  assertEquals(
    livePublishedListingId({ listing: { listingId: "L1", listingStatus: "ended" } }),
    null,
  );
});

Deno.test("livePublishedListingId: refuses the other dead statuses", () => {
  for (const status of ["INACTIVE", "COMPLETED", "CANCELLED", "CANCELED"]) {
    assertEquals(
      livePublishedListingId({ listing: { listingId: "L1", listingStatus: status } }),
      null,
      `${status} must not be adopted`,
    );
  }
});

Deno.test("livePublishedListingId: an UNKNOWN or missing status still adopts", () => {
  // Deliberate asymmetry — see the DEAD_LISTING_STATUSES comment. Adopting a
  // dead listing costs a visible no-publish; refusing to adopt a live one
  // costs a DUPLICATE live listing, which is the failure US-464 exists to
  // prevent. Unknown takes the safe side.
  assertEquals(livePublishedListingId({ listing: { listingId: "L1" } }), "L1");
  assertEquals(
    livePublishedListingId({ listing: { listingId: "L1", listingStatus: "OUT_OF_STOCK" } }),
    "L1",
  );
  assertEquals(
    livePublishedListingId({ listing: { listingId: "L1", listingStatus: "SOMETHING_NEW" } }),
    "L1",
  );
});

Deno.test("livePublishedListingId: no listing / no id is not live", () => {
  assertEquals(livePublishedListingId({}), null);
  assertEquals(livePublishedListingId({ listing: null }), null);
  assertEquals(livePublishedListingId({ listing: { listingStatus: "ACTIVE" } }), null);
});

Deno.test("publishOrAdoptOffer: an ended offer republishes instead of adopting", async () => {
  // The end-then-relist path, end to end through the real status rule.
  let publishCalls = 0;
  const endedOffer = { listing: { listingId: "L-ENDED", listingStatus: "ENDED" } };
  const r = await publishOrAdoptOffer("u", "o1", {
    getPublishedListingId: () => Promise.resolve(livePublishedListingId(endedOffer)),
    publishOffer: () => {
      publishCalls++;
      return Promise.resolve({ listingId: "L-NEW" });
    },
  });
  assertEquals(r, { listingId: "L-NEW", adopted: false });
  assertEquals(publishCalls, 1);
});

// eBay answers "no offer for this SKU" with a 404 + 25713 rather than an empty
// list, and the offers fan-out logged one console.error per such SKU per sync.
// The detector has to be narrow: an unlabelled 404 is a real failure (wrong
// host, revoked scope, path typo) and must keep throwing, because swallowing it
// turns a broken sync into a silently empty catalog.
Deno.test("a 25713 404 reads as 'no offers', any other 404 stays an error", () => {
  const notFound = ebayErr(
    "eBay GET /sell/inventory/v1/offer?sku=749 failed (404): ...",
    [OFFER_NOT_AVAILABLE_ERROR_ID],
  ) as Error & { status?: number };
  notFound.status = 404;
  assert(isOfferNotFoundError(notFound));

  const unlabelled = ebayErr("eBay GET /whatever failed (404): <html>") as Error & {
    status?: number;
  };
  unlabelled.status = 404;
  assertEquals(isOfferNotFoundError(unlabelled), false);

  // Same errorId on a non-404 is not the "absent offer" case.
  const wrongStatus = ebayErr("boom", [OFFER_NOT_AVAILABLE_ERROR_ID]) as Error & {
    status?: number;
  };
  wrongStatus.status = 500;
  assertEquals(isOfferNotFoundError(wrongStatus), false);

  assertEquals(isOfferNotFoundError(null), false);
  assertEquals(isOfferNotFoundError("404"), false);
});
