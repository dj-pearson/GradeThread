// Photo profiles — the per-category definition of which photo "roles" a seller
// should capture, with category-specific labels, hints, and required flags.
//
// This file is the SERVER-AUTHORITATIVE source of truth. The web app and the
// iOS app fetch it via `GET /api/flipdesk/photo-profiles` and cache it, falling
// back to a small bundled default for first paint / offline. Defining it once
// here means new categories or label tweaks ship without an App Store release
// and the two clients can never drift from each other.
//
// Storage vs. display: `PhotoRole.type` is the PHYSICAL `item_photos.photo_type`
// value (the flipdesk_photo_type enum). Multiple categories reuse the same
// storage value with different labels — e.g. `detail` is "Detail" for clothing,
// "Sole" guidance for shoes, "Corners" for cards. We deliberately keep the
// storage vocabulary small (relabel generic slots; add universal roles in
// migration 00230) instead of exploding the enum per category.

import {
  measurementGroupFor,
  type MeasurementGroup,
} from "./measurement-templates.ts";
import { measurementRolesFor } from "./photo-roles.ts";

export type PhotoStorageType =
  // Existing flipdesk_photo_type values, reused as the storage vocabulary.
  | "front"
  | "back"
  | "tag"
  | "tag_2"
  | "detail"
  | "detail_2"
  | "detail_3"
  | "detail_4"
  | "interior"
  | "defect"
  | "flatlay"
  | "on_model"
  // US-1571 (migration 00346): the MeasureCard calibration frame.
  | "measurement"
  | "measurement_chest"
  | "measurement_waist"
  | "measurement_length"
  | "measurement_sleeve"
  | "measurement_inseam"
  // Universal roles added in migration 00230.
  | "angle"
  | "sole"
  | "marking"
  | "serial"
  | "accessory"
  | "certificate"
  | "corner"
  | "surface"
  // US-2462 (migration 00587): the two roles that had no existing type to reuse.
  | "on_hanger"
  | "set_pair";

export interface PhotoRole {
  /** Physical item_photos.photo_type value this slot writes. */
  type: PhotoStorageType;
  /**
   * US-2465. The `item_photos.photo_role` qualifier this slot writes, or
   * undefined for a slot that takes none. Slot identity is (type, role): that
   * is what lets a suit hold three separate `tag` slots instead of needing a
   * `tag_2` and a `tag_3` in the enum.
   */
  role?: string;
  /** Category-specific display label, e.g. "Dial / Face", "Front of card". */
  label: string;
  /** One-line capture guidance shown under/next to the slot. */
  hint: string;
  /** Must be present before the item can advance to "photographed". */
  required: boolean;
  /** lucide-react icon name (web). iOS maps the storage type to an SF Symbol. */
  icon: string;
}

export interface PhotoProfile {
  /** item_category value this profile applies to, or "default". */
  category: string;
  /** Human category name for headers. */
  label: string;
  /** Ordered capture roles — required ones first by convention. */
  roles: PhotoRole[];
}

// ── Reusable role builders ──────────────────────────────────────────────────
// Small helpers keep the table DRY and consistent; every role still gets an
// explicit per-category label/hint so the guidance reads naturally.
function role(
  type: PhotoStorageType,
  label: string,
  hint: string,
  required: boolean,
  icon: string,
  qualifier?: string,
): PhotoRole {
  return qualifier === undefined
    ? { type, label, hint, required, icon }
    : { type, label, hint, required, icon, role: qualifier };
}

const DEFECT = role(
  "defect",
  "Defect",
  "Tight crop on any flaw — stain, snag, scuff, crack. Be honest.",
  false,
  "alert-triangle",
);

// ── Clothing, by garment group (US-2465) ────────────────────────────────────
// One flat CLOTHING profile could not be right for all of clothing: it offered
// a t-shirt an inseam slot and never offered a blazer a shoulder. The garment
// group comes from `measurementGroupFor(item.category)` — the SAME free-text
// mapping the measurement form has always used — so the photo slots and the
// measurement fields agree by construction rather than by somebody remembering
// to update both.
//
// `front` stays at index 0 in every sub-profile. The role order IS the gallery
// order and index 0 is the eBay cover, so anything else would move covers on
// items that already exist.

