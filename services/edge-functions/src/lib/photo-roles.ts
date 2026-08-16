// US-2463. The photo ROLE vocabulary: the qualifier that says what a photo
// actually shows, alongside the small storage TYPE that says where it lives.
//
// WHY THIS SPLIT EXISTS. The tag vocabulary used to carry two jobs in one name:
// what the photo shows AND which copy it is. That is where `tag_2`, `detail_2`,
// `detail_3`, `detail_4` and the five fixed `measurement_*` types came from, and
// it produced three separate failures:
//
//   1. An arbitrary cap. Two tag slots and four detail slots, so a two-piece
//      suit could not hold a brand label plus a size tag for each piece.
//   2. A flat 28-entry picker where six of the entries were near-duplicates of
//      each other ("Detail 2", "Detail 3", …), which is what made it unnavigable.
//   3. An enum that had to grow for every new idea. Adding a photo slot for the
//      shoulder measurement meant a Postgres migration, and Postgres cannot
//      remove an enum value afterwards without rebuilding the type.
//
// So: `flipdesk_photo_type` stays small and stable, and `item_photos.photo_role`
// (open text, no CHECK constraint — deliberately) carries the meaning. A new
// sub-role ships as a line in this file. There is no migration, ever.
//
// THE PROFILES ALREADY DID THIS INFORMALLY, which is the strongest argument for
// formalising it: photo-profiles.ts labels `detail_2` as "Handles & Straps" for
// bags and "Ends & Edges" for accessories, and `interior` as "Sweatband" for
// headwear. The meaning was already per-category; it just had nowhere to live,
// so retagging one of those photos in the web picker showed "Detail 2".
//
// MIRRORED FILE. services/edge-functions/src/lib/photo-roles.ts must stay
// identical to this one apart from the Deno import extension; the parity test
// in src/test/photo-roles-parity.test.ts normalises that single difference and
// compares the rest byte for byte.

import {
  MEASUREMENT_TEMPLATES,
  type MeasurementGroup,
} from "./measurement-templates.ts";

/** One qualifier. `key` is the literal `item_photos.photo_role` value. */
export interface PhotoRoleDef {
  key: string;
  label: string;
  hint: string;
}

// ── Tag roles ───────────────────────────────────────────────────────────────
// A garment carries up to four distinct labels and a buyer asks about three of
// them. Splitting them is not cosmetic: `ai-extract` reads the BRAND off one and
// the SIZE and fibre content off another, and today it has to guess which of
// `tag` / `tag_2` is which.
export const TAG_ROLES: readonly PhotoRoleDef[] = [
  {
    key: "brand",
    label: "Brand label",
    hint: "The maker's logo or wordmark — usually a separate neck or waistband tag",
  },
  {
    key: "size",
    label: "Size tag",
    hint: "The size itself, close enough to read without zooming",
  },
  {
    key: "care",
    label: "Care & fabric",
    hint: "The care label with the fibre content — the question buyers ask most",
  },
  {
    // The one genuinely new idea in this list. Vintage resale dates a garment
    // by its union label, its "Made in USA" line or its RN number, and there
    // was no slot for any of it — a seller photographing one had to file it
    // under "Garment Tag 2".
    key: "made_in",
    label: "Made in / union label",
    hint: "Origin, union or RN label — this is what dates a vintage piece",
  },
] as const;

// ── Detail roles ────────────────────────────────────────────────────────────
// `fabric` is load-bearing beyond the picker: the grading confidence cap asks
// whether a fabric close-up exists, and before this it could only approximate
// that by asking whether ANY numbered detail slot was filled (US-2467).
export const DETAIL_ROLES: readonly PhotoRoleDef[] = [
  {
    key: "fabric",
    label: "Fabric close-up",
    hint: "Fill the frame with the weave or knit, in even light — the grader reads pilling and thinning from this",
  },
  {
    key: "hem",
    label: "Hem & stitching",
    hint: "A hem or seam up close — single stitching is a dating tell on vintage",
  },
  {
    key: "hardware",
    label: "Hardware",
    hint: "Zip pull, buttons, rivets or snaps — show plating wear honestly",
  },
  {
    key: "pocket",
    label: "Pocket",
    hint: "Pocket opening and the corners, where tearing starts",
  },
  {
    key: "print",
    label: "Print or graphic",
    hint: "The graphic straight on, close enough to show any cracking",
  },
  {
    key: "collar",
    label: "Collar or cuff",
    hint: "Collar and cuffs — the first place a shirt shows its age",
  },
] as const;

