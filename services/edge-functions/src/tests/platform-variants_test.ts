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