const CLOTHING_TAGS: PhotoRole[] = [
  role("tag", "Brand label", "The maker's logo or wordmark — usually a separate neck or waistband tag", false, "tag", "brand"),
  role("tag", "Size tag", "The size itself, close enough to read without zooming", false, "tag", "size"),
  role("tag", "Care & fabric", "The care label with the fibre content — the question buyers ask most", false, "tag", "care"),
];

const CLOTHING_DETAILS: PhotoRole[] = [
  // `fabric` is load-bearing beyond the picker: the grading confidence cap asks
  // whether a fabric close-up exists (US-2467), and before roles it could only
  // approximate that by asking whether ANY numbered detail slot was filled.
  role("detail", "Fabric close-up", "Fill the frame with the weave or knit, in even light", false, "search", "fabric"),
  role("detail", "Hardware", "Zip pull, buttons, rivets or snaps — show plating wear honestly", false, "search", "hardware"),
  role("detail", "Print or graphic", "The graphic straight on, close enough to show any cracking", false, "search", "print"),
];

/** The MeasureCard calibration frame. Never lists — the card is branded. */
const MEASURE_CARD = role(
  "measurement",
  "Measurement card",
  "Whole garment flat with the MeasureCard BESIDE it — all 4 squares visible, shot top-down",
  false,
  "ruler",
);

/** Tape close-ups, one per field on this garment's measurement template. */
function measurementSlots(group: MeasurementGroup): PhotoRole[] {
  return measurementRolesFor(group).map((r) =>
    role("measurement", `Measure: ${r.label}`, r.hint, false, "ruler", r.key)
  );
}

// The tail every clothing sub-profile shares: context shots, then the
// authenticity macros. Deliberately all optional — a condition grade must never
// fail because an authenticity slot was skipped, and most sellers are not
// running the add-on (US-2134).
const CLOTHING_TAIL: PhotoRole[] = [
  role("interior", "Interior / Lining", "Inside-out: lining, seams, interior tags", false, "layers"),
  role("detail", "Hem & stitching", "A hem or seam up close — single stitching is a dating tell on vintage", false, "search", "hem"),
  role("detail", "Collar or cuff", "Collar and cuffs — the first place a shirt shows its age", false, "search", "collar"),
  role("detail", "Pocket", "Pocket opening and the corners, where tearing starts", false, "search", "pocket"),
  role("tag", "Made in / union label", "Origin, union or RN label — this is what dates a vintage piece", false, "tag", "made_in"),
  role("serial", "Serial / Date code", "Fill the frame with the code — get close, hold steady, avoid glare", false, "hash"),
  role("marking", "Brand stamp / Hardware", "Close-up of an embossed logo, engraved zipper pull, rivet or button", false, "stamp"),
  role("flatlay", "Flat lay", "Styled flat lay for the listing gallery", false, "layout-grid"),
  role("on_hanger", "On hanger", "Hung straight on, showing how it drapes", false, "shirt"),
  role("on_model", "On model", "Worn on a model or mannequin", false, "user"),
];

/**
 * Build a clothing sub-profile. The shape is identical across groups; only the
 * front/back guidance and the derived measurement slots differ.
 */
function clothingProfile(
  group: MeasurementGroup,
  category: string,
  label: string,
  frontHint: string,
  backHint: string,
  extra: PhotoRole[] = [],
): PhotoProfile {
  return {
    category,
    label,
    roles: [
      role("front", "Front", frontHint, true, "shirt"),
      role("back", "Back", backHint, true, "shirt"),
      ...CLOTHING_TAGS,
      ...CLOTHING_DETAILS,
      MEASURE_CARD,
      ...measurementSlots(group),
      DEFECT,
      ...extra,
      ...CLOTHING_TAIL,
    ],
  };
}