// Per-group detail roles, appended to the six above. These exist because the
// old profiles expressed them by hijacking `detail_2` and giving it a
// category-specific label — "Handles & Straps" for bags, "Ends & Edges" for
// accessories. That is what a role IS, so they become roles.
//
// Kept OUT of the base list on purpose: "Handles & straps" in a t-shirt's
// detail dropdown is precisely the noise this epic set out to remove.
const DETAIL_ROLES_BY_GROUP: Record<string, readonly PhotoRoleDef[]> = {
  bag: [
    {
      key: "handles",
      label: "Handles & straps",
      hint: "Handle wrap and strap anchor points, close enough to see darkening or cracking",
    },
    {
      key: "base",
      label: "Base",
      hint: "The bottom of the bag flat on, showing sag and corner collapse",
    },
  ],
  accessory: [
    {
      key: "ends_edges",
      label: "Ends & edges",
      hint: "Tie tip and keeper, belt holes and cut end, scarf fringe, glove fingertips — wear shows here first",
    },
  ],
  shoes: [
    {
      key: "insole",
      label: "Insole",
      hint: "Inside the shoe — footbed wear and any heel-strike collapse",
    },
  ],
};

/** The detail roles offered for a garment group: the base six plus its own. */
export function detailRolesFor(group: MeasurementGroup): readonly PhotoRoleDef[] {
  const extra = DETAIL_ROLES_BY_GROUP[group];
  return extra ? [...DETAIL_ROLES, ...extra] : DETAIL_ROLES;
}

// Same pattern for tags. Only a suit set needs a second size label, because it
// is the only garment that is genuinely two garments — the jacket and the
// trousers carry different sizes and a buyer needs both.
const TAG_ROLES_BY_GROUP: Record<string, readonly PhotoRoleDef[]> = {
  suit: [
    {
      key: "size_alt",
      label: "Trouser size tag",
      hint: "The trousers' own size label — a suit is two sizes, not one",
    },
  ],
};

/** The tag roles offered for a garment group: the base four plus its own. */
export function tagRolesFor(group: MeasurementGroup): readonly PhotoRoleDef[] {
  const extra = TAG_ROLES_BY_GROUP[group];
  return extra ? [...TAG_ROLES, ...extra] : TAG_ROLES;
}

// ── Measurement roles ───────────────────────────────────────────────────────
// DERIVED, never hand-listed. The measurement form already knows that a top has
// no inseam and a blazer has a shoulder (measurement-templates.ts); deriving the
// photo slots from the same table is what makes the two agree by construction
// rather than by somebody remembering to update both.
//
// The practical payoff: adding a measurement field gets it a photo slot for
// free, in every client, with no migration and no second edit.
const MEASUREMENT_HINTS: Record<string, string> = {
  chest: "Tape across the chest, pit to pit, garment flat",
  bust: "Tape across the bust, garment flat",
  waist: "Tape across the waistband, garment flat",
  length: "Tape from the high point of the shoulder down to the hem",
  sleeve: "Tape from the shoulder seam to the cuff",
  inseam: "Tape from the crotch seam to the hem",
  shoulder: "Tape seam to seam across the back",
  rise: "Tape from the crotch seam up to the top of the waistband",
  hip: "Tape across the widest point below the waist",
  leg_opening: "Tape across the hem of one leg",
  circumference: "Tape around the inside of the sweatband",
  crown_height: "Tape from the brim seam to the top of the crown",
  brim_length: "Tape from the crown seam to the front edge of the brim",
  width: "Tape across the widest point",
  height: "Tape from the base to the top",
  depth: "Tape front to back at the base",
  strap_drop: "Fold the strap and tape from the shoulder point down",
  handle_drop: "Fold the handle and tape from the top down",
  hole_span: "Tape from the first hole to the last",
  insole: "Tape the inside of the shoe, heel to toe",
  case_diameter: "Calipers across the case, crown excluded",
  lug_width: "Calipers between the lugs",
  band_length: "Tape the band end to end, clasp included",
};

/**
 * The measurement photo slots for a garment group, one per field on that
 * group's measurement template and in the same order.
 */
