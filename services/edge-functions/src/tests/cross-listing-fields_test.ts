// US-564: per-marketplace field mapping for the cross-list fan-out. Pure — no
// env / network — imports only the env-free mapping + registry modules.
import { assert, assertEquals } from "@std/assert";
import {
  mapSiblingListingFields,
  type StoredPlatformVariant,
} from "../lib/cross-listing-fields.ts";

const SOURCE = {
  // Longer than Poshmark/Mercari's 80-char title cap.
  listing_title:
    "Nike Tech Fleece Hoodie Men's Medium Black Full Zip Pullover Sweatshirt Streetwear Excellent",
  listing_description: "Great pre-owned Nike Tech Fleece hoodie. Minor wash wear, no flaws.",
};

const VARIANT: StoredPlatformVariant = {
  title: "Nike Tech Fleece Hoodie M Black",
  description: "Cozy Nike Tech Fleece in black, size M. Pre-owned, great shape. 💙 #nike",
  condition: { value: "EUC", label: "EUC (Excellent Used Condition)" },
  category: "Tops",
  brand: "Nike",
  color: "Black",
  size: "M",
  price: 45,
  tags: ["#nike", "#techfleece"],
  confidence: 0.82,
  generated_at: "2026-06-12T00:00:00.000Z",
};

Deno.test("prefers the AI variant for title/description and carries structured fields", () => {
  const out = mapSiblingListingFields("poshmark", SOURCE, 38, VARIANT);
  assertEquals(out.listing_title, VARIANT.title);
  assertEquals(out.listing_description, VARIANT.description);
  // Composer price overrides the variant's stored price.
  assertEquals(out.listing_price, 38);
  assert(out.platform_fields);
  const pf = out.platform_fields!.poshmark;
  assertEquals(pf.condition?.value, "EUC");
  assertEquals(pf.category, "Tops");
  assertEquals(pf.tags, ["#nike", "#techfleece"]);
  // Stored price is reconciled to the composer price.
  assertEquals(pf.price, 38);
});

Deno.test("falls back to the source draft, clamped to the platform title cap", () => {
  const out = mapSiblingListingFields("mercari", SOURCE, 30, undefined);
  // Mercari title cap is 80 — the long source title is trimmed on a word
  // boundary, never mid-word, and never over the cap.
  assert(out.listing_title);
  assert(out.listing_title!.length <= 80);
  assert(SOURCE.listing_title.startsWith(out.listing_title!));
  assertEquals(out.listing_description, SOURCE.listing_description);
  // No variant → no structured blob (sibling keeps any prior platform_fields).
  assertEquals(out.platform_fields, null);
});

Deno.test("Depop carries no title (description-led platform)", () => {
  const out = mapSiblingListingFields("depop", SOURCE, 30, VARIANT);
  assertEquals(out.listing_title, null);
  assert(out.listing_description);
});

Deno.test("clamps a variant title that exceeds the platform cap", () => {
  const longTitle = "x".repeat(120);
  const out = mapSiblingListingFields("poshmark", SOURCE, 30, {
    ...VARIANT,
    title: longTitle,
  });
  assert(out.listing_title);
  assertEquals(out.listing_title!.length, 80);
  // The persisted blob reflects the clamped title, not the 120-char original.
  assertEquals(out.platform_fields!.poshmark.title, out.listing_title ?? undefined);
});