const CLOTHING_TOP = clothingProfile(
  "top", "clothing:top", "Tops",
  "Lay flat, full front in frame",
  "Same crop as the front shot",
);

const CLOTHING_BOTTOM = clothingProfile(
  "bottom", "clothing:bottom", "Bottoms",
  "Lay flat, waistband to hem, front facing up",
  "Flip it over — same crop, back pockets visible",
  [role("detail", "Waistband & closure", "Button, zip and belt loops close up", false, "search", "hardware")],
);

const CLOTHING_DRESS = clothingProfile(
  "dress", "clothing:dress", "Dresses",
  "Lay flat or hang straight, full length in frame",
  "Same crop as the front — show the zip or closure",
);

const CLOTHING_OUTERWEAR = clothingProfile(
  "outerwear", "clothing:outerwear", "Outerwear",
  "Lay flat, buttoned or zipped, full front in frame",
  "Same crop as the front shot",
  [role("detail", "Lining & label", "Open it — the inner lining and the brand label together", false, "search", "hem")],
);

// The case that failed before this epic and the reason it exists. A two-piece
// needs a size tag PER PIECE, both sets of measurements, and a shot of the two
// together — none of which fitted in two tag slots and five fixed measurement
// types.
const CLOTHING_SUIT = clothingProfile(
  "suit", "clothing:suit", "Suit sets",
  "Jacket laid flat, buttoned, full front in frame",
  "Jacket back — same crop, showing the vents",
  [
    role("set_pair", "Both pieces", "Jacket and trousers together in one frame — proves they are the same suit", false, "layers"),
    // Deliberately NOT a second `front`. `front` takes no role qualifier, so two
    // front slots would be indistinguishable in storage — and `front` is the
    // cover pick, so a trouser shot could end up as the eBay main image.
    role("flatlay", "Trousers", "Trousers laid flat, waistband to hem", false, "layout-grid", "trousers"),
    role("tag", "Trouser size tag", "The trousers' own size label — a suit is two sizes, not one", false, "tag", "size_alt"),
  ],
);

// ── Per-category profiles ───────────────────────────────────────────────────
// `default` is the clothing profile so a null/unknown category keeps today's
// behavior exactly (front/back/tag/detail required).
// The fallback for CLOTHING whose garment word we do not recognise. It uses the
// SUIT template deliberately: that is the superset of the top and bottom
// measurements, so an unknown garment is offered chest, length, shoulder,
// sleeve, waist, inseam and rise — a strict superset of the five fixed
// measurement slots the old flat profile offered. Narrowing an unknown garment
// to one half would hide the slot a seller needs and give them no way back.
const CLOTHING: PhotoProfile = clothingProfile(
  "suit",
  "clothing",
  "Clothing",
  "Lay flat, full front in frame",
  "Same crop as the front shot",
);

const SHOES: PhotoProfile = {
  category: "shoes",
  label: "Shoes",
  roles: [
    role("front", "Top / Toe", "Top-down or front; show both shoes if a pair", true, "footprints"),
    role("back", "Heel", "Back of the heel, both shoes", true, "footprints"),
    role("angle", "3/4 Angle", "Angled side view showing the silhouette", true, "footprints"),
    role("sole", "Sole", "Outsole / tread — show wear honestly", true, "footprints"),
    role("tag", "Size Stamp", "Tongue or insole size + brand stamp", false, "tag"),
    role("interior", "Insole", "Inside the shoe — footbed condition", false, "layers"),
    role("accessory", "Box / Extras", "Original box, spare laces, papers", false, "package"),
    DEFECT,
  ],
};

