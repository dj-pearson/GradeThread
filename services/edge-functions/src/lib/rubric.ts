// Category-specific grading rubrics (server source of truth).
//
// Condition grading is currently clothing-only — see ai-grading.ts, whose
// FACTOR_WEIGHTS / FactorScores hardcode the 5 garment factors. This module
// defines the rubric PER item_category so the grading pipeline can, in the
// activation phase, select factors + weights + prompt guidance + defect routing
// by category instead of assuming clothing.
//
// NOT YET WIRED into the live pipeline, so clothing grading is byte-for-byte
// unchanged. The web mirror (src/lib/rubrics.ts) renders certificates from
// these definitions and MUST stay in sync (factor keys + weights + labels) —
// pinned by src/test/fixtures/rubric-factors.json, which both suites assert.
// The clothing weights here are identical to ai-grading.ts FACTOR_WEIGHTS.
//
// Activation checklist (US-1997 decided ACTIVATE; this is a multi-phase
// program, so the checklist records what is done and what is not):
//   1. TODO — Pass item_category into the grading pipeline (flipdesk-grading
//      currently maps it to garment_type; non-clothing has neither, and
//      submissions requires garment_type NOT NULL — de-gate that first).
//   2. Select the rubric by item_category; build the composite prompt from
//      rubric.factors + rubric.promptGuidance; compute the overall score from
//      these weights; route defects via rubric.defectRouting.
//      - DONE: the scoring math — computeRubricWeightedOverall below, pinned
//        against the clothing implementations it generalizes.
//      - DONE: defect routing — routeDefectToRubricFactors below, with the
//        routing tables reconciled to the shared DefectType taxonomy. Seven
//        non-clothing entries had been keyed on invented defect names that
//        coerceDefectType maps to `other`, so they could never have fired; see
//        the Rubric.defectRouting comment. The type + rubric-parity_test.ts now
//        make that class of entry impossible to add back.
//      - TODO: the per-category composite prompts, and extending DefectType
//        with card/watch vocabulary (corner ding, edge whitening, crystal
//        crack) that has no honest equivalent today. BOTH are prompt changes —
//        DefectType is enumerated to the vision model — so both reach live
//        traffic ONLY through shadow → golden-set eval gate → canary, and no
//        non-clothing golden set exists yet (golden cases grow from real
//        human-corrected grades; they cannot be fabricated). That is the gate
//        this phase is waiting on, not a missing decision.
//   3. TODO — Persist grade_reports.factor_scores (JSONB) + rubric_key on ALL
//      write paths (insert + human-review reseal + adjustment, or the JSONB
//      goes stale against the typed columns); recreate the public_grade_reports
//      view to expose them. The public cert allowlist (content-public.ts
//      CERT_REPORT_COLUMNS) already carries both columns.

import {
  type DefectType,
  FACTOR_ROUTING as CLOTHING_DEFECT_ROUTING,
} from "./defect-weighting.ts";

export interface RubricFactor {
  key: string;
  label: string;
  /** Weights within a rubric sum to 1.0. */
  weight: number;
  /** One-line description fed to the grading model. */
  guidance: string;
}

/**
 * How one defect type's penalty is split across a rubric's factors. Keys are
 * factor keys of THAT rubric; values sum to 1.0. Optional-valued so a
 * `Partial<Record<FactorKey, number>>` from defect-weighting.ts assigns
 * directly — the clothing rubric reuses that table rather than copying it.
 */
export type RubricDefectSplit = Partial<Record<string, number>>;

