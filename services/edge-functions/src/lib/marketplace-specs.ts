// Marketplace listing-requirements registry (US-719) + grade→condition
// mapping (US-720).
//
// This is the SINGLE SOURCE OF TRUTH for what each marketplace requires of a
// listing: field set, character limits, allowed condition values, photo caps,
// tag rules, and whether the platform uses its own category taxonomy / brand
// allow-list. It is read by:
//   - AI per-platform field generation (US-721)
//   - the copy-paste Listing Kit + char counters (US-723)
//   - per-platform photo export (US-724)
//   - cross-list pre-flight validation (US-725)
// so no platform constraint is hard-coded anywhere else.
//
// ⚠️ MIRROR: this file is duplicated VERBATIM at
//   services/edge-functions/src/lib/marketplace-specs.ts
// because the Deno edge runtime cannot import from the Vite `src/` tree. The
// two copies MUST stay byte-identical — the guard test
// src/lib/__tests__/marketplace-specs-sync.test.ts fails the build if they
// drift. Keep this module dependency-free (pure data + pure functions) so it
// type-checks under BOTH tsconfig and Deno.
//
// ⚠️ NUMBERS SHIFT: the char limits / photo caps / condition enums below are
// per each platform's seller UI + help docs as of 2026-06. Marketplaces change
// these without notice — VERIFY against the live platform before treating any
// single number as authoritative. Each spec carries a `sourceNote`.

// Platforms with a real cross-listing path (per vault/30-platform/cross-listing.md). Other
// listing_platform values (facebook, offerup, whatnot, other) are intentionally
// not specced here yet — getSpec() returns undefined for them.
export type MarketplacePlatform =
  | "ebay"
  | "poshmark"
  | "mercari"
  | "depop"
  | "grailed"
  | "shopify"
  | "etsy"
  | "whatnot"
  | "vinted"
  | "facebook";

// How a listing actually reaches the platform.
//   api       — official write API (push) available
//   extension — no API; user-side browser-extension automation (US-716)
//   manual    — no API; copy-paste only (US-723)
export type PushMechanism = "api" | "extension" | "manual";

// A normalized, platform-agnostic condition bucket derived from a GradeThread
// grade + tier. Each platform maps these buckets onto its own wording.
export type ConditionBucket =
  | "NEW_WITH_TAGS"
  | "NEW_WITHOUT_TAGS"
  | "EXCELLENT"
  | "VERY_GOOD"
  | "GOOD"
  | "ACCEPTABLE"
  | "POOR";

export interface ConditionOption {
  /** Value as the platform stores/expects it (API enum, or the visible label for manual platforms). */
  value: string;
  /** Human label shown in the kit. */
  label: string;
}

export interface FieldSpec {
  /** Canonical field key used across generation, kit, and validation. */
  key: string;
  /** UI label shown in the Listing Kit. */
  label: string;
  required: boolean;
  /** Max characters, when the platform enforces one. */
  maxLength?: number;
  /** Render as a textarea in the kit. */
  multiline?: boolean;
  /** Short helper text for the seller. */
  help?: string;
}

