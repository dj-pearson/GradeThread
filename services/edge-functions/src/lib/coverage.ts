// US-1276: 2D photo coverage scoring engine.
//
// "LiDAR-style" coverage from ordinary 2D photos: given the images a seller
// submitted, compute which standard inspection ZONES of the garment were
// actually documented, so a grade — and any future guarantee (US-1279/1280) —
// can be scoped to what the photos prove. This works on every device because it
// reads the per-image view signal (image_type) plus the per-image vision zone
// hints (issue/style/signal locations from ai-grading.ts), NOT depth data. True
// 3D/photogrammetry coverage is the separate premium story (US-1281).
//
// Pure + dependency-free (no supabase/env) so it unit-tests without the env
// dance; the grading pipeline maps perImageResults → CoverageImageSignal[] and
// persists the result on grade_reports.coverage.

// A garment's standard inspection zones. A zone is only ever counted for a
// garment type that actually HAS it (a scarf has no pockets), so absent zones
// never inflate the denominator.
export interface InspectionZone {
  id: string;
  label: string;
  // image_types (views) that document this zone. A submitted image of one of
  // these views counts the zone as covered. Close-up zones list the DETAIL/
  // defect views; structural zones list their dedicated view.
  views: string[];
}

// The lightweight per-image signal the engine consumes. Decoupled from the full
// PerImageAnalysis so coverage.ts stays pure and tests build tiny fixtures.
export interface CoverageImageSignal {
  // Submitted view, e.g. "front", "back", "label", "detail_2", "defect".
  image_type: string;
  // Free-text location/issue strings observed by the vision pass on THIS image
  // (detected-issue locations, style-attribute locations, condition signals).
  // Keyword-matched to zones, so a close-up whose issue is "frayed collar"
  // credits the collar zone even if the view is a generic "detail".
  zone_hints?: string[];
}

export interface CoverageResult {
  garment_category: string;
  // Zones this garment type legitimately has — the coverage denominator.
  applicable_zones: string[];
  covered_zones: string[];
  // applicable_zones that no submitted image documented.
  missing_zones: string[];
  // covered / applicable, 0–100, rounded to a whole percent.
  coverage_pct: number;
  // US-1281: true when a passing Verified 360 capture upgraded this result to
  // geometric-complete coverage (every applicable zone documented). Absent on the
  // ordinary 2D path. The source of the coverage figure, for the cert/guarantee.
  verified_360?: boolean;
  coverage_source?: "photos_2d" | "geometric_360";
}

// --- View groups ---

// Close-up views. A DETAIL/defect shot is treated as documentation for whatever
// close-up zone it shows; without a zone hint it credits every close-up zone of
// the garment (the generous v1 model — finer per-zone attribution and true 3D
// are US-1281). LABELS document branding/care tags.
const DETAILS = ["detail", "detail_2", "detail_3", "detail_4", "defect"];
const LABELS = ["label", "label_2"];

// --- Canonical zone factory ---
//
// Each zone lists the views that document it. front/back zones are documented
// only by their dedicated full-garment view (plus close-ups), so a front-only
// submission scores low; close-up zones need a DETAIL view (or the back, where
// the zone is visible from behind), so they only count when the seller actually
// took a closer look.

