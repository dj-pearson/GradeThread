// US-2801: the design features a seller may declare, and the picker that was
// always assumed to exist.
//
// routes/grade.ts has filtered `style_attributes` against a 14-value allowlist
// since it was written, and its comment used to claim the list mirrored "a
// constant of the same name in the web constants module". There was no such
// constant and there never had been — which is what someone writes when they
// expect a picker to be on the other end. So the parser has only ever filtered
// an empty list, and distressed denim, raw hems and acid wash were graded as
// wear because the seller had no way to say they were design.
//
// This file is that missing constant. src/test/style-attributes.test.ts holds it
// to the edge allowlist character for character, so the two cannot drift.
//
// ⚠ NOT grade_reports.detected_style_attributes, which is the MODEL's own
// reading and has been live all along (the certificate renders it). This is the
// SELLER's declaration — the half nothing sent.

/**
 * The exact values routes/grade.ts accepts. Anything else is silently dropped
 * server-side, so a value that is not here is a value that does not exist.
 *
 * Order matches the edge list, which is also roughly how common they are.
 */
export const STYLE_ATTRIBUTES = [
  "distressed",
  "ripped",
  "raw-hem",
  "acid-wash",
  "bleached",
  "tie-dye",
  "cropped",
  "frayed",
  "patchwork",
  "painted",
  "vintage-wash",
  "garment-dyed",
  "deconstructed",
  "pre-pilled",
] as const;

export type StyleAttribute = (typeof STYLE_ATTRIBUTES)[number];

/**
 * What to put on the control. The wire values are kebab-case tokens the grader
 * reads; a seller should see the words they would use.
 *
 * Deliberately a full map rather than a de-kebab helper: "raw-hem" prettifies
 * to "Raw hem" but "pre-pilled" would become "Pre pilled", and a seller
 * scanning for the thing on their garment should not have to decode it.
 */
export const STYLE_ATTRIBUTE_LABELS: Record<StyleAttribute, string> = {
  distressed: "Distressed",
  ripped: "Ripped",
  "raw-hem": "Raw hem",
  "acid-wash": "Acid wash",
  bleached: "Bleached",
  "tie-dye": "Tie-dye",
  cropped: "Cropped",
  frayed: "Frayed",
  patchwork: "Patchwork",
  painted: "Painted",
  "vintage-wash": "Vintage wash",
  "garment-dyed": "Garment-dyed",
  deconstructed: "Deconstructed",
  "pre-pilled": "Pre-pilled",
};

/** The multipart field name. grade.ts reads it with getAll. */
export const STYLE_ATTRIBUTES_FIELD = "style_attributes";

/**
 * Keep only values the server would accept, de-duplicated, in list order.
 *
 * Used on the retake path, where the values come from a PRIOR submission and so
 * are not necessarily still on the allowlist — a token retired between the two
 * submissions would otherwise be re-sent and silently dropped, which looks to
 * the seller like the declaration was carried when it was not.
 */
export function sanitizeStyleAttributes(
  values: readonly string[] | null | undefined,
): StyleAttribute[] {
  if (!values || values.length === 0) return [];
  const wanted = new Set(values.map((v) => v.trim().toLowerCase()));
  return STYLE_ATTRIBUTES.filter((a) => wanted.has(a));
}