const WATCHES: PhotoProfile = {
  category: "watches",
  label: "Watches",
  roles: [
    role("front", "Dial / Face", "Straight-on dial, no glare", true, "watch"),
    role("back", "Caseback", "Back of the case", true, "watch"),
    role("angle", "Profile", "Side profile showing the crown", false, "watch"),
    role("marking", "Markings", "Hallmarks, engravings, brand etching", false, "stamp"),
    role("serial", "Serial / Ref", "Serial + reference numbers", false, "hash"),
    role("detail", "Clasp / Band", "Clasp, bracelet, or strap close-up", false, "search"),
    role("accessory", "Box & Papers", "Box, papers, spare links", false, "package"),
    DEFECT,
  ],
};

const JEWELRY: PhotoProfile = {
  category: "jewelry",
  label: "Jewelry",
  roles: [
    role("front", "Front", "Main view, in focus, neutral background", true, "gem"),
    role("detail", "Close-up", "Stones, setting, prongs in sharp focus", true, "search"),
    role("marking", "Hallmark", "Metal stamp / maker's mark (.925, 14K, 750…)", true, "stamp"),
    role("back", "Back / Clasp", "Reverse side and clasp", false, "gem"),
    role("serial", "Serial", "Serial or model number, if present", false, "hash"),
    role("certificate", "Certificate", "Appraisal, COA, or grading report", false, "award"),
    role("accessory", "Box / Pouch", "Original box, pouch, or papers", false, "package"),
    DEFECT,
  ],
};

const SPORTS_CARDS: PhotoProfile = {
  category: "sports_cards",
  label: "Sports cards",
  roles: [
    role("front", "Front", "Straight-on, fill the frame, no glare", true, "credit-card"),
    role("back", "Back", "Straight-on back", true, "credit-card"),
    role("corner", "Corners", "Close-up of corners for sharpness", false, "scan"),
    role("surface", "Surface / Centering", "Raking light for surface & centering", false, "scan"),
    role("certificate", "Grade Label", "PSA / BGS / SGC slab label, legible", false, "award"),
    role("defect", "Flaw", "Crease, print line, edge wear — tight crop", false, "alert-triangle"),
  ],
};

const COLLECTIBLES: PhotoProfile = {
  category: "collectibles",
  label: "Collectibles",
  roles: [
    role("front", "Front", "Main view in focus", true, "package"),
    role("back", "Back", "Reverse / underside", true, "package"),
    role("detail", "Detail", "Distinguishing detail", false, "search"),
    role("marking", "Markings", "Stamps, signatures, edition numbers", false, "stamp"),
    role("certificate", "COA", "Certificate of authenticity, if any", false, "award"),
    role("accessory", "Box / Packaging", "Original box or packaging", false, "box"),
    DEFECT,
  ],
};

const ELECTRONICS: PhotoProfile = {
  category: "electronics",
  label: "Electronics",
  roles: [
    role("front", "Front", "Powered on / screen visible if possible", true, "smartphone"),
    role("back", "Back / Ports", "Back and any ports", true, "smartphone"),
    role("serial", "Serial / Model", "Model + serial label", true, "hash"),
    role("angle", "Angle", "Angled view showing condition", false, "smartphone"),
    role("accessory", "Accessories", "Cables, charger, box, manuals", false, "package"),
    role("defect", "Defect / Wear", "Scratches, dents, dead pixels — tight crop", false, "alert-triangle"),
  ],
};

const BOOKS: PhotoProfile = {
  category: "books",
  label: "Books",
  roles: [
    role("front", "Cover", "Front cover, straight-on", true, "book"),
    role("back", "Back Cover", "Back cover", true, "book"),
    role("detail", "Spine / Edition", "Spine + copyright/edition page", true, "search"),
    role("interior", "Interior", "Sample pages and overall condition", false, "layers"),
    role("defect", "Defect", "Tears, markings, foxing, water damage", false, "alert-triangle"),
  ],
};