const ZONES: Record<string, InspectionZone> = {
  front: { id: "front", label: "Front", views: ["front", ...DETAILS] },
  back: { id: "back", label: "Back", views: ["back", ...DETAILS] },
  collar_neckline: {
    id: "collar_neckline",
    label: "Collar / neckline",
    views: [...DETAILS, "back"],
  },
  cuffs: { id: "cuffs", label: "Cuffs / sleeve ends", views: [...DETAILS] },
  hem: { id: "hem", label: "Hem", views: [...DETAILS, "back"] },
  underarms: { id: "underarms", label: "Underarms", views: [...DETAILS] },
  waistband: { id: "waistband", label: "Waistband", views: [...DETAILS] },
  inseam_crotch: {
    id: "inseam_crotch",
    label: "Inseam / crotch",
    views: [...DETAILS, "back"],
  },
  pockets: { id: "pockets", label: "Pockets", views: [...DETAILS, "back"] },
  closure: {
    id: "closure",
    label: "Primary closure (zipper/buttons)",
    views: [...DETAILS],
  },
  lining: { id: "lining", label: "Interior lining", views: [...DETAILS] },
  branding: {
    id: "branding",
    label: "Branding / care label",
    views: [...LABELS, ...DETAILS],
  },
  sole: { id: "sole", label: "Sole", views: [...DETAILS, "back"] },
  upper: { id: "upper", label: "Upper", views: ["front", "back", ...DETAILS] },
  insole: { id: "insole", label: "Insole / footbed", views: [...DETAILS] },
  hardware: {
    id: "hardware",
    label: "Hardware (buckles/clasps)",
    views: [...DETAILS],
  },
  strap: {
    id: "strap",
    label: "Strap / handle",
    views: [...DETAILS, "front", "back"],
  },
};

function zonesFor(ids: string[]): InspectionZone[] {
  return ids
    .map((id) => ZONES[id])
    .filter((z): z is InspectionZone => z !== undefined);
}

// Shared zone sets.
const TOP_BASE = [
  "front",
  "back",
  "collar_neckline",
  "cuffs",
  "hem",
  "underarms",
  "branding",
];

// --- Per-garment-category templates ---
//
// Keyed on garment_category (the 20-value list in src/lib/constants.ts). A zone
// is in a category's template ONLY if that garment type actually has it, so
// legitimately-absent zones (a scarf has no pockets, a t-shirt has no closure)
// are excluded from the denominator rather than counted as missing.

const TEMPLATES: Record<string, string[]> = {
  // Tops
  "t-shirt": TOP_BASE,
  sweater: TOP_BASE,
  shirt: [...TOP_BASE, "closure", "pockets"],
  blouse: [...TOP_BASE, "closure"],
  hoodie: [...TOP_BASE, "pockets", "closure"],
  // Outerwear
  jacket: [
    "front",
    "back",
    "collar_neckline",
    "cuffs",
    "hem",
    "closure",
    "pockets",
    "lining",
    "branding",
  ],
  coat: [
    "front",
    "back",
    "collar_neckline",
    "cuffs",
    "hem",
    "closure",
    "pockets",
    "lining",
    "branding",
  ],
  // Bottoms
  jeans: [
    "front",
    "back",
    "waistband",
    "inseam_crotch",
    "hem",
    "pockets",
    "closure",
    "branding",
  ],
  pants: [
    "front",
    "back",
    "waistband",
    "inseam_crotch",
    "hem",
    "pockets",
    "closure",
    "branding",
  ],
  shorts: [
    "front",
    "back",
    "waistband",
    "inseam_crotch",
    "hem",
    "pockets",
    "closure",
    "branding",
  ],
  // Skirt (no inseam, typically no pockets — legitimately absent)
  skirt: ["front", "back", "waistband", "hem", "closure", "branding"],
  // Dress
  dress: [
    "front",
    "back",
    "collar_neckline",
    "underarms",
    "hem",
    "closure",
    "lining",
    "branding",
  ],
  // Footwear
  sneakers: ["upper", "sole", "insole", "closure", "branding"],
  boots: ["upper", "sole", "insole", "closure", "branding"],
  sandals: ["upper", "sole", "insole", "closure", "branding"],
  // Accessories
  hat: ["front", "back", "branding"],
  bag: ["front", "back", "lining", "hardware", "strap", "branding"],
  belt: ["front", "back", "hardware", "branding"],
  scarf: ["front", "back", "branding"],
  other: ["front", "back", "branding"],
};

const DEFAULT_TEMPLATE: string[] = TEMPLATES.other ?? [];

/** The inspection-zone template for a garment_category (falls back to a minimal
 * front/back/branding template for an unknown category). Exported for tests. */