export interface Rubric {
  /** Matches item_category and grade_reports.rubric_key. */
  key: string;
  label: string;
  factors: RubricFactor[];
  /** Category framing prepended to the composite grading prompt. */
  promptGuidance: string;
  /**
   * Defect-type → factor-weight routing for the deterministic defect-weighting
   * pass, per rubric. Outer keys MUST be members of the shared `DefectType`
   * taxonomy (defect-weighting.ts) — that is now enforced by the type, and by
   * rubric-parity_test.ts at runtime.
   *
   * US-1997 — WHY THE TYPE IS THE POINT. This field used to be
   * `Record<string, …>` and the non-clothing rubrics keyed it on invented
   * vocabulary: `corner_ding`, `edge_whitening`, `surface_scratch`,
   * `off_center`, `crease`, `scratch`, `crack`. None of the seven is a
   * `DefectType`, and `coerceDefectType` maps any unrecognized string to
   * `other` — so every one of those routings was unreachable. A sports card's
   * corner ding would have arrived as `other` and fallen through to the
   * rubric's first factor (surface), never touching `corners`. Nothing failed;
   * the grade would just have been wrong in a way no test looked at. The
   * entries below are reconciled to the real taxonomy, and the card/watch
   * vocabulary that has no honest equivalent is NOT faked — extending the
   * taxonomy is Phase 2 work (checklist step 2), because `DefectType` is also
   * what the vision prompt enumerates.
   *
   * Unmapped defect types fall back to the rubric's FIRST factor — see
   * `routeDefectToRubricFactors`, which is where that rule actually lives now
   * (it was documented here and implemented nowhere).
   */
  defectRouting: Partial<Record<DefectType, RubricDefectSplit>>;
}

const CLOTHING: Rubric = {
  key: "clothing",
  label: "Clothing",
  factors: [
    { key: "fabric_condition", label: "Fabric Condition", weight: 0.3, guidance: "Material integrity: pilling, thinning, holes, stains, fading." },
    { key: "structural_integrity", label: "Structural Integrity", weight: 0.25, guidance: "Seams, hems, construction, shape retention." },
    { key: "cosmetic_appearance", label: "Cosmetic Appearance", weight: 0.2, guidance: "Visual appeal, color consistency, print condition." },
    { key: "functional_elements", label: "Functional Elements", weight: 0.15, guidance: "Zippers, buttons, closures, pockets, elastic." },
    { key: "odor_cleanliness", label: "Odor & Cleanliness", weight: 0.1, guidance: "Cleanliness indicators, staining patterns." },
  ],
  promptGuidance:
    "Grade this garment's condition relative to its as-manufactured state. Intentional design features are not defects.",
  // NOT a copy — the live engine's own table. Clothing is the one rubric that
  // already grades in production, so its routing must BE defect-weighting's,
  // not a subset of it that drifts when that table is tuned (US-2107 warns
  // that tuning it edits a PUBLISHED spec). The three entries this used to
  // hand-copy were correct and covered 3 of the taxonomy's 16 types.
  defectRouting: CLOTHING_DEFECT_ROUTING,
};

const SPORTS_CARDS: Rubric = {
  key: "sports_cards",
  label: "Sports card",
  factors: [
    { key: "surface", label: "Surface", weight: 0.3, guidance: "Scratches, print lines, gloss, indentations, staining across the card face." },
    { key: "corners", label: "Corners", weight: 0.25, guidance: "Sharpness of all four corners; fraying, rounding, dings." },
    { key: "edges", label: "Edges", weight: 0.25, guidance: "Edge whitening, chipping, nicks along all four edges." },
    { key: "centering", label: "Centering", weight: 0.2, guidance: "Front/back border symmetry left-right and top-bottom." },
  ],
  promptGuidance:
    "Grade this trading card like a condition grader (PSA/BGS-style intuition, NOT an official slab grade). Assess surface, corners, edges, and centering independently. Factory print artifacts are not handling damage.",
  // Reconciled to the shared taxonomy. `centering` deliberately has NO routing:
  // it is a factory cut attribute, not handling damage, so no defect should
  // ever debit it — the routing table is the wrong instrument for it and
  // `off_center` was never a DefectType. Corner/edge wear routes through
  // `abrasion_thinning`, which is what that damage physically is.
  defectRouting: {
    wrinkle_crease: { surface: 0.7, corners: 0.3 },
    abrasion_thinning: { edges: 0.6, corners: 0.4 },
    rip_tear: { edges: 0.6, surface: 0.4 },
    hole_puncture: { surface: 1.0 },
    stain: { surface: 1.0 },
    discoloration: { surface: 1.0 },
    fading: { surface: 1.0 },
  },
};