// US-2225 AC2: the slots a bag's GRADE actually turns on.
//
// The old profile asked for front, back, brand stamp, serial, interior, one
// catch-all "Hardware" detail and extras. That set was built for LISTING a bag
// and for authenticating one; it never asked for the two areas the bags rubric
// weights most heavily. Corners and edge paint carry 30% of the score and had
// no slot at all, so the grader was being asked to judge them from a full-front
// shot that physically cannot resolve corner wear — and the seller was never
// told to photograph them.
//
// The three additions map onto rubric factors one-for-one:
//   corner  → corners_edges (0.30)  the single heaviest factor
//   surface → structure     (0.10)  the base, where sag and corner collapse show
//   detail_2 → handles_straps (0.15) darkening and cracking at the anchor points
//
// `corner` and `surface` are existing storage roles from 00230, not new ones,
// and `corner` already carries an 800px floor plus the 0.30 sharpness gate in
// macro-photo-quality.ts — so it is treated as a macro slot the moment it is
// offered, with no further wiring.
//
// HANDLES USE detail_2, NOT accessory. `accessory` means the dust bag and the
// papers; putting a handle close-up there would file evidence about the item
// under evidence about what came WITH the item, and the grader reads the two
// differently.
//
// THE ROLE ORDER IS THE GALLERY ORDER — roles[] drives sort_order and index 0
// is the eBay cover (vault/20-domain/listing-photos.md). Index 0 is still
// `front`, so no bag's cover image moves. What DID move: the condition shots
// (corners, handles, hardware, base) now rank ahead of the interior and the
// date code. That is deliberate on a resale listing — a buyer scrolling wants
// to see the corners before the serial tag, and the date code is the least
// appealing photo on the page.
//
// Only front, back and the brand stamp stay REQUIRED. Making six slots required
// would block a seller from advancing an item they have already photographed
// well enough to list, which is a different question from whether the grade
// will be confident — image-quality.ts already caps confidence on a thin set,
// which is the right instrument for "we could not see the corners".
const BAGS: PhotoProfile = {
  category: "bags",
  label: "Bags",
  roles: [
    role("front", "Front", "Full front, upright", true, "shopping-bag"),
    role("back", "Back", "Full back", true, "shopping-bag"),
    role("marking", "Brand Stamp", "Heat stamp / logo plate", true, "stamp"),
    role("corner", "Corners & Edges", "Close on one bottom corner and the edge paint — the heaviest part of the grade", false, "scan"),
    role("detail", "Handles & Straps", "Handle wrap and strap anchor points, close enough to see darkening or cracking", false, "search", "handles"),
    role("detail", "Hardware", "Zippers, clasps, feet — close enough to see plating wear", false, "search"),
    role("surface", "Base", "The bottom of the bag, flat on, showing sag and corner collapse", false, "layout-grid"),
    role("interior", "Interior", "Lining, pockets, interior tags", false, "layers"),
    role("serial", "Date / Serial Code", "Date code or serial tag", false, "hash"),
    role("accessory", "Dust Bag / Extras", "Dust bag, strap, papers", false, "package"),
    DEFECT,
  ],
};

// US-2224: two slots for where these items actually fail.
//
// edges_terminations carries 20% of the accessories grade and had no slot: a
// tie's tipping and keeper, a belt's hole elongation and cut end, a scarf's
// fringe, a glove's fingertips. None of those resolve in a full-length "front"
// shot, so the grader was being asked to score an area the seller was never
// asked to photograph — the same gap US-2225 found on bag corners.
//
// `interior` covers the reverse and the lining, which is where a tie's
// interlining collapse and a glove's lining wear are visible at all.
//
// The generic "Detail" slot stays and is relabelled to say what it is FOR here.
// Leaving it as "Detail" next to two specific slots invites the seller to put
// the edge shot in the wrong one.
// US-2223 AC3. Grading a cap from front/back/label alone cannot see the
// sweatband, which is where the wear is — the story's own words and the reason
// this profile exists rather than falling through to the clothing default.
//
// `interior` IS the sweatband shot: it is the existing role for "turn it over
// and show the inside", and inventing a `sweatband` storage type would need an
// image_type enum migration for a photo the existing role already describes.
// Its label says so, because "Interior" alone does not tell a seller to
// photograph the one thing a buyer checks first.
//
// US-2797: this said "inert alongside the rubric until item_category gains
// 'headwear'". Migration 00570 gave it that value on 2026-08-09. What kept the
// profile unreachable afterwards was ai-extract.ts's copy of the category list,
// which could not offer the answer. See the note on rubric.ts HEADWEAR.
const HEADWEAR: PhotoProfile = {
  category: "headwear",
  label: "Hats & caps",
  roles: [
    role("front", "Front", "Front panel and logo, straight on", true, "image"),
    role("back", "Back", "Back panel and closure", true, "image"),
    role("interior", "Sweatband", "Turn it over — the interior band, where wear shows first and every buyer looks", false, "layers"),
    role("angle", "Crown & Brim", "Three-quarter view showing crown shape and brim curve together", false, "scan"),
    role("detail", "Graphics", "Close on the embroidery or print", false, "search"),
    role("tag", "Size / Brand Tag", "Interior size or brand label", false, "tag"),
    DEFECT,
  ],
};

