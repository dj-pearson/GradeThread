// US-3362: the eBay pull used to match SKUs on the wrong column.
//
// THE BUG. `doListingsPull` resolved every eBay SKU through
// `inventory_items.sku`. eBay is keyed on `listings.inventory_sku`, the value
// `deriveInventorySku` minted at publish, and the two agree only when the seller
// typed a SKU and never changed it. The composer's SKU field is optional, so a
// blank one publishes as `FD-<8 hex>` against a local row holding NULL - which
// can never match. Four classes could not resolve: Minted (blank SKU at
// publish), Renamed (the case 00477 was written for), Variant (eBay holds
// variantSku(base, v), we store only the base) and Foreign (another tool's
// listing, or an item deleted here).
//
// WHY IT MATTERS MORE THAN THE CALL VOLUME. An unresolved SKU takes two
// seller-facing consequences with it. The item's OWN live listing is filed as an
// orphan on the Reconciliation page, and ended-without-sale NEVER FIRES, because
// both `endedItemIds.add` sites sit behind a resolved item id - so a listing
// ends on eBay and FlipDesk goes on showing it as listed.
//
// WHY THIS FILE DRIVES RATHER THAN SCANS. A test that greps flipdesk-ebay.ts for
// `endedItemIds` passes just as happily when the resolution is broken and
// nothing ever reaches those lines: the guard would be green for the entire
// lifetime of the bug. So `routeRemoteOffer` is called with an offer eBay says
// has ended, on an item published with a BLANK SKU, and the assertion is that
// the routing reaches `ended` carrying that item's id. Sabotage the index and
// this file goes red; sabotage it under a scan and nothing moves.

// US-2379: flipdesk-ebay.ts reaches lib/supabase.ts through its static imports,
// which reads env at module load. This must come first.
import "./_env.ts";
import { assert, assertEquals } from "@std/assert";
import {
  buildEbaySkuIndex,
  offerCheckRowsForIndex,
  OFFER_RECHECK_MS,
  planOfferStamp,
  routeRemoteOffer,
  selectSkusToSkip,
  type RoutableOffer,
  type SkuIndexItem,
  type SkuIndexListing,
} from "../routes/flipdesk-ebay.ts";
import { deriveInventorySku } from "../lib/ebay-sku.ts";

// A real-shaped uuid, because deriveInventorySku slices the first 8 characters
// of it and the whole Minted class turns on that string.
const MINTED_ID = "9f3c1b2a-7c4e-4a1f-9a3e-1c2d3e4f5a6b";
const MINTED_SKU = "FD-9f3c1b2a";

function offer(patch: Partial<RoutableOffer> = {}): RoutableOffer {
  return {
    sku: MINTED_SKU,
    listingId: "110500000001",
    listingStatus: "ACTIVE",
    availableQuantity: 1,
    ...patch,
  };
}

function listing(patch: Partial<SkuIndexListing> = {}): SkuIndexListing {
  return {
    inventory_item_id: MINTED_ID,
    inventory_sku: MINTED_SKU,
    variations: null,
    ...patch,
  };
}

// -- The index --------------------------------------------------------

Deno.test("US-3362 Minted: a blank SKU publishes under FD- and still resolves", () => {
  // The premise, executed rather than asserted: this is exactly what the
  // publish path put on eBay for an item whose seller left the SKU blank.
  assertEquals(deriveInventorySku({ id: MINTED_ID, sku: null }), MINTED_SKU);

  const items: SkuIndexItem[] = [{ id: MINTED_ID, sku: null }];
  const index = buildEbaySkuIndex(items, [listing()]);
  assertEquals(index.get(MINTED_SKU), MINTED_ID);
});

Deno.test("US-3362 Minted resolves even with no listings row", () => {
  // Rule 4: re-derive. A row that predates 00477's inventory_sku backfill has
  // nothing pinned, and the derivation reproduces what publish minted.
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], []);
  assertEquals(index.get(MINTED_SKU), MINTED_ID);
});

Deno.test("US-3362 Renamed: the pinned SKU wins over today's item.sku", () => {
  // The seller published as OLD-1, then renamed the item to NEW-1. eBay still
  // holds OLD-1; before this fix the pull asked about OLD-1 and matched nothing.
  const index = buildEbaySkuIndex(
    [{ id: MINTED_ID, sku: "NEW-1" }],
    [listing({ inventory_sku: "OLD-1" })],
  );
  assertEquals(index.get("OLD-1"), MINTED_ID);
  assertEquals(index.get("NEW-1"), MINTED_ID);
});

