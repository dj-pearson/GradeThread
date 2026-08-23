// US-2796, the web's half: which scale a shoe's stamped size number is on.
//
// ⚠ THIS IS THE STATED HALF ONLY, AND THAT IS DELIBERATE. The edge module of the
// same name has two sources — a value the seller or the capture pass recorded on
// `inventory_items.attributes`, and a fallback inferred from the brand's curated
// sizing chart. The chart half is NOT mirrored here: `sizing-charts.ts` and
// `size-systems.ts` are edge-only, and copying 26 brands' footwear charts into
// the bundle to answer one question would create a second definition of a large
// table that nothing compares. Two copies of a number is how this repo ended up
// with two contradictory key-rotation procedures.
//
// WHY THE WEB NEEDS ANY OF IT. `resolveMeasurementAspects` on the EDGE only fills
// aspects that are still blank, so anything the web composer prefills arrives at
// publish as an existing value and is never corrected. A UK 9 that the web put
// into "US Shoe Size" therefore survives to the live listing, even though the
// edge's own publish path would have refused it.
//
// THE RESIDUAL GAP, stated rather than left to be discovered: an item whose scale
// is only INFERABLE from its brand chart (a Dr. Martens with nothing recorded)
// still gets its number into "US Shoe Size" here. That is unchanged from before
// this file existed — no regression, and no fix without the charts. It shrinks
// on its own as the capture pass records the scale off the size stamp.

/** The scale a stored shoe size number is on. Mirrors the edge type. */
export type ShoeSizeScale = "us_men" | "us_women" | "uk" | "eu" | "jp";

/** The attribute key a seller's stated scale is stored under. */
export const SHOE_SIZE_SCALE_ATTRIBUTE = "shoe_size_scale";

/** The five scales, as stored. Mirrors the edge list; a parity test pins them. */
export const SHOE_SIZE_SCALES: readonly ShoeSizeScale[] = [
  "us_men",
  "us_women",
  "uk",
  "eu",
  "jp",
];

/**
 * A stated scale, or null when nothing usable is stored.
 *
 * STRICT, AND AN UNRECOGNISED VALUE READS AS ABSENT rather than as an error —
 * the same contract as the edge. Absent means "behave exactly as before", which
 * is what keeps this change invisible to every item that has no scale recorded.
 * Normalisation covers case, spaces and hyphens: typing variants of one token,
 * not different answers.
 */
export function statedShoeSizeScale(
  attributes: Record<string, string | string[]> | null | undefined,
): ShoeSizeScale | null {
  const raw = attributes?.[SHOE_SIZE_SCALE_ATTRIBUTE];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return null;
  const token = first.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (SHOE_SIZE_SCALES as readonly string[]).includes(token)
    ? (token as ShoeSizeScale)
    : null;
}
