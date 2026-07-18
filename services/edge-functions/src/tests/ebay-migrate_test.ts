// US-1968 — bulk_migrate_listing response contract.
//
// These are the cases that decide whether a seller's existing catalog becomes
// manageable or becomes a set of rows that CLAIM to be managed and aren't. The
// dangerous direction is a false success: parseMigrateResponse must never
// report ok for a listing we cannot address afterwards, because the caller
// flips listing_origin on the strength of that flag.

import { assertEquals } from "@std/assert";
import {
  chunkForMigrate,
  MIGRATE_BATCH_MAX,
  parseMigrateResponse,
} from "../lib/ebay-migrate.ts";

Deno.test("a successful migration yields eBay's OWN sku + offerId", () => {
  const out = parseMigrateResponse({
    responses: [
      {
        statusCode: 200,
        listingId: "110001",
        marketplaceId: "EBAY_US",
        inventoryItems: [{ sku: "VINTAGE-TEE-04", offerId: "9001" }],
      },
    ],
  });
  assertEquals(out.length, 1);
  assertEquals(out[0].ok, true);
  // Verbatim — NOT a GradeThread-derived value. This is the whole point.
  assertEquals(out[0].sku, "VINTAGE-TEE-04");
  assertEquals(out[0].offerId, "9001");
  assertEquals(out[0].reason, null);
});

Deno.test("AC3: an ineligible listing reports eBay's reason, never silently dropped", () => {
  const out = parseMigrateResponse({
    responses: [
      {
        statusCode: 400,
        listingId: "110002",
        errors: [
          {
            errorId: 25709,
            message: "Invalid listing",
            longMessage:
              "Multiple-variation listings cannot be migrated to the Inventory API.",
          },
        ],
      },
    ],
  });
  assertEquals(out.length, 1);
  assertEquals(out[0].ok, false);
  assertEquals(out[0].sku, null);
  // The longer, actionable text wins — a seller can only act on the specifics.
  assertEquals(
    out[0].reason,
    "Multiple-variation listings cannot be migrated to the Inventory API.",
  );
});

Deno.test(
  "THE LOAD-BEARING CASE: a 2xx with NO sku is a failure, not a success",
  () => {
    // If this ever returns ok, the route flips listing_origin to 'gradethread'
    // on a row no Inventory call can address — and the inbound pull stops
    // refreshing it too, because it only overwrites eBay-owned fields while
    // origin='ebay'. The row would be stale AND unmanageable: strictly worse
    // than the read-only mirror it replaced.
    const out = parseMigrateResponse({
      responses: [
        { statusCode: 200, listingId: "110003", inventoryItems: [{ offerId: "9003" }] },
      ],
    });
    assertEquals(out[0].ok, false);
    assertEquals(out[0].sku, null);
    assertEquals(out[0].offerId, null);
    assertEquals(
      out[0].reason,
      "eBay reported success but returned no SKU, so the listing cannot be managed. It was left as a read-only mirror.",
    );
  },
);

Deno.test("an empty/whitespace sku counts as no sku", () => {
  for (const sku of ["", "   "]) {
    const out = parseMigrateResponse({
      responses: [{ statusCode: 200, listingId: "110004", inventoryItems: [{ sku }] }],
    });
    assertEquals(out[0].ok, false, `sku ${JSON.stringify(sku)} must not pass`);
  }
});

Deno.test("a partial batch keeps its successes (per-listing, not all-or-nothing)", () => {
  const out = parseMigrateResponse({
    responses: [
      {
        statusCode: 200,
        listingId: "110005",
        inventoryItems: [{ sku: "OK-1", offerId: "1" }],
      },
      {
        statusCode: 400,
        listingId: "110006",
        errors: [{ message: "Listing is not active." }],
      },
      {
        statusCode: 200,
        listingId: "110007",
        inventoryItems: [{ sku: "OK-2", offerId: "2" }],
      },
    ],
  });
  assertEquals(out.map((o) => o.ok), [true, false, true]);
  assertEquals(out.map((o) => o.sku), ["OK-1", null, "OK-2"]);
  assertEquals(out[1].reason, "Listing is not active.");
});

Deno.test("a failure with no error text still explains itself", () => {
  const out = parseMigrateResponse({
    responses: [{ statusCode: 500, listingId: "110008" }],
  });
  assertEquals(out[0].ok, false);
  assertEquals(out[0].reason, "eBay declined the migration (status 500).");
});

Deno.test("malformed / empty payloads degrade to an empty result, never throw", () => {
  assertEquals(parseMigrateResponse(null), []);
  assertEquals(parseMigrateResponse(undefined), []);
  assertEquals(parseMigrateResponse({}), []);
  assertEquals(parseMigrateResponse({ responses: "nope" }), []);
  // An entry with no listingId can't be keyed back to a local row, so it is
  // dropped here — the route separately reports any listing eBay never answered.
  assertEquals(parseMigrateResponse({ responses: [{ statusCode: 200 }] }), []);
});

Deno.test("chunkForMigrate never exceeds eBay's 5-per-call cap", () => {
  assertEquals(MIGRATE_BATCH_MAX, 5);
  const ids = Array.from({ length: 12 }, (_, i) => `L${i}`);
  const batches = chunkForMigrate(ids);
  assertEquals(batches.map((b) => b.length), [5, 5, 2]);
  // Flattening round-trips: nothing lost, nothing duplicated.
  assertEquals(batches.flat(), ids);
  // A caller asking for more than the cap is clamped, not obeyed.
  assertEquals(chunkForMigrate(ids, 50).every((b) => b.length <= 5), true);
  assertEquals(chunkForMigrate([]).length, 0);
});