export interface MarketplaceSpec {
  platform: MarketplacePlatform;
  label: string;
  pushMechanism: PushMechanism;
  /** Title char limit; null when the platform has no distinct title field (Depop). */
  titleMaxLength: number | null;
  /** Description char limit; null when effectively unbounded (eBay HTML, Shopify). */
  descriptionMaxLength: number | null;
  /** Max photos accepted on a single listing. */
  maxPhotos: number;
  /** Allowed condition values, best→worst; empty when the platform has no condition field (Shopify). */
  conditions: ConditionOption[];
  /** Hashtag/keyword-tag rules, when the platform has a dedicated tag input. */
  tags?: { max: number; required: boolean; help?: string };
  /**
   * US-2739: the smallest price step the platform accepts.
   *
   * Poshmark takes WHOLE DOLLARS. Its listing-price input is
   * `inputmode="numeric" pattern="[0-9]*"` — digits only, no decimal point — so
   * "32.49" is not a price it can hold. Sending one is not a rounding nicety,
   * it is a value the field rejects.
   *
   * `1` means whole units; omitted means cents are fine (eBay, Shopify, and the
   * rest). Kept HERE rather than in the extension because it is a fact about
   * the marketplace, not about a selector, and the kit has to show the seller
   * the same number it is about to send.
   */
  priceStep?: number;
  /**
   * US-2745: field keys the extension CANNOT fill, so the seller sets them on
   * the marketplace themselves.
   *
   * These are option lists — pickers and dropdowns whose choices vary per
   * garment — where a wrong pick is worse than an empty field. Naming them up
   * front turns "the extension missed some things" into a short, finite list of
   * what is left to do.
   *
   * ONLY POPULATED WHERE IT HAS BEEN VERIFIED ON THE LIVE FORM. An unset value
   * means "not established", NOT "the extension fills everything" — the UI says
   * nothing at all rather than making a promise nobody checked.
   */
  manualFields?: string[];
  /** True when the platform has its own category tree that must be mapped (US-722). */
  usesOwnTaxonomy: boolean;
  /** True when brand must come from the platform's curated list (Grailed designers). */
  brandAllowList: boolean;
  /** Fields the kit renders for copy-paste / the adapter maps for push. */
  fields: FieldSpec[];
  /** Provenance + a reminder that these values must be verified. */
  sourceNote: string;
}

const TITLE = (max: number | undefined, label = "Title"): FieldSpec => ({
  key: "title",
  label,
  required: true,
  maxLength: max,
});
const DESCRIPTION = (max: number | undefined): FieldSpec => ({
  key: "description",
  label: "Description",
  required: true,
  maxLength: max,
  multiline: true,
});