export function inspectionTemplate(garmentCategory: string): InspectionZone[] {
  const ids = TEMPLATES[(garmentCategory || "").toLowerCase()] ?? DEFAULT_TEMPLATE;
  return zonesFor(ids);
}

// --- Zone-hint keyword matching ---
//
// Maps a substring found in a vision location/issue string to a zone id. Only
// credits a zone when it's in the garment's template, so e.g. "buckle" → hardware
// is ignored on a t-shirt. Ordered longest-first isn't required because each
// entry is a distinct, low-collision token.
const HINT_ALIASES: Array<[string, string]> = [
  ["collar", "collar_neckline"],
  ["neckline", "collar_neckline"],
  ["neck", "collar_neckline"],
  ["cuff", "cuffs"],
  ["sleeve", "cuffs"],
  ["wrist", "cuffs"],
  ["hem", "hem"],
  ["underarm", "underarms"],
  ["armpit", "underarms"],
  ["armhole", "underarms"],
  ["waistband", "waistband"],
  ["waist", "waistband"],
  ["crotch", "inseam_crotch"],
  ["inseam", "inseam_crotch"],
  ["rise", "inseam_crotch"],
  ["pocket", "pockets"],
  ["zipper", "closure"],
  ["zip", "closure"],
  ["button", "closure"],
  ["fly", "closure"],
  ["snap", "closure"],
  ["closure", "closure"],
  ["lining", "lining"],
  ["interior", "lining"],
  ["inner", "lining"],
  ["outsole", "sole"],
  ["sole", "sole"],
  ["insole", "insole"],
  ["footbed", "insole"],
  ["upper", "upper"],
  ["vamp", "upper"],
  ["toe", "upper"],
  ["buckle", "hardware"],
  ["clasp", "hardware"],
  ["hardware", "hardware"],
  ["strap", "strap"],
  ["handle", "strap"],
  ["brand", "branding"],
  ["label", "branding"],
  ["care tag", "branding"],
  ["tag", "branding"],
  ["chest", "front"],
  ["bust", "front"],
  ["seat", "back"],
  ["rear", "back"],
  ["front", "front"],
  ["back", "back"],
];

/** Zones referenced by a single free-text hint (a string may name several). */
function zonesFromHint(hint: string): string[] {
  const h = hint.toLowerCase();
  const out: string[] = [];
  for (const [token, zone] of HINT_ALIASES) {
    if (h.includes(token)) out.push(zone);
  }
  return out;
}

// --- Coverage computation ---

/**
 * Compute which inspection zones the submitted photos document for a garment.
 * A zone counts as covered when at least one image either (a) is a view that
 * documents it, or (b) carries a vision zone hint naming it. Zones absent from
 * the garment's template are excluded from the denominator entirely.
 */
export function computeCoverage(
  garmentCategory: string,
  images: CoverageImageSignal[],
): CoverageResult {
  const template = inspectionTemplate(garmentCategory);
  const applicable = template.map((z) => z.id);
  const applicableSet = new Set(applicable);
  const covered = new Set<string>();

  for (const img of images) {
    const view = (img.image_type || "").toLowerCase().trim();
    // (a) structural view → zones it documents
    for (const zone of template) {
      if (zone.views.includes(view)) covered.add(zone.id);
    }
    // (b) per-image vision zone hints → zones (only if the garment has them)
    for (const hint of img.zone_hints ?? []) {
      if (typeof hint !== "string") continue;
      for (const zid of zonesFromHint(hint)) {
        if (applicableSet.has(zid)) covered.add(zid);
      }
    }
  }

  const coveredZones = applicable.filter((z) => covered.has(z));
  const missingZones = applicable.filter((z) => !covered.has(z));
  const coveragePct =
    applicable.length === 0
      ? 0
      : Math.round((coveredZones.length / applicable.length) * 100);

  return {
    garment_category: garmentCategory,
    applicable_zones: applicable,
    covered_zones: coveredZones,
    missing_zones: missingZones,
    coverage_pct: coveragePct,
  };
}
