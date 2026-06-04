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

const { isOfferAlreadyExistsError, OFFER_ALREADY_EXISTS_ERROR_ID } = await import(
  "../lib/ebay-client.ts"
);

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