export const MARKETPLACE_SPECS: Record<MarketplacePlatform, MarketplaceSpec> = {
  ebay: {
    platform: "ebay",
    label: "eBay",
    pushMechanism: "api",
    titleMaxLength: 80,
    descriptionMaxLength: null, // HTML body, effectively unbounded
    maxPhotos: 24,
    conditions: [
      { value: "NEW", label: "New" },
      { value: "LIKE_NEW", label: "New without tags / Like new" },
      { value: "USED_EXCELLENT", label: "Used — Excellent" },
      { value: "USED_VERY_GOOD", label: "Used — Very good" },
      { value: "USED_GOOD", label: "Used — Good" },
      { value: "USED_ACCEPTABLE", label: "Used — Acceptable" },
      { value: "FOR_PARTS_OR_NOT_WORKING", label: "For parts / not working" },
    ],
    usesOwnTaxonomy: true, // resolved live via the eBay Taxonomy API
    brandAllowList: false,
    fields: [
      TITLE(80),
      { key: "category", label: "Category", required: true, help: "eBay leaf category" },
      { key: "condition", label: "Condition", required: true },
      { key: "conditionDescription", label: "Condition description", required: false, multiline: true },
      { key: "itemSpecifics", label: "Item specifics", required: false, help: "Brand, Size, Color, Material, …" },
      DESCRIPTION(undefined),
      { key: "price", label: "Price", required: true },
    ],
    sourceNote:
      "eBay Sell API + seller UI (2026-06): title 80 chars, condition enum per EBAY_CONDITION_VALUES, up to 24 photos. VERIFY per-category (some leaves restrict conditions).",
  },

  poshmark: {
    platform: "poshmark",
    label: "Poshmark",
    pushMechanism: "manual",
    titleMaxLength: 80,
    descriptionMaxLength: 1500,
    maxPhotos: 16,
    conditions: [
      { value: "NWT", label: "NWT (New With Tags)" },
      { value: "NWOT", label: "NWOT (New Without Tags)" },
      { value: "EUC", label: "EUC (Excellent Used Condition)" },
      { value: "VGUC", label: "VGUC (Very Good Used Condition)" },
      { value: "GUC", label: "GUC (Good Used Condition)" },
      { value: "FAIR", label: "Fair" },
      { value: "PLAY", label: "Play condition" },
    ],
    // Confirmed pickers on the live form 2026-08-20: colour, size, category
    // and condition. Poshmark's structured condition flag is `nwt`.
    manualFields: ["category", "size", "color", "nwt"],
    // Poshmark rejects cents — see priceStep on MarketplaceSpec.
    priceStep: 1,
    usesOwnTaxonomy: true, // Department → Category → Subcategory
    brandAllowList: false,
    fields: [
      TITLE(80),
      DESCRIPTION(1500),
      { key: "category", label: "Department / Category / Subcategory", required: true },
      { key: "size", label: "Size", required: true },
      { key: "brand", label: "Brand", required: false },
      { key: "color", label: "Color (up to 2)", required: false },
      { key: "nwt", label: "New With Tags?", required: false, help: "Poshmark's only structured condition flag — otherwise describe in the listing" },
      { key: "originalPrice", label: "Original price", required: false },
      { key: "price", label: "Listing price", required: true },
    ],
    sourceNote:
      "Poshmark seller UI (2026-06): only the NWT toggle is structured; other condition wording goes in the description. Title ~80, up to 16 photos. No public API — manual/extension only. VERIFY.",
  },

  mercari: {
    platform: "mercari",
    label: "Mercari",
    pushMechanism: "manual",
    titleMaxLength: 80,
    descriptionMaxLength: 1000,
    maxPhotos: 12,
    conditions: [
      { value: "New", label: "New" },
      { value: "Like new", label: "Like new" },
      { value: "Good", label: "Good" },
      { value: "Fair", label: "Fair" },
      { value: "Poor", label: "Poor" },
    ],
    tags: { max: 3, required: false, help: "Up to 3 hashtags for discovery" },
    // Confirmed on the live form 2026-08-20: condition is a selection and size
    // a dropdown. BRAND fills — its selector was verified the same day and
    // runFlow has filled `f.brand` for any channel declaring one since US-2730.
    //
    // ⚠ CATEGORY DOES NOT, and this line used to say it did. Nothing in the
    // extension can fill it: no channel in lister/selectors.js declares a
    // `category` selector, runFlow fills only title, description, brand, price
    // and photos, and common.js:626 says so outright ("there is no option to:
    // category/size/condition"). A live run saw a category on the finished
    // listing, and the story took that as the extension's doing — Mercari
    // derives one from the title, or the seller had set it.
    //
    // Leaving it out of this list was the expensive half. Category is REQUIRED
    // on Mercari, and the kit renders this array as "You'll set these yourself"
    // — so a field absent from it reads as handled, and the seller has no
    // reason to look at the one field a wrong value mis-files the listing
    // under. Named here it costs a glance; unnamed it costs the listing's
    // visibility (US-2743 AC6).
    manualFields: ["category", "condition", "size"],
    usesOwnTaxonomy: true,
    brandAllowList: false,
    fields: [
      TITLE(80),
      DESCRIPTION(1000),
      { key: "category", label: "Category", required: true },
      { key: "brand", label: "Brand", required: false },
      { key: "condition", label: "Condition", required: true },
      { key: "size", label: "Size", required: false },
      { key: "color", label: "Color", required: false },
      { key: "tags", label: "Hashtags (up to 3)", required: false },
      { key: "price", label: "Price", required: true },
    ],
    sourceNote:
      "Mercari US seller UI (2026-06): title 80, description 1000, 12 photos, 5-step condition, up to 3 hashtags. No public API — manual/extension only. VERIFY.",
  },

  depop: {
    platform: "depop",
    label: "Depop",
    pushMechanism: "api", // private partner API (US-712/713/714); manual until approved
    titleMaxLength: null, // Depop has no separate title — the description is the listing text
    descriptionMaxLength: 1000,
    maxPhotos: 8,
    conditions: [
      { value: "Brand new", label: "Brand new" },
      { value: "Like new", label: "Like new" },
      { value: "Used - excellent", label: "Used — excellent" },
      { value: "Used - good", label: "Used — good" },
      { value: "Used - fair", label: "Used — fair" },
    ],
    tags: { max: 5, required: false, help: "Up to 5 hashtags" },
    usesOwnTaxonomy: true,
    brandAllowList: false,
    fields: [
      DESCRIPTION(1000),
      { key: "category", label: "Category / Subcategory", required: true },
      { key: "brand", label: "Brand", required: false },
      { key: "condition", label: "Condition", required: true },
      { key: "size", label: "Size", required: false },
      { key: "color", label: "Color", required: false },
      { key: "style", label: "Style", required: false },
      { key: "tags", label: "Hashtags (up to 5)", required: false },
      { key: "price", label: "Price", required: true },
    ],
    sourceNote:
      "Depop seller UI + partner API (2026-06): no title field (description-led), ~1000 char description, ~8 photos, up to 5 hashtags. Private API via partnerapi.depop.com. VERIFY.",
  },

  grailed: {
    platform: "grailed",
    label: "Grailed",
    pushMechanism: "manual",
    titleMaxLength: 60,
    descriptionMaxLength: 1500,
    maxPhotos: 25,
    conditions: [
      { value: "New/New with tags", label: "New / New with tags" },
      { value: "Gently used", label: "Gently used" },
      { value: "Used", label: "Used" },
      { value: "Very worn", label: "Very worn" },
    ],
    tags: { max: 5, required: false, help: "Style tags" },
    usesOwnTaxonomy: true, // Department → Category → Subcategory
    brandAllowList: true, // Designer must be chosen from Grailed's list
    fields: [
      TITLE(60),
      DESCRIPTION(1500),
      { key: "department", label: "Department (Menswear/Womenswear)", required: true },
      { key: "category", label: "Category / Subcategory", required: true },
      { key: "designer", label: "Designer / Brand", required: true, help: "Must match a designer in Grailed's list" },
      { key: "size", label: "Size", required: true },
      { key: "color", label: "Color", required: false },
      { key: "condition", label: "Condition", required: true },
      { key: "tags", label: "Style tags", required: false },
      { key: "price", label: "Price", required: true },
    ],
    sourceNote:
      "Grailed seller UI (2026-06): designer from a curated list, 4-step condition, department + category, up to 25 photos. No public API — manual/extension only. VERIFY.",
  },

  shopify: {
    platform: "shopify",
    label: "Shopify",
    pushMechanism: "api",
    titleMaxLength: 255,
    descriptionMaxLength: null, // body_html, effectively unbounded
    maxPhotos: 250,
    conditions: [], // Shopify has no native condition field
    usesOwnTaxonomy: false, // free-form product_type + collections
    brandAllowList: false,
    fields: [
      TITLE(255),
      DESCRIPTION(undefined),
      { key: "vendor", label: "Vendor (brand)", required: false },
      { key: "productType", label: "Product type", required: false },
      { key: "tags", label: "Tags", required: false },
      { key: "price", label: "Price", required: true },
      { key: "sku", label: "SKU", required: false },
      { key: "quantity", label: "Quantity", required: false },
    ],
    sourceNote:
      "Shopify GraphQL Admin API (2026-01): title 255, no body_html cap, up to 250 images, no native condition field. VERIFY.",
  },

  etsy: {
    platform: "etsy",
    label: "Etsy",
    pushMechanism: "api", // Etsy Open API v3 (US-1659/1660); gated behind ETSY_ENABLED until app approval
    titleMaxLength: 140,
    descriptionMaxLength: null, // ~13,000 chars — effectively unbounded for our copy
    maxPhotos: 10,
    conditions: [], // Etsy has no condition field — it uses who_made/when_made attributes instead
    tags: { max: 13, required: false, help: "Up to 13 tags, each ≤20 chars" },
    usesOwnTaxonomy: true, // Etsy taxonomy_id tree (US-722)
    brandAllowList: false,
    fields: [
      TITLE(140),
      DESCRIPTION(undefined),
      { key: "category", label: "Category (Etsy taxonomy)", required: true },
      { key: "whoMade", label: "Who made it", required: true, help: "i_did / someone_else / collective" },
      { key: "whenMade", label: "When was it made", required: true, help: "e.g. made_to_order, 2020_2025, before_2005 (vintage: 20+ yrs)" },
      { key: "materials", label: "Materials", required: false },
      { key: "tags", label: "Tags (up to 13)", required: false },
      { key: "price", label: "Price", required: true },
      { key: "quantity", label: "Quantity", required: false },
    ],
    sourceNote:
      "Etsy Open API v3 (2026-06): title 140, description ~13k, up to 10 photos, up to 13 tags (≤20 chars each), taxonomy_id tree, no condition field (who_made/when_made instead), requires a shipping profile. OAuth2 PKCE + x-api-key. VERIFY.",
  },

  whatnot: {
    platform: "whatnot",
    label: "Whatnot",
    pushMechanism: "api", // Whatnot partner API (US-1661/1662); gated behind WHATNOT_ENABLED until approval
    titleMaxLength: 100,
    descriptionMaxLength: 2000,
    maxPhotos: 12,
    conditions: [
      { value: "new", label: "New" },
      { value: "open_box", label: "Open box" },
      { value: "like_new", label: "Like new" },
      { value: "good", label: "Good" },
      { value: "fair", label: "Fair" },
    ],
    tags: { max: 10, required: false, help: "Search hashtags" },
    usesOwnTaxonomy: true, // Whatnot category tree
    brandAllowList: false,
    fields: [
      TITLE(100),
      DESCRIPTION(2000),
      { key: "category", label: "Category", required: true },
      { key: "brand", label: "Brand", required: false },
      { key: "condition", label: "Condition", required: true },
      { key: "size", label: "Size", required: false },
      { key: "color", label: "Color", required: false },
      { key: "tags", label: "Hashtags", required: false },
      { key: "price", label: "Price", required: true },
    ],
    sourceNote:
      "Whatnot partner/seller API (2026-06, MODELED — partner-gated, no public docs): title ~100, description ~2000, up to 12 photos, own category tree, condition enum. OAuth2 partner app. VERIFY every field against the live API once partner access lands.",
  },

  vinted: {
    platform: "vinted",
    label: "Vinted",
    pushMechanism: "extension", // No public API — GradeThread Lister extension (US-716)
    titleMaxLength: 60,
    descriptionMaxLength: 3000,
    maxPhotos: 20,
    conditions: [
      { value: "New with tags", label: "New with tags" },
      { value: "New without tags", label: "New without tags" },
      { value: "Very good", label: "Very good" },
      { value: "Good", label: "Good" },
      { value: "Satisfactory", label: "Satisfactory" },
    ],
    tags: { max: 5, required: false, help: "Search keywords" },
    // US-2744: whole units, reported from the live sell form 2026-08-20.
    //
    // CAVEAT WORTH KEEPING: priceStep is per PLATFORM and Vinted is ~20 country
    // domains. This was confirmed on the domain the seller was using; a locale
    // that prices in decimals would be rounded here too. If that turns out to
    // matter, the step belongs alongside the locale map in the extension's
    // selectors config, not on this one spec.
    priceStep: 1,
    usesOwnTaxonomy: true, // Vinted catalog tree
    brandAllowList: false,
    fields: [
      TITLE(60),
      DESCRIPTION(3000),
      { key: "category", label: "Category", required: true },
      { key: "brand", label: "Brand", required: false },
      { key: "condition", label: "Condition", required: true },
      { key: "size", label: "Size", required: false },
      { key: "color", label: "Color", required: false },
      { key: "price", label: "Price", required: true },
    ],
    sourceNote:
      "Vinted seller UI (2026-06): title ~60, description ~3000, up to 20 photos, own catalog tree, 5-step condition. No public API — extension/manual only. VERIFY.",
  },
  // US-2480. Marketplace's condition list is the shortest of any channel we
  // support — five values, and "New" means unused rather than new-with-tags, so
  // the bucket map below deliberately collapses both NEW_* buckets onto it
  // rather than inventing a distinction Facebook does not have.
  facebook: {
    platform: "facebook",
    label: "Facebook Marketplace",
    pushMechanism: "extension", // No public write API — Lister extension (US-2480)
    titleMaxLength: 100,
    descriptionMaxLength: 5000,
    maxPhotos: 20,
    conditions: [
      { value: "New", label: "New" },
      { value: "Used - like new", label: "Used · like new" },
      { value: "Used - good", label: "Used · good" },
      { value: "Used - fair", label: "Used · fair" },
    ],
    tags: { max: 20, required: false, help: "Product tags aid Marketplace search" },
    usesOwnTaxonomy: true, // Marketplace category tree
    brandAllowList: false,
    fields: [
      TITLE(100),
      DESCRIPTION(5000),
      { key: "category", label: "Category", required: true },
      { key: "condition", label: "Condition", required: true },
      { key: "price", label: "Price", required: true },
      { key: "brand", label: "Brand", required: false },
      { key: "size", label: "Size", required: false },
      { key: "color", label: "Color", required: false },
    ],
    sourceNote:
      "Facebook Marketplace create-item dialog (2026-08): title ~100, description ~5000, up to 20 photos, own category tree, 4-step condition with no new-with-tags distinction. No public write API — extension/manual only. VERIFY.",
  },
};

