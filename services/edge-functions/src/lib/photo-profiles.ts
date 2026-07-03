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

const BAGS: PhotoProfile = {
  category: "bags",
  label: "Bags",
  roles: [
    role("front", "Front", "Full front, upright", true, "shopping-bag"),
    role("back", "Back", "Full back", true, "shopping-bag"),
    role("marking", "Brand Stamp", "Heat stamp / logo plate", true, "stamp"),
    role("serial", "Date / Serial Code", "Date code or serial tag", false, "hash"),
    role("interior", "Interior", "Lining, pockets, interior tags", false, "layers"),
    role("detail", "Hardware", "Zippers, clasps, feet, handles", false, "search"),
    role("accessory", "Dust Bag / Extras", "Dust bag, strap, papers", false, "package"),
    DEFECT,
  ],
};

const ACCESSORIES: PhotoProfile = {
  category: "accessories",
  label: "Accessories",
  roles: [
    role("front", "Front", "Main view in frame", true, "glasses"),
    role("back", "Back", "Reverse view", true, "glasses"),
    role("tag", "Brand Tag", "Brand / size tag or stamp", false, "tag"),
    role("detail", "Detail", "Material, hardware, distinctive feature", false, "search"),
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
