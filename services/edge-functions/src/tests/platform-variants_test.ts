// US-721: pure per-marketplace variant assembly. No env / network — imports
// only the env-free platform-variants + marketplace-specs modules.
import { assert, assertEquals } from "@std/assert";
import {
  assemblePlatformVariant,
  type PlatformVariantBase,
  trimToLimit,
} from "../lib/platform-variants.ts";

const BASE: PlatformVariantBase = {
  title: "Nike Tech Fleece Hoodie Men's Medium Black Full Zip Pullover Sweatshirt",
  description: "Great pre-owned Nike Tech Fleece hoodie. Minor wash wear, no flaws.",
  brand: "Nike",
  size: "M",
  color: "Black",
  material: "Cotton blend",
  itemSpecifics: { Brand: ["Nike"], Size: ["M"] },
  gradeValue: 7.0,
  gradeLabel: "Very Good",
  priceCents: 4500,
  categoryQuery: "Men's Hoodies",
  confidence: 0.82,
};

const TEXT = (over?: boolean) => ({
  title: over ? "x".repeat(120) : "Nike Tech Fleece Hoodie M Black",
  description: "Cozy Nike Tech Fleece in black, size M. Pre-owned, great shape.",
  tags: ["#nike", "#techfleece", "#hoodie", "#streetwear", "#mens", "#black"],
});

Deno.test("trimToLimit: word-boundary trim, never mid-word", () => {
  assertEquals(trimToLimit("hello world foo", 8), "hello");
  assertEquals(trimToLimit("short", 80), "short");
  assertEquals(trimToLimit("anything", null), "anything");
  // single word longer than the cap → hard slice
  assertEquals(trimToLimit("supercalifragilistic", 5), "super");
});

Deno.test("mercari: title within 80, condition mapped, tags capped to 3", () => {
  const v = assemblePlatformVariant("mercari", BASE, TEXT(), { photoCount: 5 });
  assert(v.title.length <= 80);
  assertEquals(v.condition?.value, "Good"); // grade 7 → VERY_GOOD → Mercari "Good"
  assertEquals(v.tags.length, 3); // Mercari caps at 3
  assertEquals(v.price, 45);
  assert(v.validation.ok, "expected a valid Mercari variant");
});

Deno.test("mercari: an over-long AI title is trimmed and still validates", () => {
  const v = assemblePlatformVariant("mercari", BASE, TEXT(true), { photoCount: 3 });
  assert(v.title.length <= 80);
  assert(v.validation.ok);
  assert(!v.validation.issues.some((i) => i.field === "title" && i.level === "error"));
});

Deno.test("depop: no title field, description carried, tags capped to 5", () => {
  const v = assemblePlatformVariant("depop", BASE, TEXT(), { photoCount: 4 });
  assertEquals(v.title, "");
  assert(v.description.length > 0);
  assertEquals(v.tags.length, 5);
});

Deno.test("grailed: brand maps to designer; allow-list gates validation", () => {
  const bad = assemblePlatformVariant("grailed", BASE, TEXT(), { brandAllowed: false });
  assert(!bad.validation.ok);
  assert(bad.validation.issues.some((i) => i.field === "designer" && i.level === "error"));

  const ok = assemblePlatformVariant("grailed", BASE, TEXT(), { brandAllowed: true });
  assert(ok.validation.ok, JSON.stringify(ok.validation.issues));
  assertEquals(ok.condition?.value, "Gently used"); // grade 7 → VERY_GOOD
});

Deno.test("shopify: no condition field → null condition, no tags", () => {
  const v = assemblePlatformVariant("shopify", BASE, TEXT(), { photoCount: 2 });
  assertEquals(v.condition, null);
  assertEquals(v.tags.length, 0); // Shopify has no tags spec entry
});

Deno.test("category override (US-722) wins over the base query", () => {
  const withOverride = assemblePlatformVariant("grailed", BASE, TEXT(), { brandAllowed: true }, "Outerwear");
  assertEquals(withOverride.category, "Outerwear");
  // Falls back to the base category query when no override is given.
  const noOverride = assemblePlatformVariant("mercari", BASE, TEXT(), {});
  assertEquals(noOverride.category, BASE.categoryQuery);
  // Blank/whitespace override also falls back.
  const blank = assemblePlatformVariant("mercari", BASE, TEXT(), {}, "   ");
  assertEquals(blank.category, BASE.categoryQuery);
});

// ── US-2736: the price must survive the trip to the kit ────────────────────
//
// Every platform variant's price came from the eBay draft alone, so an item
// priced on the ITEM produced priceCents 0. That became price 0 in the variant,
// a blank Listing price in the kit, "" in the extension payload, and an
// extension that refused to fill a field it had no value for — while telling
// the seller on every cross-post that we could not set their price. The
// selectors were correct the whole time; there was no number to type.
//
// The precedence lives in generatePlatformVariants, which needs a database, so
// this pins the RULE as a pure function against the same cases. The rule and
// the caller are one expression; if they ever diverge this test is the record
// of which one was intended.

function resolvedPriceCents(
  draftPrice: number | null,
  targetPrice: number | null,
  listPrice: number | null = null,
): number {
  return Math.round(
    ([draftPrice, targetPrice, listPrice].find(
      (p): p is number => p != null && p > 0,
    ) ?? 0) * 100,
  );
}

Deno.test("US-2736: the draft's price wins when it has one", () => {
  assertEquals(resolvedPriceCents(32.49, 19.99), 3249);
});

Deno.test("US-2736: the item's target price is the fallback", () => {
  // The case that shipped broken: nothing on the draft, a real price on the item.
  assertEquals(resolvedPriceCents(null, 32.49), 3249);
  assertEquals(resolvedPriceCents(0, 32.49), 3249);
});

Deno.test("US-2736: an unpriced draft stays unpriced", () => {
  // Honest, not defensive: an item with no price anywhere has no price to
  // carry, and inventing one would put a number on a live listing.
  assertEquals(resolvedPriceCents(null, null), 0);
  assertEquals(resolvedPriceCents(0, 0), 0);
});

Deno.test("US-2736: a negative price never becomes a listing price", () => {
  assertEquals(resolvedPriceCents(-5, 32.49), 3249);
  assertEquals(resolvedPriceCents(-5, -1), 0);
});

Deno.test("US-2736: list_price is the THIRD source, and it was the missing one", () => {
  // A price can live in three places and the composer has always read all
  // three. This rule checked two, so an item priced through list_price
  // generated a blank price on every channel — the exact symptom the first fix
  // was supposed to end, still happening after it shipped.
  assertEquals(resolvedPriceCents(null, null, 32.49), 3249);
  assertEquals(resolvedPriceCents(0, 0, 32.49), 3249);
});

Deno.test("US-2736: first POSITIVE wins, not first non-null", () => {
  // A stale 0 on a draft row must not shadow a real price further down.
  assertEquals(resolvedPriceCents(0, 24.99, 9.99), 2499);
  assertEquals(resolvedPriceCents(32.49, 24.99, 9.99), 3249);
});