/** All specced platforms. */
export const SPECCED_PLATFORMS = Object.keys(MARKETPLACE_SPECS) as MarketplacePlatform[];

/** Returns the spec for a platform, or undefined if not specced. */
export function getMarketplaceSpec(platform: string): MarketplaceSpec | undefined {
  return (MARKETPLACE_SPECS as Record<string, MarketplaceSpec>)[platform];
}

/** Platforms that need the copy-paste Listing Kit (no API push). */
export function manualKitPlatforms(): MarketplacePlatform[] {
  return SPECCED_PLATFORMS.filter((p) => MARKETPLACE_SPECS[p].pushMechanism !== "api");
}

// ── US-720: grade → per-platform condition ───────────────────────────────
//
// Derives a normalized ConditionBucket from a GradeThread grade (1.0–10.0) +
// tier label, then maps it onto each platform's own condition wording.
//
// The eBay path is intentionally identical to the legacy mapEbayCondition() in
// flipdesk-ebay.ts so that adopting this mapper there is a no-op refactor:
//   grade ≥ 9.75 or NWT → NEW; ≥ 9.0 → LIKE_NEW; ≥ 7.5 → USED_EXCELLENT;
//   ≥ 6.0 → USED_VERY_GOOD; ≥ 4.5 → USED_GOOD; else → USED_ACCEPTABLE;
//   no grade → NWT ? NEW : USED_EXCELLENT.