Deno.test("US-3362 Renamed: a SKU another item was published under stays with that item", () => {
  // Item B published as ABC and was renamed away; item A has since taken ABC as
  // its own sku. eBay holds ABC for B, so the pinned value must win - otherwise
  // an ended listing would mark the WRONG item as ended.
  const a = "aaaaaaaa-0000-4000-8000-000000000001";
  const b = "bbbbbbbb-0000-4000-8000-000000000002";
  const index = buildEbaySkuIndex(
    [{ id: a, sku: "ABC" }, { id: b, sku: "XYZ" }],
    [{ inventory_item_id: b, inventory_sku: "ABC", variations: null }],
  );
  assertEquals(index.get("ABC"), b);
});

Deno.test("US-3362 Variant: every member SKU of a group listing resolves", () => {
  const index = buildEbaySkuIndex(
    [{ id: MINTED_ID, sku: "TEE-1" }],
    [
      listing({
        inventory_sku: "TEE-1",
        variations: {
          specifications: ["Size"],
          variants: [
            { aspects: { Size: "M" }, quantity: 2 },
            { aspects: { Size: "L" }, quantity: 1, sku_suffix: "LARGE" },
          ],
        },
      }),
    ],
  );
  // Slug of the variation values for the first, the explicit suffix for the
  // second - the same two shapes variantSku mints at publish.
  assertEquals(index.get("TEE-1-M"), MINTED_ID);
  assertEquals(index.get("TEE-1-LARGE"), MINTED_ID);
  assertEquals(index.get("TEE-1"), MINTED_ID);
});

Deno.test("US-3362 Foreign: a SKU with no local item resolves to nothing", () => {
  // The one class that stays unresolvable, and deliberately: there is no local
  // item to resolve it TO. It must not silently attach to some other row.
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: "MINE-1" }], [listing()]);
  assertEquals(index.get("SOMEONE-ELSES-1"), undefined);
});

Deno.test("US-3362 a blank or whitespace SKU never becomes an index key", () => {
  const index = buildEbaySkuIndex(
    [{ id: MINTED_ID, sku: "   " }],
    [listing({ inventory_sku: "" })],
  );
  // "   " is not a key, and the derived FD- key is still there, because a
  // whitespace-only sku is what deriveInventorySku itself treats as blank.
  assertEquals(index.has("   "), false);
  assertEquals(index.has(""), false);
  assertEquals(index.get(MINTED_SKU), MINTED_ID);
});

Deno.test("US-3362 the newest listing wins a SKU two rows claim", () => {
  // Rows arrive created_at desc, the same order existingListingByItem relies on.
  const newer = "aaaaaaaa-0000-4000-8000-000000000001";
  const older = "bbbbbbbb-0000-4000-8000-000000000002";
  const index = buildEbaySkuIndex([], [
    { inventory_item_id: newer, inventory_sku: "DUP", variations: null },
    { inventory_item_id: older, inventory_sku: "DUP", variations: null },
  ]);
  assertEquals(index.get("DUP"), newer);
});

// -- The ended-without-sale path, DRIVEN ------------------------------

Deno.test("US-3362 AC3/AC4 Minted: eBay says ended, the item reaches the ended path", () => {
  // The whole story in one test. Item published with a blank SKU, so eBay holds
  // FD-9f3c1b2a and inventory_items.sku is NULL. eBay reports the listing ENDED.
  // Before the fix this offer resolved to no item, was filed as an orphan, and
  // endedItemIds never learned about it - the seller's Drafts tab never saw the
  // item come back and FlipDesk went on showing it as listed.
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const o = offer({ listingStatus: "ENDED", availableQuantity: 0 });
  const routed = routeRemoteOffer(o, index.get(o.sku!) ?? null, {
    is_active: true,
    listing_status: "active",
  });
  assertEquals(routed.kind, "ended");
  assert(routed.kind === "ended");
  assertEquals(routed.itemId, MINTED_ID);
  assertEquals(routed.state.isActive, false);
});

Deno.test("US-3362 AC3 Minted: a live listing is NOT filed as an orphan", () => {
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const o = offer();
  const routed = routeRemoteOffer(o, index.get(o.sku!) ?? null, {
    is_active: true,
    listing_status: "active",
  });
  assertEquals(routed.kind, "listed");
  assert(routed.kind === "listed");
  assertEquals(routed.itemId, MINTED_ID);
});