const WATCHES: Rubric = {
  key: "watches",
  label: "Watch",
  factors: [
    { key: "dial_hands", label: "Dial & Hands", weight: 0.3, guidance: "Dial blemishes, lume condition, hand alignment, patina." },
    { key: "case_bracelet", label: "Case & Bracelet", weight: 0.25, guidance: "Case scratches/dings, bracelet/strap wear, clasp condition, stretch." },
    { key: "crystal", label: "Crystal", weight: 0.2, guidance: "Scratches, chips, cracks on the crystal." },
    { key: "movement_function", label: "Movement & Function", weight: 0.15, guidance: "Running condition, complications, crown/pusher action (as observable)." },
    { key: "cosmetic", label: "Cosmetic", weight: 0.1, guidance: "Overall presentation, polish, originality of finish." },
  ],
  promptGuidance:
    "Grade this watch's condition from the photos. Distinguish honest wear from damage; do NOT assert authenticity or service history beyond what's visible.",
  // `scratch` and `crack` were not DefectTypes. Scratching is `abrasion_thinning`;
  // a chipped/cracked crystal is the taxonomy's `hole_puncture` (the only
  // "material breached" type) until Phase 2 gives glass its own term.
  defectRouting: {
    abrasion_thinning: { case_bracelet: 0.6, crystal: 0.4 },
    hole_puncture: { crystal: 1.0 },
    stretched_misshapen: { case_bracelet: 1.0 },
    missing_hardware: { case_bracelet: 0.5, movement_function: 0.5 },
    discoloration: { dial_hands: 0.7, cosmetic: 0.3 },
    stain: { dial_hands: 0.6, cosmetic: 0.4 },
  },
};

const SHOES: Rubric = {
  key: "shoes",
  label: "Shoes",
  factors: [
    { key: "upper", label: "Upper", weight: 0.3, guidance: "Creasing, scuffs, stains, material integrity of the upper." },
    { key: "outsole", label: "Outsole & Tread", weight: 0.25, guidance: "Tread wear, sole separation, yellowing, heel drag." },
    { key: "structure", label: "Structure", weight: 0.2, guidance: "Shape retention, heel counter, midsole compression/cracking." },
    { key: "cosmetic", label: "Cosmetic", weight: 0.15, guidance: "Overall presentation, color, laces, branding." },
    { key: "interior_odor", label: "Interior & Odor", weight: 0.1, guidance: "Insole wear, interior cleanliness, odor indicators." },
  ],
  promptGuidance:
    "Grade these shoes' condition from the photos, including the outsole. Distinguish normal break-in from damage.",
  // These three were already valid taxonomy members; the rest fill obvious gaps
  // (sole separation, midsole yellowing) with terms that already exist.
  defectRouting: {
    abrasion_thinning: { upper: 0.6, cosmetic: 0.4 },
    rip_tear: { upper: 0.6, structure: 0.4 },
    odor_indicator: { interior_odor: 1.0 },
    seam_failure_unthreading: { structure: 0.6, upper: 0.4 },
    stain: { upper: 0.7, cosmetic: 0.3 },
    discoloration: { outsole: 0.6, upper: 0.4 },
  },
};