/** Normalized condition bucket from a grade + tier label. */
export function gradeToConditionBucket(
  grade: number | null,
  label: string | null,
): ConditionBucket {
  // "NWT" must not match "NWOT" — substring check is correct ("NWOT" excludes "NWT").
  const isNwt = (label ?? "").toUpperCase().includes("NWT");
  if (grade != null) {
    if (grade >= 9.75 || isNwt) return "NEW_WITH_TAGS";
    if (grade >= 9.0) return "NEW_WITHOUT_TAGS";
    if (grade >= 7.5) return "EXCELLENT";
    if (grade >= 6.0) return "VERY_GOOD";
    if (grade >= 4.5) return "GOOD";
    if (grade >= 3.0) return "ACCEPTABLE";
    return "POOR";
  }
  return isNwt ? "NEW_WITH_TAGS" : "EXCELLENT";
}

// Per-platform bucket → condition value. Values match each platform's
// conditions[] list above. Shopify and Etsy are omitted (no condition field).
const CONDITION_BY_BUCKET: Record<
  Exclude<MarketplacePlatform, "shopify" | "etsy">,
  Record<ConditionBucket, string>
> = {
  ebay: {
    NEW_WITH_TAGS: "NEW",
    NEW_WITHOUT_TAGS: "LIKE_NEW",
    EXCELLENT: "USED_EXCELLENT",
    VERY_GOOD: "USED_VERY_GOOD",
    GOOD: "USED_GOOD",
    ACCEPTABLE: "USED_ACCEPTABLE",
    POOR: "USED_ACCEPTABLE", // matches legacy mapEbayCondition (no FOR_PARTS by grade)
  },
  poshmark: {
    NEW_WITH_TAGS: "NWT",
    NEW_WITHOUT_TAGS: "NWOT",
    EXCELLENT: "EUC",
    VERY_GOOD: "VGUC",
    GOOD: "GUC",
    ACCEPTABLE: "FAIR",
    POOR: "PLAY",
  },
  mercari: {
    NEW_WITH_TAGS: "New",
    NEW_WITHOUT_TAGS: "Like new",
    EXCELLENT: "Like new",
    VERY_GOOD: "Good",
    GOOD: "Good",
    ACCEPTABLE: "Fair",
    POOR: "Poor",
  },
  depop: {
    NEW_WITH_TAGS: "Brand new",
    NEW_WITHOUT_TAGS: "Like new",
    EXCELLENT: "Used - excellent",
    VERY_GOOD: "Used - excellent",
    GOOD: "Used - good",
    ACCEPTABLE: "Used - fair",
    POOR: "Used - fair",
  },
  grailed: {
    NEW_WITH_TAGS: "New/New with tags",
    NEW_WITHOUT_TAGS: "New/New with tags",
    EXCELLENT: "Gently used",
    VERY_GOOD: "Gently used",
    GOOD: "Used",
    ACCEPTABLE: "Used",
    POOR: "Very worn",
  },
  whatnot: {
    NEW_WITH_TAGS: "new",
    NEW_WITHOUT_TAGS: "like_new",
    EXCELLENT: "like_new",
    VERY_GOOD: "good",
    GOOD: "good",
    ACCEPTABLE: "fair",
    POOR: "fair",
  },
  vinted: {
    NEW_WITH_TAGS: "New with tags",
    NEW_WITHOUT_TAGS: "New without tags",
    EXCELLENT: "Very good",
    VERY_GOOD: "Very good",
    GOOD: "Good",
    ACCEPTABLE: "Satisfactory",
    POOR: "Satisfactory",
  },
  // US-2480: Marketplace has no new-with-tags value, so both NEW_* buckets map
  // to "New". Mapping NEW_WITHOUT_TAGS to "Used - like new" would be the more
  // literal reading and the wrong one — an unworn garment listed as used prices
  // itself down for no reason.
  facebook: {
    NEW_WITH_TAGS: "New",
    NEW_WITHOUT_TAGS: "New",
    EXCELLENT: "Used - like new",
    VERY_GOOD: "Used - good",
    GOOD: "Used - good",
    ACCEPTABLE: "Used - fair",
    POOR: "Used - fair",
  },
};

