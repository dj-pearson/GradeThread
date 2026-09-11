// US-3332: size a flaw from a standard object laid beside it.
//
// Flaw size decides severity (size_bucket drives the defect weighting), and
// the model otherwise guesses scale from garment proportions. Three objects a
// seller already has, with sizes that do not vary:
//
//   US quarter        24.26 mm across (US Mint specification)
//   bank / ID card    85.60 x 53.98 mm (ISO/IEC 7810 ID-1)
//   MeasureCard       190.5 x 139.7 mm (7.5 x 5.5 in trim,
//                     vault/20-domain/measurement-card-spec.md)
//
// The web slots ask for one (src/lib/scale-reference.ts mirrors these numbers;
// scale-reference_test.ts pins both copies). The model is told how to use it
// behind GRADING_SCALE_REFERENCE, default OFF: off is byte-identical, on
// appends "+scale" to the per-image prompt version. Per-image only, because it
// is the stage that sees the pixels.
//
// Pure: no supabase.

export const US_QUARTER_MM = 24.26;
export const ID1_CARD_MM = { long: 85.6, short: 53.98 } as const;
export const MEASURE_CARD_MM = { long: 190.5, short: 139.7 } as const;

export function scaleReferenceEnabled(): boolean {
  const v = (Deno.env.get("GRADING_SCALE_REFERENCE") ?? "").trim().toLowerCase();
  return v === "1" || v === "true";
}

/** The exact phrase in DEFECT_TAXONOMY_AND_SIZING this extends. */
export const SCALE_V1_PHRASE =
  "Judge scale from garment proportions, any tape-measure reference in the photo, and the defect's size relative to the whole garment;";

export const SCALE_V2_PHRASE =
  `Judge scale from garment proportions, any tape-measure reference in the photo, any standard object laid beside the flaw (a US quarter is ${US_QUARTER_MM} mm across; a bank or ID card is ${ID1_CARD_MM.long} x ${ID1_CARD_MM.short} mm; a GradeThread MeasureCard is ${MEASURE_CARD_MM.long} x ${MEASURE_CARD_MM.short} mm), and the defect's size relative to the whole garment. When such an object is in frame, measure the flaw against it rather than estimating, and never record the object itself as a flaw;`;

/**
 * Apply the v2 wording. `applied` is true only when the text changed, so a
 * prompt without the v1 phrase is not mislabelled as the "+scale" era.
 */
export function applyScaleReferenceWording(
  text: string,
  enabled: boolean = scaleReferenceEnabled(),
): { text: string; applied: boolean } {
  if (!enabled) return { text, applied: false };
  const out = text.split(SCALE_V1_PHRASE).join(SCALE_V2_PHRASE);
  return { text: out, applied: out !== text };
}
