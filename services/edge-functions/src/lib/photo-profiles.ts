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
  | "surface";

export interface PhotoRole {
  /** Physical item_photos.photo_type value this slot writes. */
  type: PhotoStorageType;
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
): PhotoRole {
  return { type, label, hint, required, icon };
}

const DEFECT = role(
  "defect",
  "Defect",
  "Tight crop on any flaw — stain, snag, scuff, crack. Be honest.",
  false,
  "alert-triangle",
);

// ── Per-category profiles ───────────────────────────────────────────────────
// `default` is the clothing profile so a null/unknown category keeps today's
// behavior exactly (front/back/tag/detail required).
const CLOTHING: PhotoProfile = {
  category: "clothing",
  label: "Clothing",
  // Canonical order: Front → Back → Tag → Detail → measurements → defect →
  // extras. Only Front + Back are required; Tag + Detail stay as default
  // capture slots but are optional, since garments like Lululemon frequently
  // ship with the size label cut off (no readable tag exists to photograph).
  roles: [
    role("front", "Front", "Lay flat, full front in frame", true, "shirt"),
    role("back", "Back", "Same crop as the front shot", true, "shirt"),
    role("tag", "Garment Tag", "Care + size label, close enough to read (skip if the tag is missing)", false, "tag"),
    role("detail", "Detail", "Texture, weave, or a distinctive feature", false, "search"),
    // US-1571: the MeasureCard calibration frame the photo-measurement
    // pipeline reads. Never listed / never fed to generation AI (edge
    // filterListablePhotos) — this slot exists so tagging surfaces show the
    // capture guidance.
    role(
      "measurement",
      "Measurement card",
      "Whole garment flat with the MeasureCard BESIDE it — all 4 squares visible, shot top-down",
      false,
      "ruler",
    ),
    role("measurement_chest", "Measure: Chest / Bust", "Tape across the chest, garment flat, pit to pit", false, "ruler"),
    role("measurement_waist", "Measure: Waist", "Tape across the waistband, garment flat", false, "ruler"),
    role("measurement_length", "Measure: Length", "Tape top to hem, garment flat", false, "ruler"),
    role("measurement_sleeve", "Measure: Sleeve", "Tape shoulder seam to cuff", false, "ruler"),
    role("measurement_inseam", "Measure: Inseam", "Tape crotch seam to hem", false, "ruler"),
    DEFECT,
    role("tag_2", "Garment Tag 2", "Second tag — brand stamp or care label", false, "tag"),
    role("detail_2", "Detail 2", "Another close-up: hardware, stitching, print", false, "search"),
    role("detail_3", "Detail 3", "Another close-up", false, "search"),
    role("detail_4", "Detail 4", "Another close-up", false, "search"),
    role("interior", "Interior / Lining", "Inside-out: lining, seams, interior tags", false, "layers"),
    // US-2134: authenticity macro evidence. The authenticity pass asks the model
    // about date codes, stamps and hardware engraving, but until now a CLOTHING
    // seller was never offered a slot to photograph any of it — `serial` and
    // `marking` existed (migration 00230) and were surfaced only for non-clothing
    // profiles. So the prompt requested evidence the capture flow never collected.
    //
    // Deliberately OPTIONAL: a condition grade must never fail because an
    // authenticity slot was skipped, and most sellers are not running the add-on.
    // The hints are written for macro capture specifically — fill the frame and
    // brace the phone — because these tells are only legible at close range and
    // an unusably distant shot is worse than no shot (it looks like evidence).
    role(
      "serial",
      "Serial / Date code",
      "Fill the frame with the code — get close, hold steady, avoid glare",
      false,
      "hash",
    ),
    role(
      "marking",
      "Brand stamp / Hardware",
      "Close-up of an embossed logo, engraved zipper pull, rivet or button",
      false,
      "stamp",
    ),
    role("flatlay", "Flat lay", "Styled flat lay for the listing gallery", false, "layout-grid"),
    role("on_model", "On model", "Worn on a model or mannequin", false, "user"),
  ],
};

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
    role("detail_2", "Handles & Straps", "Handle wrap and strap anchor points, close enough to see darkening or cracking", false, "search"),
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
// Inert alongside the rubric until item_category gains 'headwear'.
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
    role("detail_2", "Ends & Edges", "Tie tip and keeper, belt holes and cut end, scarf fringe, glove fingertips — this is where wear shows first", false, "scan"),
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

// A null/unknown category keeps the historical clothing behavior.
export const DEFAULT_PROFILE: PhotoProfile = CLOTHING;

export function getPhotoProfile(category: string | null | undefined): PhotoProfile {
  if (!category) return DEFAULT_PROFILE;
  return PHOTO_PROFILES[category] ?? DEFAULT_PROFILE;
}

/** Required storage photo types for a category (drives the "photographed" gate). */
export function requiredPhotoTypesFor(
  category: string | null | undefined,
): PhotoStorageType[] {
  return getPhotoProfile(category)
    .roles.filter((r) => r.required)
    .map((r) => r.type);
}