Deno.test("US-3362 AC4 the un-joined resolution is what used to break this", () => {
  // The control for the test above: pass the resolution the OLD code computed
  // (inventory_items.sku only, which for a Minted item is NULL) and the very
  // same ended offer routes to `orphan`. This is the bug, reproduced.
  const oldStyleIndex = new Map<string, string>(); // no sku -> no entry at all
  const o = offer({ listingStatus: "ENDED", availableQuantity: 0 });
  const routed = routeRemoteOffer(o, oldStyleIndex.get(o.sku!) ?? null, {
    is_active: true,
    listing_status: "active",
  });
  assertEquals(routed.kind, "orphan");
});

Deno.test("US-3362 an offer with no listingId ends a live local listing", () => {
  // eBay drops a policy-removed listing out of the active feed entirely, so it
  // comes back with no listingId. Absence is its own fact.
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const o = offer({ listingId: null });
  const routed = routeRemoteOffer(o, index.get(o.sku!) ?? null, {
    is_active: true,
    listing_status: "active",
  });
  assertEquals(routed.kind, "ended");
  assert(routed.kind === "ended");
  assertEquals(routed.state.status, "ended");
});

Deno.test("US-3362 an unpublished draft is never ended", () => {
  // No listingId AND no live local row: a genuine draft offer. Touching it would
  // regress an item the seller is still preparing.
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const o = offer({ listingId: null });
  assertEquals(
    routeRemoteOffer(o, index.get(o.sku!) ?? null, {
      is_active: false,
      listing_status: "draft",
    }).kind,
    "skipped",
  );
  assertEquals(routeRemoteOffer(o, index.get(o.sku!) ?? null, null).kind, "skipped");
});

Deno.test("US-3362 OUT_OF_STOCK stays listed rather than ending", () => {
  // US-2656: that listing is still on eBay; relisting it would mint a duplicate.
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const o = offer({ listingStatus: "OUT_OF_STOCK", availableQuantity: 0 });
  assertEquals(routeRemoteOffer(o, index.get(o.sku!) ?? null, null).kind, "listed");
});

Deno.test("US-3362 a Foreign SKU with a live listing is an orphan, not ended", () => {
  const o = offer({ sku: "SOMEONE-ELSES-1" });
  const routed = routeRemoteOffer(o, null, null);
  assertEquals(routed.kind, "orphan");
  assert(routed.kind === "orphan");
  assertEquals(routed.listingId, "110500000001");
});

// -- The stamp, and the residue the operator reads --------------------

Deno.test("US-3362 AC2 the stamp keys on item ids, so a Minted SKU can be stamped", () => {
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const plan = planOfferStamp([MINTED_SKU], index);
  assertEquals(plan.itemIds, [MINTED_ID]);
  assertEquals(plan.skusByItemId.get(MINTED_ID), [MINTED_SKU]);
  assertEquals(plan.unresolved, []);
});

Deno.test("US-3362 AC5 an unresolvable SKU is named as the residue", () => {
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const plan = planOfferStamp([MINTED_SKU, "FOREIGN-1", "FOREIGN-2"], index);
  assertEquals(plan.itemIds, [MINTED_ID]);
  assertEquals(plan.unresolved, ["FOREIGN-1", "FOREIGN-2"]);
});

Deno.test("US-3362 several SKUs on one item collapse to one stamped row", () => {
  // A group listing: eBay reads the base and both variants, all one item. The
  // stamp must address that row once and still report all three SKUs as covered.
  const index = buildEbaySkuIndex(
    [{ id: MINTED_ID, sku: "TEE-1" }],
    [
      listing({
        inventory_sku: "TEE-1",
        variations: {
          specifications: ["Size"],
          variants: [
            { aspects: { Size: "M" }, quantity: 2 },
            { aspects: { Size: "L" }, quantity: 1 },
          ],
        },
      }),
    ],
  );
  const plan = planOfferStamp(["TEE-1", "TEE-1-M", "TEE-1-L"], index);
  assertEquals(plan.itemIds, [MINTED_ID]);
  assertEquals(plan.skusByItemId.get(MINTED_ID), ["TEE-1", "TEE-1-M", "TEE-1-L"]);
  assertEquals(plan.unresolved, []);
});

Deno.test("US-3362 a duplicate read SKU is planned once", () => {
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const plan = planOfferStamp([MINTED_SKU, MINTED_SKU], index);
  assertEquals(plan.itemIds.length, 1);
  assertEquals(plan.skusByItemId.get(MINTED_ID), [MINTED_SKU]);
});

// -- The skip set, in eBay-SKU space ----------------------------------