/**
 * Maps a GradeThread grade + tier to a platform's condition value + label.
 * Returns null for platforms with no condition concept (Shopify).
 */
export function mapCondition(
  platform: MarketplacePlatform,
  grade: number | null,
  label: string | null,
): ConditionOption | null {
  if (platform === "shopify" || platform === "etsy") return null;
  const bucket = gradeToConditionBucket(grade, label);
  const value = CONDITION_BY_BUCKET[platform][bucket];
  const spec = MARKETPLACE_SPECS[platform];
  const option = spec.conditions.find((c) => c.value === value);
  return option ?? { value, label: value };
}

// ── Char-limit helper for the kit's live counters (US-723) ────────────────

export interface CharStatus {
  length: number;
  max: number | null;
  /** True when there is a limit and the value exceeds it. */
  over: boolean;
  /** Remaining chars (negative when over); null when no limit. */
  remaining: number | null;
}

/** Computes the character-count status of a value against a field's limit. */
export function charStatus(value: string, maxLength: number | null | undefined): CharStatus {
  const length = value.length;
  const max = maxLength ?? null;
  if (max == null) return { length, max: null, over: false, remaining: null };
  return { length, max, over: length > max, remaining: max - length };
}

// ── US-725: cross-list pre-flight validation ─────────────────────────────
//
// Validates a per-platform draft against this registry BEFORE the Listing Kit
// marks a platform "ready" (US-723) or an API adapter publishes (US-710/714).
// Errors block; warnings are advisory (missing discovery fields, etc.).