// US-2225. A handbag is the highest price-per-item thing this system touches
// and it currently grades through the CLOTHING rubric, which spends 30% of the
// score on fabric condition and 10% on odor. Neither is what a bag is worth.
//
// ── WHY THE WEIGHTS ARE SHAPED LIKE THIS ────────────────────────────────────
// Corners and edge paint carry the most weight because they are the first place
// every buyer looks and the most expensive area to restore — a bag with perfect
// panels and worn corners reads as used, and the reverse does not. Handles and
// straps sit next to hardware rather than under "structure" because their
// failure mode is chemical (vachetta darkening, edge-glazing cracking) rather
// than structural, and they are replaceable at a known cost. Interior and
// structure are last not because they do not matter but because they are the
// two a buyer can least see in photographs, and a rubric should not weight
// heavily what the evidence cannot support.
//
// ── THE SEPARATION THAT MATTERS MORE THAN THE WEIGHTS ────────────────────────
// These are exactly the brands the authenticity add-on covers — every tell pack
// we have (louisvuitton, coach, gucci) is a bag brand. So a bag is the one item
// where a condition grade and an authenticity verdict land on the same
// certificate, and a buyer reading "9.2" next to a Louis Vuitton logo will take
// it as a statement about whether the bag is real unless we say otherwise.
// promptGuidance below refuses that explicitly, and the certificate copy is
// test-asserted separately (US-2225 AC3) — the prompt alone is not the guard,
// because a prompt is a request and the rendered page is a claim.
const HANDBAGS: Rubric = {
  key: "bags",
  label: "Handbag & leather goods",
  factors: [
    { key: "corners_edges", label: "Corners & Edges", weight: 0.3, guidance: "Corner wear through to the substrate, edge-paint (glazing) cracking, chipping or loss along every seam and piping run." },
    { key: "exterior", label: "Exterior", weight: 0.2, guidance: "Body panels: scuffs, scratches, water marks, stains, ink transfer, colour transfer from denim." },
    { key: "handles_straps", label: "Handles & Straps", weight: 0.15, guidance: "Darkening and patina, cracking, stretch, stitching at the anchor points, strap-hole elongation." },
    { key: "hardware", label: "Hardware", weight: 0.15, guidance: "Plating loss and tarnish, zipper pull action, clasp and lock function, feet wear, missing pieces." },
    { key: "interior", label: "Interior", weight: 0.1, guidance: "Lining stains, pen marks, tears, pocket condition, residual odour." },
    { key: "structure", label: "Structure", weight: 0.1, guidance: "Shape retention, base sag, slouch, corner collapse, panel creasing." },
  ],
  promptGuidance:
    "Grade this bag's CONDITION only. Say nothing about whether it is authentic, and do not treat a brand marking, date code, serial or logo as evidence of condition either way — a separate system assesses authenticity and this grade must not imply it. Assess corners and edge paint first: they decide more of a bag's value than any panel. Honest patina on untreated leather is age, not damage; cracking, flaking and colour transfer are damage.",
  // Reconciled to the shared DefectType taxonomy, like every rubric here —
  // nothing invented. `pilling` and `snag_pull` are deliberately unrouted:
  // they are textile failures with no leather equivalent, and mapping them
  // anywhere would put a debit on a factor the defect cannot physically reach.
  // They fall through to the first factor via routeDefectToRubricFactors, which
  // is the documented behaviour rather than a gap.
  defectRouting: {
    abrasion_thinning: { corners_edges: 0.6, exterior: 0.4 },
    // Vachetta darkening and edge-paint colour loss — the two most common
    // findings on a used bag, and both read on handles and corners first.
    discoloration: { handles_straps: 0.5, corners_edges: 0.3, exterior: 0.2 },
    fading: { exterior: 0.6, handles_straps: 0.4 },
    stain: { exterior: 0.5, interior: 0.5 },
    rip_tear: { exterior: 0.5, interior: 0.5 },
    hole_puncture: { exterior: 0.6, corners_edges: 0.4 },
    seam_failure_unthreading: { structure: 0.5, handles_straps: 0.5 },
    // A dead zipper is the single most quoted repair on a bag.
    broken_zipper: { hardware: 1.0 },
    broken_button: { hardware: 1.0 },
    missing_hardware: { hardware: 1.0 },
    stretched_misshapen: { structure: 0.6, handles_straps: 0.4 },
    odor_indicator: { interior: 1.0 },
    wrinkle_crease: { structure: 0.6, exterior: 0.4 },
  },
};

