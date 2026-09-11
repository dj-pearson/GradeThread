// US-564: per-marketplace field mapping for the cross-list fan-out. Pure — no
// env / network — imports only the env-free mapping + registry modules.
import { assert, assertEquals } from "@std/assert";
import {
  mapSiblingListingFields,
  type StoredPlatformVariant,
  validateSiblingForPublish,
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

Deno.test("the title copies eBay, the description keeps the variant, structured fields carry", () => {
  const out = mapSiblingListingFields("poshmark", SOURCE, 38, VARIANT);
  // 2026-09-11 (channel-copy.ts): the variant's title is a snapshot of the
  // eBay title and is no longer read. Poshmark's cap is 80, so the source is
  // fitted on a word boundary.
  assertEquals(
    out.listing_title,
    "Nike Tech Fleece Hoodie Men's Medium Black Full Zip Pullover Sweatshirt",
  );
  // The API-channel description is unchanged on this path (see the comment in
  // mapSiblingListingFields).
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

Deno.test("a stale variant title never reaches the sibling", () => {
  // The bug: drafted as Gray, corrected to Navy on eBay, and every sibling
  // kept saying Gray because the variant's title won.
  const out = mapSiblingListingFields(
    "poshmark",
    { ...SOURCE, listing_title: "Cozy Earth Lounge Set 3XL Navy Blue" },
    30,
    { ...VARIANT, title: "Cozy Earth Lounge Set XXXL Gray" },
  );
  assertEquals(out.listing_title, "Cozy Earth Lounge Set 3XL Navy Blue");
  // The persisted blob reflects the title that was sent.
  assertEquals(out.platform_fields!.poshmark.title, out.listing_title ?? undefined);
});

Deno.test("the seller's per-channel overrides beat eBay", () => {
  const out = mapSiblingListingFields("poshmark", SOURCE, 30, {
    ...VARIANT,
    title_override: "My own Poshmark title",
    description_override: "My own Poshmark words.",
  } as StoredPlatformVariant);
  assertEquals(out.listing_title, "My own Poshmark title");
  assertEquals(out.listing_description, "My own Poshmark words.");
});

// US-725: pre-flight validation of a mapped sibling before cross-push publishes.
Deno.test("pre-flight passes a well-formed mapped sibling", () => {
  const out = mapSiblingListingFields("poshmark", SOURCE, 38, VARIANT);
  const res = validateSiblingForPublish("poshmark", out);
  assert(res.ok, JSON.stringify(res.issues));
});

Deno.test("pre-flight blocks when the required category is missing", () => {
  const out = mapSiblingListingFields("mercari", SOURCE, 30, {
    ...VARIANT,
    category: "",
  });
  const res = validateSiblingForPublish("mercari", out);
  assert(!res.ok);
  assert(res.issues.some((i) => i.level === "error" && i.field === "category"));
});

Deno.test("pre-flight blocks an invalid condition value", () => {
  const out = mapSiblingListingFields("mercari", SOURCE, 30, {
    ...VARIANT,
    // Mercari's allowed values are New/Like new/Good/Fair/Poor — not "EUC".
    condition: { value: "EUC", label: "EUC" },
  });
  const res = validateSiblingForPublish("mercari", out);
  assert(!res.ok);
  assert(res.issues.some((i) => i.level === "error" && i.field === "condition"));
});

Deno.test("pre-flight flags an over-cap photo count when provided", () => {
  const out = mapSiblingListingFields("depop", SOURCE, 30, VARIANT);
  // Depop caps at 8 photos.
  const res = validateSiblingForPublish("depop", out, 12);
  assert(res.issues.some((i) => i.level === "error" && i.field === "photos"));
});
