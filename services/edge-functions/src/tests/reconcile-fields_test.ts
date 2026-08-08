// AutoLister reconcile: field diff + merge writes.
//
// The title-sync assertions here are US-1995 AC5 — this is the edge module's
// first real production caller, so the behaviour is pinned where it ships
// rather than only in the pure title-sync unit tests.
import { assertEquals } from "@std/assert";
import {
  buildMergeWrites,
  buildReconcileDiff,
  type ReconcileItemRow,
  type ReconcileListingRow,
} from "../lib/reconcile-fields.ts";

function item(over: Partial<ReconcileItemRow> = {}): ReconcileItemRow {
  return {
    id: "i1",
    sku: "SKU1",
    title: "Nike Mens Hoodie Blue L Fleece",
    brand: "Nike",
    size: "L",
    color: "Blue",
    material: "Cotton",
    style: "Pullover",
    description: "seller description",
    target_price: 40,
    ...over,
  };
}

function listing(over: Partial<ReconcileListingRow> = {}): ReconcileListingRow {
  return {
    id: "l1",
    listing_title: "Nike Mens Hoodie Blue L Fleece",
    listing_description: "ai description",
    listing_price: 55,
    item_specifics_override: {
      Brand: ["Adidas"],
      Size: ["M"],
      Color: ["Blue"],
      Material: ["Cotton"],
      Style: ["Pullover"],
    },
    ...over,
  };
}

// ── diff ───────────────────────────────────────────────────────────

Deno.test("diff flags only the fields that actually disagree", () => {
  const diff = buildReconcileDiff(item(), listing());
  const differing = diff.filter((d) => d.differs).map((d) => d.key).sort();
  assertEquals(differing, ["brand", "description", "price", "size"]);
});

Deno.test("diff suggests the AI value when it differs and is non-empty", () => {
  const diff = buildReconcileDiff(item(), listing({
    item_specifics_override: { Brand: [""], Size: ["M"] },
  }));
  const by = new Map(diff.map((d) => [d.key, d.suggested]));
  // Brand's AI side is empty → keep the seller's own value.
  assertEquals(by.get("brand"), "original");
  assertEquals(by.get("size"), "ai");
});

// ── merge writes ───────────────────────────────────────────────────

Deno.test("merge writes land on both the item columns and the listing", () => {
  const { itemUpdate, listingColUpdate, aspectUpdate } = buildMergeWrites(
    item(),
    listing(),
    { title: "original", brand: "ai", size: "ai", price: "original" },
  );
  assertEquals(itemUpdate.brand, "Adidas");
  assertEquals(itemUpdate.size, "M");
  assertEquals(itemUpdate.target_price, 40);
  assertEquals(listingColUpdate.listing_price, 40);
  assertEquals(aspectUpdate.Brand, ["Adidas"]);
  assertEquals(aspectUpdate.Size, ["M"]);
});

// US-1995 AC5. Keeping the seller's title while taking the AI's brand used to
// write a corrected brand column beside a title still selling the old brand.
Deno.test("kept title is reconciled against the winning brand and size", () => {
  const { listingColUpdate } = buildMergeWrites(
    item(),
    listing(),
    { title: "original", brand: "ai", size: "ai" },
  );
  assertEquals(listingColUpdate.listing_title, "Adidas Mens Hoodie Blue M Fleece");
});

Deno.test("keeping the original brand leaves the title alone", () => {
  const { listingColUpdate } = buildMergeWrites(
    item(),
    listing(),
    { title: "original", brand: "original", size: "original" },
  );
  assertEquals(listingColUpdate.listing_title, "Nike Mens Hoodie Blue L Fleece");
});

// The substitution runs off the ORIGINAL item value, so replaying the same
// merge over its own output must not compound (the "L" -> "L/XL" shape).
Deno.test("title sync does not compound when the new value contains the old", () => {
  const first = buildMergeWrites(
    item(),
    listing({ item_specifics_override: { Size: ["L/XL"] } }),
    { title: "original", size: "ai" },
  );
  assertEquals(first.listingColUpdate.listing_title, "Nike Mens Hoodie Blue L/XL Fleece");

  const second = buildMergeWrites(
    item({ size: "L/XL", title: String(first.listingColUpdate.listing_title) }),
    listing({
      listing_title: String(first.listingColUpdate.listing_title),
      item_specifics_override: { Size: ["L/XL"] },
    }),
    { title: "original", size: "ai" },
  );
  assertEquals(second.listingColUpdate.listing_title, "Nike Mens Hoodie Blue L/XL Fleece");
});

// The title is never truncated on this path — publish enforces eBay's 80-char
// cap, and silently cutting a title the seller explicitly kept would be a
// bigger change than the one being fixed.
Deno.test("a longer brand is not trimmed away here", () => {
  const long = "Nike Mens Running Sneakers Size 11 White Black Leather Athletic Shoes Pair";
  const { listingColUpdate } = buildMergeWrites(
    item({ title: long, brand: "Nike" }),
    listing({ listing_title: long, item_specifics_override: { Brand: ["Under Armour"] } }),
    { title: "original", brand: "ai" },
  );
  const out = String(listingColUpdate.listing_title);
  assertEquals(out.startsWith("Under Armour Mens Running"), true);
  assertEquals(out.length > 80, true);
});