// US-2224. Ties, belts, scarves and gloves. `belt` and `scarf` were already
// garment_category values with nowhere to route; neckwear was not representable
// at all. All four graded through CLOTHING, which spends 25% on structural
// integrity and 10% on odor — neither describes a tie that has lost its roll.
//
// ── ONE RUBRIC, NOT FOUR. THE DECISION AND WHY ──────────────────────────────
// The story asked for this to be decided and recorded rather than defaulted, so:
//
// They share a failure GEOMETRY. Each is a long or flat piece of essentially
// single-layer construction whose value dies at the edges and terminations —
// a tie's tipping and keeper, a belt's holes and cut end, a scarf's fringe and
// hem, a glove's fingertips and seams. That is one factor set, described four
// ways, and the differences are all statements about what to LOOK at, which is
// promptGuidance's job rather than a different weighting.
//
// The decisive argument is the golden set. Splitting into four rubrics means
// four golden sets, each a handful of items, and a golden set that small cannot
// gate anything — AC5 requires these prompts to clear an eval gate, so four
// unusable gates is strictly worse than one usable one. Rubrics can be split
// later off real correction data; they cannot be merged back once certificates
// have rendered against different weights.
//
// THE HONEST WEAKNESS, stated rather than buried: `hardware_fastening` does not
// apply to a scarf, which has none. That is not new — a t-shirt has no
// functional elements either, and clothing has carried that 15% factor since
// the start — but it does mean a scarf's overall is computed over a factor the
// grader has to score on nothing. If the eval gate later shows scarves biased
// by it, THAT is the evidence to split on, and it will be real evidence rather
// than the taxonomy instinct being followed here.
const ACCESSORIES: Rubric = {
  key: "accessories",
  label: "Ties, belts, scarves & gloves",
  factors: [
    { key: "material_condition", label: "Material Condition", weight: 0.3, guidance: "The face material: stains (effectively permanent on silk), cracking, pilling, pulls, thinning, colour loss." },
    { key: "structure_shape", label: "Structure & Shape", weight: 0.25, guidance: "Whether it still sits right: a tie's roll and blade shape, a belt's straightness and lack of curl, a scarf's drape, a glove's finger shape. Interlining collapse counts here even when the face is perfect." },
    { key: "edges_terminations", label: "Edges & Terminations", weight: 0.2, guidance: "Where these items fail first: tie tipping and keeper loop, belt hole elongation and cut end, scarf fringe and hem, glove fingertips and seam ends." },
    { key: "hardware_fastening", label: "Hardware & Fastening", weight: 0.15, guidance: "Buckle, prong, snaps, clasps, zips. Score as unassessable rather than perfect when the item has none." },
    { key: "cleanliness", label: "Cleanliness", weight: 0.1, guidance: "Soiling, odour, water marks. On silk and suede these are usually permanent — say so rather than implying they clean out." },
  ],
  promptGuidance:
    "Grade this accessory's condition relative to its as-manufactured state. Judge it as the specific thing it is: a tie by its roll, blade shape, tipping and keeper; a belt by strap creasing, cracking, buckle and prong, and hole elongation; a scarf by fringe, pilling and pulls; a glove by fingertips, seams and lining. A tie that has lost its roll is damaged even with a perfect face. If the item has no hardware, say the factor is unassessable rather than scoring it as flawless.",
  // Reconciled to the shared DefectType taxonomy — nothing invented, same
  // discipline US-1997 applied after finding seven unreachable routings.
  defectRouting: {
    stain: { cleanliness: 0.6, material_condition: 0.4 },
    discoloration: { material_condition: 0.7, cleanliness: 0.3 },
    fading: { material_condition: 1.0 },
    pilling: { material_condition: 1.0 },
    snag_pull: { material_condition: 0.6, edges_terminations: 0.4 },
    abrasion_thinning: { material_condition: 0.5, edges_terminations: 0.5 },
    rip_tear: { edges_terminations: 0.6, material_condition: 0.4 },
    hole_puncture: { material_condition: 0.6, edges_terminations: 0.4 },
    // A belt's holes elongating IS seam-adjacent failure at a termination, and
    // a tie's tipping unthreading is the canonical example of this defect here.
    seam_failure_unthreading: { edges_terminations: 0.7, structure_shape: 0.3 },
    // The roll collapsing, a belt curling, a glove losing its finger shape.
    stretched_misshapen: { structure_shape: 1.0 },
    wrinkle_crease: { structure_shape: 0.6, material_condition: 0.4 },
    broken_button: { hardware_fastening: 1.0 },
    broken_zipper: { hardware_fastening: 1.0 },
    missing_hardware: { hardware_fastening: 1.0 },
    odor_indicator: { cleanliness: 1.0 },
  },
};

