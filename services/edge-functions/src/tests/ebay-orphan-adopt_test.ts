// US-3458: eBay orphans become FlipDesk items on their own.
//
// The decision is pure (planOrphanAdoption) and the row shape is pure
// (buildAdoptionRows), so both are proven here without a database. The writer
// is checked by reading its source: every table it touches is a tenant table,
// and the assertion that it stays owner-scoped (US-268) has to survive a
// refactor that no unit test would notice.
//
// Run: deno test --allow-read --allow-env src/tests/ebay-orphan-adopt_test.ts

// US-2379: lib/ebay-orphan-adopt.ts reaches lib/supabase.ts, which reads env at
// module load. This must come first.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildAdoptionRows,
  MAX_ORPHAN_ADOPTIONS_PER_SYNC,
  normalizeTitle,
  type OrphanCandidate,
  planOrphanAdoption,
} from "../lib/ebay-orphan-adopt.ts";

function orphan(
  over: Partial<OrphanCandidate> & { ebay_item_id: string },
): OrphanCandidate {
  return {
    id: `orphan-${over.ebay_item_id}`,
    custom_label: null,
    title: `Listing ${over.ebay_item_id}`,
    current_price: 25,
    available_quantity: 1,
    listing_url: null,
    start_date: null,
    match_status: "unmatched",
    matched_item_id: null,
    photo_urls: [],
    raw: {},
    ...over,
  };
}

const ITEMS = [
  {
    id: "item-a",
    title: "Patagonia Better Sweater Fleece Jacket Mens L",
    sku: "A-100",
  },
  { id: "item-b", title: "Levi's 501 Jeans 34x32", sku: null },
];

Deno.test("an orphan with no likely local item is adopted", () => {
  const plan = planOrphanAdoption(
    [orphan({ ebay_item_id: "1", title: "Carhartt Detroit Jacket XL" })],
    ITEMS,
  );
  assertEquals(plan.adopt.map((o) => o.ebay_item_id), ["1"]);
  assertEquals(plan.held, []);
  assertEquals(plan.deferred, 0);
});

Deno.test("an identical title is a question for the seller, not a new item", () => {
  // Same rule as src/lib/ebay-reconcile.ts: case and whitespace do not count.
  const plan = planOrphanAdoption(
    [orphan({
      ebay_item_id: "2",
      title: "  patagonia better   sweater fleece jacket mens l ",
    })],
    ITEMS,
  );
  assertEquals(plan.adopt, []);
  assertEquals(plan.held.length, 1);
  assertEquals(plan.held[0].itemId, "item-a");
  assertEquals(plan.held[0].reason, "title_match");
});

Deno.test("a Custom Label that is already a local SKU is held, never duplicated", () => {
  const plan = planOrphanAdoption(
    [orphan({
      ebay_item_id: "3",
      custom_label: " a-100 ",
      title: "Something else entirely",
    })],
    ITEMS,
  );
  assertEquals(plan.adopt, []);
  assertEquals(plan.held[0].itemId, "item-a");
  assertEquals(plan.held[0].reason, "sku_match");
});

Deno.test("matched and ignored orphans are never touched", () => {
  const plan = planOrphanAdoption(
    [
      orphan({
        ebay_item_id: "4",
        match_status: "matched",
        matched_item_id: "item-b",
      }),
      orphan({ ebay_item_id: "5", match_status: "ignored" }),
      // A link with a stale status is still a link.
      orphan({
        ebay_item_id: "6",
        match_status: "unmatched",
        matched_item_id: "item-b",
      }),
    ],
    ITEMS,
  );
  assertEquals(plan.adopt, []);
  assertEquals(plan.held, []);
});

Deno.test("a nameless orphan is still adopted (title falls back to the eBay id)", () => {
  const plan = planOrphanAdoption(
    [orphan({ ebay_item_id: "7", title: null })],
    ITEMS,
  );
  assertEquals(plan.adopt.length, 1);
  const rows = buildAdoptionRows(
    plan.adopt[0],
    "owner",
    "2026-09-22T00:00:00.000Z",
    new Set(),
  );
  assertEquals(rows.item.title, "eBay item 7");
});