const ACCESSORIES: PhotoProfile = {
  category: "accessories",
  label: "Accessories",
  roles: [
    role("front", "Front", "Main view in frame", true, "glasses"),
    role("back", "Back", "Reverse view", true, "glasses"),
    role("detail", "Ends & Edges", "Tie tip and keeper, belt holes and cut end, scarf fringe, glove fingertips — this is where wear shows first", false, "scan", "ends_edges"),
    role("detail", "Hardware / Weave", "Buckle and prong, or a close-up of the weave and texture", false, "search"),
    role("interior", "Reverse / Lining", "Back face or lining — interlining collapse and lining wear", false, "layers"),
    role("tag", "Brand Tag", "Brand / size tag or stamp", false, "tag"),
    DEFECT,
  ],
};

const OTHER: PhotoProfile = {
  category: "other",
  label: "Other",
  roles: [
    role("front", "Front", "Main view in frame", true, "image"),
    role("back", "Back", "Reverse view", true, "image"),
    role("detail", "Detail", "Distinguishing detail or label", false, "search"),
    DEFECT,
  ],
};

export const PHOTO_PROFILES: Record<string, PhotoProfile> = {
  clothing: CLOTHING,
  "clothing:top": CLOTHING_TOP,
  "clothing:bottom": CLOTHING_BOTTOM,
  "clothing:dress": CLOTHING_DRESS,
  "clothing:outerwear": CLOTHING_OUTERWEAR,
  "clothing:suit": CLOTHING_SUIT,
  shoes: SHOES,
  watches: WATCHES,
  jewelry: JEWELRY,
  sports_cards: SPORTS_CARDS,
  collectibles: COLLECTIBLES,
  electronics: ELECTRONICS,
  books: BOOKS,
  bags: BAGS,
  headwear: HEADWEAR,
  accessories: ACCESSORIES,
  other: OTHER,
};

// US-2465: the clothing sub-profiles, keyed by garment group. Served alongside
// the item_category profiles under `clothing:<group>` keys so a client that
// only knows about item_category still gets a valid table.
export const CLOTHING_SUB_PROFILES: Record<string, PhotoProfile> = {
  top: CLOTHING_TOP,
  bottom: CLOTHING_BOTTOM,
  dress: CLOTHING_DRESS,
  outerwear: CLOTHING_OUTERWEAR,
  suit: CLOTHING_SUIT,
};

// A null/unknown category keeps the historical clothing behavior.
export const DEFAULT_PROFILE: PhotoProfile = CLOTHING;

/**
 * Resolve the photo profile for an item.
 *
 * `category` is the item_category enum (clothing, shoes, bags…). `garment` is
 * the free-text `inventory_items.category` ("blazer", "dress pants") and is only
 * consulted for clothing, where item_category alone is too coarse: it is the
 * difference between offering a t-shirt an inseam slot and not.
 *
 * A garment that does not map to a sub-profile — an unrecognised word, or a
 * group like `accessory` that has its own item_category profile — falls back to
 * the flat CLOTHING profile, which is exactly the pre-US-2465 behavior.
 */