// US-2223. Caps and hats. `hat` is a garment_category and routed into CLOTHING,
// whose five factors reach none of the places a cap's condition actually lives.
//
// ── THE WEIGHTS SPLIT INTO TWO QUESTIONS ────────────────────────────────────
// brim + crown together are half the score because together they answer "is
// this still a hat" — a collapsed crown or a cracked brim insert is not
// recoverable and the cap is worth its logo and nothing else. sweatband and
// fabric answer "will someone wear it", which is the other half of a resale
// decision and not the same question.
//
// The story calls the sweatband "the first thing to fail and the first thing a
// buyer inspects", which argues for the top weight. It is 0.20, and the reason
// is worth stating: it is the most COMMON failure, not the most terminal one. A
// stained sweatband is close to permanent and will lose a sale, so it must
// carry real weight — but a cap with a perfect crown and brim and a grim
// sweatband is still a cap, while the reverse is not.
//
// ⚠ THE ENUM VALUE EXISTS NOW. Migration 00570 added 'headwear' to
// item_category and was applied to production on 2026-08-09, so the paragraph
// that used to stand here — "that enum value does not exist yet (US-2223 AC6)"
// — became false and nobody noticed for two weeks (US-2797).
//
// What kept this rubric unreachable was NOT the enum. It was four hand-written
// copies of the category list that never learned the value, the load-bearing
// one being ai-extract.ts, which interpolates its copy into the extraction
// prompt AND uses it as the model's JSON-schema enum. A hat was therefore
// classified 'accessories' because that was the only answer available.
//
// Left as a correction rather than deleted, because a reader who remembers the
// old comment needs to see that it changed. The non-clothing rubrics really are
// still inert until US-1997 Phase 2; this one is not.
const HEADWEAR: Rubric = {
  key: "headwear",
  label: "Hats & caps",
  factors: [
    { key: "crown_structure", label: "Crown & Structure", weight: 0.25, guidance: "Shape retention, panel creasing, crown collapse, buckram stiffness on a structured cap, dents on a felt hat." },
    { key: "brim", label: "Brim", weight: 0.25, guidance: "Brim shape and whether its curve or flatness is as-made, cracking or delamination of the insert, fraying and wear along the edge." },
    { key: "sweatband", label: "Sweatband", weight: 0.2, guidance: "The interior band: staining, salt lines, hardening, separation from the crown, odour. The first area to fail and the first a buyer turns the hat over to check." },
    { key: "fabric_graphics", label: "Fabric & Graphics", weight: 0.2, guidance: "Panel fabric condition, embroidery integrity and pulls, print cracking, fading, moth damage on wool." },
    { key: "hardware_closure", label: "Hardware & Closure", weight: 0.1, guidance: "Button, eyelets, snapback tab, strap and buckle, flexfit elastic. Score as unassessable rather than perfect when the style has none." },
  ],
  promptGuidance:
    "Grade this hat's condition relative to its as-manufactured state. Turn it over: the sweatband is where the wear is, and a front-and-back pair of photos cannot show it. A flat brim on a flat-brim cap and a curved brim on a curved-brim cap are both as-made — do not read the intended shape as damage. Factory distressing on a vintage-styled cap is design, not wear.",
  // Reconciled to the shared DefectType taxonomy — nothing invented.
  defectRouting: {
    // Salt lines and sweat staining on the band, and the front-panel marks the
    // story names. Split rather than routed wholly to the band: a stain on a
    // white front panel is the other place a cap dies.
    stain: { sweatband: 0.6, fabric_graphics: 0.4 },
    discoloration: { fabric_graphics: 0.6, sweatband: 0.4 },
    fading: { fabric_graphics: 1.0 },
    pilling: { fabric_graphics: 1.0 },
    snag_pull: { fabric_graphics: 1.0 },
    abrasion_thinning: { brim: 0.5, fabric_graphics: 0.5 },
    rip_tear: { fabric_graphics: 0.6, brim: 0.4 },
    hole_puncture: { fabric_graphics: 1.0 },
    // The band separating from the crown is the canonical seam failure here.
    seam_failure_unthreading: { sweatband: 0.5, crown_structure: 0.5 },
    // A collapsed crown, a brim that has lost its curve, a stretched band.
    stretched_misshapen: { crown_structure: 0.6, brim: 0.4 },
    wrinkle_crease: { crown_structure: 0.6, brim: 0.4 },
    broken_button: { hardware_closure: 1.0 },
    missing_hardware: { hardware_closure: 1.0 },
    odor_indicator: { sweatband: 1.0 },
  },
};