Deno.test("the per-pass cap defers the rest and counts them", () => {
  const many = Array.from(
    { length: 5 },
    (_, i) => orphan({ ebay_item_id: String(100 + i) }),
  );
  const plan = planOrphanAdoption(many, [], 3);
  assertEquals(plan.adopt.length, 3);
  assertEquals(plan.deferred, 2);
  assert(
    MAX_ORPHAN_ADOPTIONS_PER_SYNC >= 500,
    "the default cap must clear a real catalog in a few passes",
  );
});

Deno.test("two orphans with the same title both become items in one pass", () => {
  // eBay sellers list multiples. Neither is a likely match for the OTHER
  // because neither is an item yet; on the next pass both are matched.
  const plan = planOrphanAdoption(
    [
      orphan({ ebay_item_id: "8", title: "Nike Dri-FIT Tee M" }),
      orphan({ ebay_item_id: "9", title: "Nike Dri-FIT Tee M" }),
    ],
    [],
  );
  assertEquals(plan.adopt.length, 2);
});

Deno.test("buildAdoptionRows mirrors the client's Create-from-listing shape", () => {
  const ids = ["item-1", "listing-1"];
  const rows = buildAdoptionRows(
    orphan({
      ebay_item_id: "42",
      custom_label: "SKU-42",
      title: "Carhartt Detroit Jacket XL",
      current_price: 89.5,
      available_quantity: 2,
      listing_url: "https://www.ebay.com/itm/42",
      start_date: "2026-09-01",
      raw: {
        categoryId: "57988",
        aspects: { Brand: ["Carhartt"], Size: ["XL"], Features: ["Lined", ""] },
      },
    }),
    "owner-1",
    "2026-09-22T00:00:00.000Z",
    new Set(),
    () => ids.shift() ?? "unexpected",
  );
  assertEquals(rows.item, {
    id: "item-1",
    user_id: "owner-1",
    title: "Carhartt Detroit Jacket XL",
    sku: "SKU-42",
    status: "listed",
    target_price: 89.5,
    item_category: "clothing",
    // US-3468: the offer's category + specifics are seeded at creation, so the
    // new item is crosslistable without waiting a sync.
    ebay_category_id: "57988",
    ebay_aspects: { Brand: ["Carhartt"], Size: ["XL"], Features: ["Lined"] },
  });
  assertEquals(rows.listing, {
    id: "listing-1",
    inventory_item_id: "item-1",
    platform: "ebay",
    listing_origin: "ebay",
    platform_listing_id: "42",
    listing_url: "https://www.ebay.com/itm/42",
    listing_price: 89.5,
    listing_title: "Carhartt Detroit Jacket XL",
    listing_status: "active",
    is_active: true,
    quantity: 2,
    listed_at: "2026-09-01T00:00:00.000Z",
    platform_category_id: "57988",
  });
});

Deno.test("a repeated Custom Label in one batch keeps the unique SKU index intact", () => {
  const used = new Set<string>();
  const now = "2026-09-22T00:00:00.000Z";
  const first = buildAdoptionRows(
    orphan({ ebay_item_id: "a", custom_label: "DUP" }),
    "o",
    now,
    used,
  );
  const second = buildAdoptionRows(
    orphan({ ebay_item_id: "b", custom_label: "dup" }),
    "o",
    now,
    used,
  );
  assertEquals(first.item.sku, "DUP");
  assertEquals(second.item.sku, null);
});

Deno.test("a missing listing_url is derived from the eBay item id, never left blank", () => {
  const rows = buildAdoptionRows(
    orphan({ ebay_item_id: "777", listing_url: null }),
    "o",
    "now",
    new Set(),
  );
  assert(rows.listing.listing_url.includes("777"));
  assertEquals(rows.listing.listed_at, "now");
  assertEquals(rows.listing.platform_category_id, null);
});

Deno.test("normalizeTitle agrees with the Reconciliation page's rule", () => {
  assertEquals(normalizeTitle("  Two   Words "), "two words");
  assertEquals(normalizeTitle(null), "");
});

// ── US-268: the writer stays owner-scoped ────────────────────────────────
//
// Read from source because the assertion is about the QUERIES, and a unit test
// with a fake client proves only that the fake was called.

const LIB = new URL("../lib/ebay-orphan-adopt.ts", import.meta.url);

