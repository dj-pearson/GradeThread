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
  OFFER_ALREADY_EXISTS_ERROR_ID,
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