export const RUBRICS: Record<string, Rubric> = {
  clothing: CLOTHING,
  accessories: ACCESSORIES,
  headwear: HEADWEAR,
  sports_cards: SPORTS_CARDS,
  watches: WATCHES,
  shoes: SHOES,
  bags: HANDBAGS,
};

/** Item categories that have a dedicated non-clothing rubric ready to activate. */
export const NON_CLOTHING_RUBRIC_KEYS = [
  "sports_cards",
  "watches",
  "shoes",
  "bags",
  "accessories",
  "headwear",
] as const;

/**
 * Rubrics whose items collide with the authenticity add-on (US-2225 AC3).
 *
 * Not a style note — a liability one. Every authentication tell pack we hold is
 * for a bag brand, so on a handbag the condition grade and the authenticity
 * verdict render on the same certificate, and a number beside a luxury logo
 * reads as a verdict on the logo unless the page says it is not. Anything that
 * renders a grade for one of these must carry the separation; the rendered copy
 * is asserted, not just the prompt that asks for it.
 */
export const AUTHENTICITY_ADJACENT_RUBRIC_KEYS = ["bags"] as const;

/**
 * The fixed line that keeps a condition grade from reading as an authenticity
 * claim. A constant, never model-authored, for the same reason
 * AUTHENTICITY_LIMITATIONS is: the model must not be able to soften it.
 */
export const CONDITION_NOT_AUTHENTICITY_DISCLOSURE =
  "This is a condition grade only. It is not an opinion on whether this item is authentic.";

/** Resolves the rubric for an item_category / rubric_key; clothing is the default. */
export function rubricForKey(key: string | null | undefined): Rubric {
  if (!key) return CLOTHING;
  return RUBRICS[key] ?? CLOTHING;
}

/**
 * The factor split a defect type debits under a given rubric.
 *
 * The "unmapped defects fall back to the rubric's first factor" rule was
 * written into the `defectRouting` doc comment from the start and implemented
 * nowhere, so the fallback existed only as a claim. It lives here now, pinned
 * by rubric-parity_test.ts.
 *
 * Returns a plain `Record<string, number>` — undefined-valued entries are
 * dropped, so callers can iterate without re-checking. Never returns an empty
 * object for a rubric that has factors: an unroutable defect must still land
 * somewhere, or it silently costs the item nothing.
 */
export function routeDefectToRubricFactors(
  rubric: Rubric,
  defectType: string,
): Record<string, number> {
  const split = rubric.defectRouting[defectType as DefectType];
  if (split) {
    const out: Record<string, number> = {};
    for (const [factor, weight] of Object.entries(split)) {
      if (typeof weight === "number") out[factor] = weight;
    }
    if (Object.keys(out).length > 0) return out;
  }
  const first = rubric.factors[0];
  return first ? { [first.key]: 1.0 } : {};
}