/** Per-platform draft values, keyed by FieldSpec.key. */
export type DraftFieldValue = string | string[] | number | boolean | null | undefined;
export type DraftFields = Record<string, DraftFieldValue>;

export interface FieldIssue {
  field: string;
  level: "error" | "warning";
  message: string;
}

export interface ValidationResult {
  platform: MarketplacePlatform;
  /** True when there are no error-level issues (warnings are allowed). */
  ok: boolean;
  issues: FieldIssue[];
}

/** Out-of-band signals the field values can't carry on their own. */
export interface ValidationContext {
  /** Number of photos that will be attached (checked against maxPhotos). */
  photoCount?: number;
  /** For brand-allow-list platforms (Grailed): whether the chosen brand is on the list. */
  brandAllowed?: boolean;
}

function asString(v: DraftFieldValue): string {
  if (v == null) return "";
  if (Array.isArray(v)) return v.join(", ");
  return String(v);
}
function isEmpty(v: DraftFieldValue): boolean {
  if (v == null) return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "string") return v.trim() === "";
  return false;
}

/**
 * Validates a draft for one platform against its spec. Returns error-level
 * issues for required-missing / over-limit / invalid-condition / over-photo-cap
 * / over-tag-max / off-allow-list brand, and warning-level issues for empty
 * discovery fields (brand, tags).
 */