export function measurementRolesFor(group: MeasurementGroup): PhotoRoleDef[] {
  return MEASUREMENT_TEMPLATES[group].map((f) => ({
    key: f.key,
    label: f.label,
    hint: MEASUREMENT_HINTS[f.key] ?? `Tape the ${f.label.toLowerCase()}, garment flat`,
  }));
}

// ── Which types take a role at all ──────────────────────────────────────────
/**
 * The roles offered for a storage type. A type absent from this map takes no
 * qualifier and stores `photo_role` as NULL — `front` shows a front, and there
 * is nothing further to say about it.
 */
export function rolesForType(
  type: string,
  group: MeasurementGroup = "generic",
): readonly PhotoRoleDef[] {
  if (type === "tag") return tagRolesFor(group);
  if (type === "detail") return detailRolesFor(group);
  if (type === "measurement") return measurementRolesFor(group);
  return [];
}

/** True when a type has any qualifier to pick. */
export function typeTakesRole(type: string): boolean {
  return type === "tag" || type === "detail" || type === "measurement";
}

/** The display label for a stored (type, role) pair, or null if the role is unknown. */
export function roleLabel(
  type: string,
  role: string | null | undefined,
  group: MeasurementGroup = "generic",
): string | null {
  if (!role) return null;
  return rolesForType(type, group).find((r) => r.key === role)?.label ?? null;
}

// ── Retired types ───────────────────────────────────────────────────────────
// These stay valid in the `flipdesk_photo_type` enum forever — Postgres cannot
// drop an enum value without rebuilding the type, and millions of historical
// rows point at them. They are removed from the PICKERS only, and migration
// 00587 rewrites existing rows onto the (type, role) pair below.
//
// The map is exported so the UI can still label a photo that has not been
// rewritten yet, and so the migration and the client cannot disagree about what
// `measurement_chest` meant.
export const RETIRED_PHOTO_TYPES: Record<
  string,
  { type: string; role: string | null }
> = {
  tag_2: { type: "tag", role: null },
  detail_2: { type: "detail", role: null },
  detail_3: { type: "detail", role: null },
  detail_4: { type: "detail", role: null },
  measurement_chest: { type: "measurement", role: "chest" },
  measurement_waist: { type: "measurement", role: "waist" },
  measurement_length: { type: "measurement", role: "length" },
  measurement_sleeve: { type: "measurement", role: "sleeve" },
  measurement_inseam: { type: "measurement", role: "inseam" },
};

/** True when a type must not be offered as a new choice in a picker. */
export function isRetiredPhotoType(type: string): boolean {
  return type in RETIRED_PHOTO_TYPES;
}

// ── US-2625: the two ways a picker can offer the wrong thing ────────────────

/**
 * Types the SYSTEM produces and a seller must never be handed as a choice.
 *
 * `measurement_overlay` is the annotated render this app writes from a
 * calibrated card shot. Offering it as a manual tag was actively harmful in
 * three directions at once: the card scan skips it (it is a render, it cannot
 * BE a card), the overlay writer treats rows of that type as its own output to
 * replace, and eBay rejects the graphic outright. A seller reading
 * "Measurements photo (generated)" next to their MeasureCard shot had every
 * reason to pick it, and doing so silently disabled the measuring.
 */
export const SYSTEM_GENERATED_PHOTO_TYPES = new Set<string>([
  "measurement_overlay",
]);

export function isSystemGeneratedPhotoType(type: string): boolean {
  return SYSTEM_GENERATED_PHOTO_TYPES.has(type);
}

/**
 * Types whose BARE form — the type with no role — is its own distinct choice,
 * offered ALONGSIDE the roles rather than replaced by them.
 *
 * `measurement` is the only one, and the distinction is load-bearing rather
 * than cosmetic: `measurement` + a role is a tape close-up, which lists;
 * `measurement` + NO role is the MeasureCard calibration frame, which never
 * lists and is the single photo the whole measuring pipeline reads
 * (isNonListableItemPhoto encodes exactly this split).
 *
 * A picker that emits only the roles therefore offers no way to tag the one
 * photo that matters. That is what happened: the profiles listed a MeasureCard
 * slot, the picker filtered its options through this vocabulary, the bare form
 * was absent, and the slot vanished from the menu without anyone noticing.
 */
export const BARE_FORM_LABELS: Record<string, string> = {
  measurement: "MeasureCard photo (card beside the garment)",
};

export function bareFormLabel(type: string): string | null {
  return BARE_FORM_LABELS[type] ?? null;
}