// ---------------------------------------------------------------------------
// Rubric-driven weighted overall (US-1997, activation checklist step 2)
// ---------------------------------------------------------------------------
//
// The two live weighted-overall implementations — ai-grading.roundToTenth over
// FACTOR_WEIGHTS, and human-review.computeWeightedOverall — are both hard-typed
// to the five CLOTHING factors, in two different key spaces (AI response names
// vs. grade_reports column names). Neither can score a rubric with a different
// factor set, so nothing downstream of this registry could compute an overall
// for a card, a watch or a pair of shoes.
//
// This is the generalized form: same arithmetic, same 0.1 rounding, same
// refusal, but the factor set comes from the rubric instead of a hardcoded
// union. For CLOTHING it is byte-identical to both existing implementations —
// that is not an assertion of intent, it is asserted directly, by running the
// existing shared fixture (src/test/fixtures/weighted-grade-cases.json, the
// US-2034/US-2386 table the other two mirrors are already pinned by) through
// this function under the clothing rubric. See rubric-parity_test.ts.
//
// It is deliberately NOT wired into the pipeline yet: activating non-clothing
// grading needs new per-category composite prompts, and a new prompt reaches
// live traffic only through shadow-compare → golden-set eval gate → canary
// (see the grading-engine contract). The non-clothing golden set does not exist
// yet and cannot be fabricated — golden cases grow from real human-corrected
// grades. So this lands the scoring math, pinned, ahead of that gate.
//
// NO CLAMP, on purpose. ai-grading clamps the weighted sum to 1.0–10.0 before
// rounding; human-review does not. Under the invariant both rely on — every
// factor validated to 1.0–10.0, rubric weights summing to 1.0 — the clamp is a
// no-op, so the two agree today. Clamping HERE would not be a no-op if that
// invariant ever broke: it would quietly launder an out-of-range factor into a
// plausible grade, which is the same failure mode US-2386 removed when it
// replaced `?? 0` with a refusal. An impossible input should announce itself.

/**
 * A rubric's weights must sum to 1.0. Floating-point exact equality is the
 * wrong test for that, so callers and suites compare within this tolerance.
 */
export const RUBRIC_WEIGHT_SUM_TOLERANCE = 1e-9;

/** Sum of a rubric's factor weights. Should be 1.0 for every rubric. */
export function rubricWeightSum(rubric: Rubric): number {
  return rubric.factors.reduce((total, factor) => total + factor.weight, 0);
}

// Mirrors requireFactor in human-review.ts / src/lib/weighted-grade.ts — a
// missing or non-finite factor REFUSES rather than scoring itself as 0 or
// falling out as NaN. The message names the rubric as well as the factor,
// because with a variable factor set "corners is missing" is ambiguous about
// which rubric was expected. src/lib/rubrics.ts produces the SAME string.
function requireRubricFactor(
  rubric: Rubric,
  scores: Record<string, number>,
  key: string,
): number {
  const value = scores[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(
      `computeRubricWeightedOverall: factor "${key}" of rubric ` +
        `"${rubric.key}" is missing or not finite (got ${String(value)}). ` +
        `Refusing to compute a weighted overall from an incomplete factor set.`,
    );
  }
  return value;
}

/**
 * The weighted overall for ANY rubric, rounded to 0.1.
 *
 * `scores` is keyed by the rubric's own factor keys — the shape
 * grade_reports.factor_scores (00231) stores for a non-clothing report.
 */
export function computeRubricWeightedOverall(
  rubric: Rubric,
  scores: Record<string, number>,
): number {
  let total = 0;
  for (const factor of rubric.factors) {
    total += requireRubricFactor(rubric, scores, factor.key) * factor.weight;
  }
  return Math.round(total * 10) / 10;
}