export function validateListingForPlatform(
  platform: MarketplacePlatform,
  draft: DraftFields,
  ctx: ValidationContext = {},
): ValidationResult {
  const spec = MARKETPLACE_SPECS[platform];
  const issues: FieldIssue[] = [];
  if (!spec) {
    return { platform, ok: false, issues: [{ field: "_", level: "error", message: `No spec for ${platform}` }] };
  }

  for (const field of spec.fields) {
    const value = draft[field.key];
    if (field.required && isEmpty(value)) {
      issues.push({ field: field.key, level: "error", message: `${field.label} is required` });
      continue;
    }
    if (field.maxLength != null && !isEmpty(value)) {
      const len = asString(value).length;
      if (len > field.maxLength) {
        issues.push({
          field: field.key,
          level: "error",
          message: `${field.label} is ${len}/${field.maxLength} — trim ${len - field.maxLength}`,
        });
      }
    }
    // Discovery hints: present but empty optional brand/tags → warning.
    if (!field.required && isEmpty(value) && (field.key === "brand" || field.key === "tags")) {
      issues.push({ field: field.key, level: "warning", message: `${field.label} is empty — helps buyers find it` });
    }
  }

  // Condition must be one of the platform's allowed values.
  if (spec.conditions.length > 0) {
    const cond = draft.condition;
    if (!isEmpty(cond)) {
      const ok = spec.conditions.some((c) => c.value === asString(cond));
      if (!ok) {
        issues.push({ field: "condition", level: "error", message: `Condition "${asString(cond)}" is not a valid ${spec.label} value` });
      }
    }
  }

  // Category required when the platform uses its own taxonomy.
  if (spec.usesOwnTaxonomy) {
    const catKey = spec.fields.some((f) => f.key === "category") ? "category" : "department";
    if (isEmpty(draft[catKey]) && !spec.fields.find((f) => f.key === catKey)?.required) {
      issues.push({ field: catKey, level: "error", message: `A ${spec.label} category must be selected` });
    }
  }

  // Tag cap.
  if (spec.tags) {
    const tags = draft.tags;
    const count = Array.isArray(tags) ? tags.length : isEmpty(tags) ? 0 : 1;
    if (count > spec.tags.max) {
      issues.push({ field: "tags", level: "error", message: `Too many tags (${count}/${spec.tags.max})` });
    }
  }

  // Brand allow-list (Grailed designer).
  if (spec.brandAllowList && ctx.brandAllowed === false) {
    issues.push({ field: "designer", level: "error", message: `Designer must be chosen from ${spec.label}'s list` });
  }

  // Photo cap.
  if (ctx.photoCount != null && ctx.photoCount > spec.maxPhotos) {
    issues.push({ field: "photos", level: "error", message: `Too many photos (${ctx.photoCount}/${spec.maxPhotos})` });
  }

  return { platform, ok: !issues.some((i) => i.level === "error"), issues };
}