Deno.test("adoptOrphans scopes every tenant-table query to the owner", async () => {
  const src = await Deno.readTextFile(LIB);
  const body = src.slice(src.indexOf("export async function adoptOrphans("));
  assert(body.length > 0, "adoptOrphans moved; update this scan");

  // The one read keyed on ids from the orphan table joins through the parent.
  const existingRead = body.slice(
    body.indexOf('.from("listings")'),
    body.indexOf('.in("platform_listing_id", ids)'),
  );
  assert(
    existingRead.includes("inventory_items!inner(user_id)") &&
      existingRead.includes('.eq("inventory_items.user_id", ownerId)'),
    "the existing-listing read must be scoped via inventory_items.user_id",
  );

  // Inserts carry the owner: items directly, listings through ids minted for
  // the owner's items in the same function, photos through mirrorEbayPhotos
  // (which re-verifies ownership itself), flips through user_id on the row.
  assert(
    body.includes("user_id: ownerId"),
    "adoption rows must carry the owner id",
  );
  assert(
    body.includes("mirrorEbayPhotos(ownerId,"),
    "photos go through the owner-verifying mirror",
  );
  assert(
    !body.includes(".delete()") && !body.includes(".update("),
    "the writer inserts and upserts only; a delete or an id-keyed update here needs its own scoping review",
  );
  const flip = body.slice(body.indexOf('.from("flipdesk_ebay_listings")'));
  assert(
    flip.includes('onConflict: "user_id,ebay_item_id"'),
    "the orphan flip must key on the owner-qualified natural key",
  );
});

Deno.test("the pull adopts orphans only on a catalog pass, and reads the owner's unmatched set", async () => {
  const route = await Deno.readTextFile(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  const at = route.indexOf("const plan = planOrphanAdoption(");
  assert(at > 0, "doListingsPull no longer calls planOrphanAdoption");
  const block = route.slice(
    route.lastIndexOf("let orphansAdopted = 0;", at),
    at,
  );
  assert(
    block.includes("if (catalogPass) {"),
    "adoption must sit behind the catalog-pass gate",
  );
  assert(
    block.includes('.from("flipdesk_ebay_listings")') &&
      block.includes('.eq("user_id", userId)') &&
      block.includes('.eq("match_status", "unmatched")') &&
      block.includes('.is("matched_item_id", null)'),
    "the candidate read must be owner-scoped and limited to unlinked, unmatched orphans",
  );
  // The orders pass resolves line items through ebayItemIdToItemId, which is
  // rebuilt from listings AFTER this point; adoption has to come first so the
  // same pass's orders can land on the items it just created.
  const rebuild = route.indexOf(
    "const ebayItemIdToItemId = new Map<string, string>();",
  );
  assert(
    at < rebuild,
    "adoption must run before the ebayItemIdToItemId rebuild",
  );
});

Deno.test("both active-listing passes fall back to the listing id, after the SKU index", async () => {
  const route = await Deno.readTextFile(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  // The helper consults the SKU index first and the listing-id map second.
  const helper = route.slice(
    route.indexOf("const resolveListedItemId = ("),
    route.indexOf("// US-3111: the SKUs whose offer we read recently"),
  );
  assert(helper.length > 0, "resolveListedItemId moved; update this scan");
  const skuAt = helper.indexOf("skuToItemId.get(sku)");
  const idAt = helper.indexOf("listedEbayItemToItemId.get(ebayItemId)");
  assert(
    skuAt > 0 && idAt > skuAt,
    "the SKU index must stay the authority; the listing id is the fallback",
  );
  assert(
    route.includes(
      "const resolvedItemId = resolveListedItemId(sku, o.listingId);",
    ),
    "the offer pass must resolve through resolveListedItemId",
  );
  assert(
    route.includes("const itemId = resolveListedItemId(sku, l.ebayItemId);"),
    "the Trading pass must resolve through resolveListedItemId",
  );
});

Deno.test("US-3468: a legacy orphan (no aspects in raw) is created without the columns, not with nulls", () => {
  const rows = buildAdoptionRows(
    orphan({
      ebay_item_id: "43",
      title: "1989 Upper Deck Ken Griffey Jr. #1",
      raw: { source: "trading_api" },
    }),
    "owner-1",
    "2026-09-22T00:00:00.000Z",
    new Set(),
  );
  // Omitted, so the insert leaves the column default alone and the next
  // sync's GetItem fills both.
  assertEquals("ebay_category_id" in rows.item, false);
  assertEquals("ebay_aspects" in rows.item, false);
});