// Garment groups that already have a dedicated item_category profile. The
// measurement groups and the item_category enum are two different taxonomies
// that happen to overlap here, and this is the join between them.
const GROUP_TO_CATEGORY: Record<string, string> = {
  shoes: "shoes",
  watch: "watches",
  bag: "bags",
  accessory: "accessories",
  headwear: "headwear",
};

export function getPhotoProfile(
  category: string | null | undefined,
  garment?: string | null,
): PhotoProfile {
  // An explicit, known item_category wins outright.
  if (category && category !== "clothing" && PHOTO_PROFILES[category]) {
    return PHOTO_PROFILES[category];
  }
  // Falling back to `category` here is not sloppiness — it is the fix for a
  // real miswiring. `items_full` exposes only the free-text `category`; it has
  // no `item_category` column, so the web composer has always passed the
  // GARMENT word ("sneakers", "blazer") into this lookup. That silently missed
  // every non-clothing profile unless the seller happened to type the enum
  // value verbatim. Resolving a garment group from whichever string we were
  // given makes both call shapes correct.
  const group = measurementGroupFor(garment ?? category);
  const byGroup = GROUP_TO_CATEGORY[group];
  if (byGroup && PHOTO_PROFILES[byGroup]) return PHOTO_PROFILES[byGroup];
  return CLOTHING_SUB_PROFILES[group] ?? DEFAULT_PROFILE;
}

// ── US-2134 AC1: the authenticity macros are only asked for when they are usable ─
//
// `serial` and `marking` mean two different things depending on the category,
// and that is why this filter is scoped rather than global:
//
//   • On a WATCH, a HANDBAG, JEWELLERY or a CARD, the serial/reference and the
//     hallmark are core CONDITION evidence. A watch without its reference number
//     is under-photographed whatever add-ons anyone bought. Those profiles keep
//     the slots unconditionally — several even mark them required.
//   • On CLOTHING they are authenticity extras. The condition grade never reads
//     them, and until now every clothing seller was asked to "fill the frame
//     with the date code" whether or not the add-on was available to them at
//     all. That is the ask this closes.
//
// Kept OPTIONAL rather than made required in either direction: a condition grade
// must never fail because an authenticity slot was skipped (AC2).
export const AUTHENTICITY_MACRO_TYPES: readonly PhotoStorageType[] = [
  "serial",
  "marking",
];

/** Clothing profiles are the ones built by `clothingProfile` (they share CLOTHING_TAIL). */
const CLOTHING_CATEGORIES = new Set<string>(
  Object.values(CLOTHING_SUB_PROFILES).map((p) => p.category),
);

/**
 * Strip the clothing authenticity macros when the seller cannot use them.
 *
 * PURE, and the eligibility read lives in the route — this file is a static
 * table and must stay unit-testable without a database.
 *
 * `eligible = true` returns the SAME OBJECT, not a copy. That is deliberate:
 * the eligible path is the pre-US-2134 behaviour and identity makes "we changed
 * nothing for the sellers who have the add-on" checkable rather than asserted.
 */
export function applyAuthenticityMacroVisibility(
  profile: PhotoProfile,
  eligible: boolean,
): PhotoProfile {
  if (eligible) return profile;
  if (!CLOTHING_CATEGORIES.has(profile.category)) return profile;
  const roles = profile.roles.filter(
    (r) => !AUTHENTICITY_MACRO_TYPES.includes(r.type),
  );
  if (roles.length === profile.roles.length) return profile;
  return { ...profile, roles };
}

/** Required storage photo types for a category (drives the "photographed" gate). */
export function requiredPhotoTypesFor(
  category: string | null | undefined,
  garment?: string | null,
): PhotoStorageType[] {
  return getPhotoProfile(category, garment)
    .roles.filter((r) => r.required)
    .map((r) => r.type);
}
