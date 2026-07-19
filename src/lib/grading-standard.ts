// US-2107: the PUBLISHED grading standard — the measurable half.
//
// PSA is citable because its standard is measurable ("55/45 front, 75/25
// reverse"). Ours read as a good rubric but not a spec: "noticeable pilling,
// light fading".
//
// The important finding behind this file is that we were NOT missing the
// measurable data — we were failing to publish it. The engine has carried
// physical size buckets in millimetres and a defect→factor routing table since
// US-1028; they simply never reached a public page. So nothing here is invented
// for marketing. Every value below is mirrored from
// services/edge-functions/src/lib/defect-weighting.ts and guarded by
// `src/test/grading-standard-parity.test.ts`, which fails if the engine moves
// and this file does not.
//
// ⚠️ DELIBERATE OMISSION — read before "completing" this file.
// The engine also has BASE_WEIGHT: the exact score-points penalty for each
// defect type (a broken zipper is 5.0 off a 10, a wrinkle 0.4). Those are NOT
// published here. Publishing which factor a flaw affects makes the standard
// auditable; publishing the exact penalty makes it gameable — a seller who
// knows the arithmetic can photograph to minimise it, and the grade stops
// measuring the garment. Whether that trade is worth making is a product call
// (US-2107 AC3/AC5), not one to settle by adding a column here.

/** The five factors and their weight in the overall score. */
export const PUBLISHED_FACTOR_WEIGHTS = [
  { key: "fabric_condition", label: "Fabric condition", weight: 0.3 },
  { key: "structural_integrity", label: "Structural integrity", weight: 0.25 },
  { key: "cosmetic_appearance", label: "Cosmetic appearance", weight: 0.2 },
  { key: "functional_elements", label: "Functional elements", weight: 0.15 },
  { key: "odor_cleanliness", label: "Odor & cleanliness", weight: 0.1 },
] as const;

/**
 * Physical size buckets, in millimetres. This is the measurable tolerance the
 * standard was missing publicly — a "small" hole is not a matter of opinion,
 * it is 3–13mm.
 *
 * `unknown` deliberately sits at the LOW-impact end: absent size data must
 * never inflate a penalty. That conservatism is part of the published standard,
 * not an implementation detail.
 */
export const PUBLISHED_SIZE_BUCKETS = [
  { bucket: "pinhole", range: "under 3 mm", note: "Visible only on close inspection." },
  { bucket: "small", range: "3–13 mm", note: "Noticeable at arm's length." },
  { bucket: "medium", range: "13–50 mm", note: "Immediately visible in normal use." },
  { bucket: "large", range: "over 50 mm", note: "Dominates the area it sits in." },
  {
    bucket: "extensive",
    range: "dominates a panel",
    note: "Affects the garment as a whole rather than one spot.",
  },
  {
    bucket: "unknown",
    range: "not determinable from photos",
    note: "Scored at the low-impact end — missing data never increases a penalty.",
  },
] as const;

/**
 * Which factor(s) each defect type is charged against. Mirrors FACTOR_ROUTING.
 * `share` is the proportion of that defect's penalty routed to the factor;
 * shares per defect sum to 1.0.
 */
export const PUBLISHED_FLAW_ROUTING = [
  { flaw: "Stain", routes: [["Odor & cleanliness", 0.6], ["Cosmetic appearance", 0.4]] },
  { flaw: "Hole / puncture", routes: [["Fabric condition", 0.8], ["Cosmetic appearance", 0.2]] },
  { flaw: "Rip / tear", routes: [["Structural integrity", 0.6], ["Fabric condition", 0.4]] },
  { flaw: "Seam failure / unthreading", routes: [["Structural integrity", 1.0]] },
  { flaw: "Pilling", routes: [["Fabric condition", 0.7], ["Cosmetic appearance", 0.3]] },
  { flaw: "Abrasion / thinning", routes: [["Fabric condition", 0.8], ["Cosmetic appearance", 0.2]] },
  { flaw: "Fading", routes: [["Cosmetic appearance", 0.7], ["Fabric condition", 0.3]] },
  { flaw: "Discoloration", routes: [["Cosmetic appearance", 0.6], ["Odor & cleanliness", 0.4]] },
  { flaw: "Snag / pull", routes: [["Fabric condition", 0.6], ["Cosmetic appearance", 0.4]] },
  { flaw: "Broken zipper", routes: [["Functional elements", 1.0]] },
  { flaw: "Broken button", routes: [["Functional elements", 0.8], ["Cosmetic appearance", 0.2]] },
  { flaw: "Missing hardware", routes: [["Functional elements", 1.0]] },
  { flaw: "Stretched / misshapen", routes: [["Structural integrity", 0.6], ["Cosmetic appearance", 0.4]] },
  { flaw: "Odor", routes: [["Odor & cleanliness", 1.0]] },
  { flaw: "Wrinkle / crease", routes: [["Cosmetic appearance", 1.0]] },
] as const satisfies ReadonlyArray<{
  flaw: string;
  routes: ReadonlyArray<readonly [string, number]>;
}>;

/**
 * Severity multipliers applied on top of the base penalty. Published because
 * "minor / moderate / major" is otherwise pure adjective — this says what the
 * words are worth relative to each other WITHOUT disclosing the base penalties.
 */
export const PUBLISHED_SEVERITY_SCALE = [
  { severity: "Minor", relative: "0.5×" },
  { severity: "Moderate", relative: "1.0× (the reference point)" },
  { severity: "Major", relative: "1.8×" },
] as const;