const NOW = Date.UTC(2026, 8, 11, 12, 0, 0);
const ago = (ms: number) => new Date(NOW - ms).toISOString();

Deno.test("US-3362 a stamped Minted item skips its eBay SKU next pass", () => {
  // The read-stamp half of the story. ebay_offer_checked_at lives on the ITEM,
  // but listAllOffers only ever sees eBay's SKUs, so the timestamp has to be
  // expanded across the index or a Minted SKU can never enter the skip set -
  // which is precisely why prod measured 1.7 reads per SKU per day against an
  // arithmetic prediction of 1.0.
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const rows = offerCheckRowsForIndex(
    [{ id: MINTED_ID, ebay_offer_checked_at: ago(60_000) }],
    index,
  );
  assertEquals(selectSkusToSkip(rows, NOW).has(MINTED_SKU), true);
});

Deno.test("US-3362 a stale stamp still reads the Minted SKU", () => {
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const rows = offerCheckRowsForIndex(
    [{ id: MINTED_ID, ebay_offer_checked_at: ago(OFFER_RECHECK_MS + 1_000) }],
    index,
  );
  assertEquals(selectSkusToSkip(rows, NOW).size, 0);
});

Deno.test("US-3362 an item never read produces no skip rows at all", () => {
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const rows = offerCheckRowsForIndex(
    [{ id: MINTED_ID, ebay_offer_checked_at: null }],
    index,
  );
  assertEquals(rows, []);
});

Deno.test("US-3362 one stamp covers every variant SKU of a group listing", () => {
  const index = buildEbaySkuIndex(
    [{ id: MINTED_ID, sku: "TEE-1" }],
    [
      listing({
        inventory_sku: "TEE-1",
        variations: {
          specifications: ["Size"],
          variants: [
            { aspects: { Size: "M" }, quantity: 2 },
            { aspects: { Size: "L" }, quantity: 1 },
          ],
        },
      }),
    ],
  );
  const rows = offerCheckRowsForIndex(
    [{ id: MINTED_ID, ebay_offer_checked_at: ago(60_000) }],
    index,
  );
  assertEquals([...selectSkusToSkip(rows, NOW)].sort(), [
    "TEE-1",
    "TEE-1-L",
    "TEE-1-M",
  ]);
});

Deno.test("US-3362 a Foreign SKU is never skipped, because no item stamps it", () => {
  const index = buildEbaySkuIndex([{ id: MINTED_ID, sku: null }], [listing()]);
  const rows = offerCheckRowsForIndex(
    [{ id: MINTED_ID, ebay_offer_checked_at: ago(60_000) }],
    index,
  );
  assertEquals(selectSkusToSkip(rows, NOW).has("FOREIGN-1"), false);
});

// -- Wiring: the pull must use the index, not the bare sku column -----
//
// A scan is the right instrument for THIS and only this: it holds WHERE the
// resolution is wired, which the behavioural tests above cannot see. Keeping
// both is the lesson of the seven-of-seven sabotage measurement - scans for
// wiring, calls for logic.

Deno.test("US-3362 doListingsPull resolves through the index and stamps by id", async () => {
  const src = await Deno.readTextFile(
    new URL("../routes/flipdesk-ebay.ts", import.meta.url),
  );
  const code = src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !/^\s*\/\//.test(l))
    .join("\n");

  // The pull calls the index builder rather than rebuilding a sku map inline.
  assert(
    code.includes("buildEbaySkuIndex(allItems, allListings)"),
    "doListingsPull must build its SKU map with buildEbaySkuIndex",
  );
  // The routing decision is made by the exported function this file drives, not
  // by a second copy of the same branching inside the loop.
  assert(
    code.includes("routeRemoteOffer("),
    "the offers loop must route through routeRemoteOffer",
  );
  // The stamp keys on the resolved id. The old `.in("sku", chunk)` is what let
  // an UPDATE match zero rows and still answer 200.
  assert(
    code.includes('.in("id", chunk)'),
    "the offer stamp must address inventory_items by id",
  );
  assert(
    !code.includes('.in("sku", chunk)'),
    "the offer stamp must no longer address inventory_items by sku",
  );
  // Tenant scope survives the rekey (US-268): the stamp is still owner-filtered.
  const stamp = code.slice(code.indexOf("const plan = planOfferStamp("));
  const stampUpdate = stamp.slice(0, stamp.indexOf('.select("id")'));
  assert(
    stampUpdate.includes('.eq("user_id", userId)'),
    "the offer stamp must stay scoped to the connection owner",
  );
});
