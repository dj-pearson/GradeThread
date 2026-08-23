// US-2796: which scale is a shoe's stamped number on?
//
// `parcel-estimate.ts` grew a `sizeScale` input and a `shoeSizeToUsMen()`
// converter, and nothing set it. This module is the producer: it reads the
// answer out of the curated brand charts instead of asking the seller a
// question they would get wrong.
//
// WHY THE BRAND ALONE IS NOT ENOUGH, which is the whole shape of this file.
// 26 brands have a footwear chart; 22 of them are written in US sizes and carry
// BOTH a Men's and a Women's chart (New Balance, UGG, PUMA, Reebok, ASICS,
// HOKA, Merrell, KEEN, Brooks, Saucony, Salomon and more). For those, "which
// scale" is answered by the ITEM's department, not by the brand. A women's 9
// and a men's 9 are about 1.5 sizes apart, so reading one as the other is
// exactly the error this exists to stop.
//
// Three brands are answered by the brand alone, and they are the interesting
// ones. Their scope lines say so in words: Dr. Martens is "Footwear (UK-SIZED
// - the stamped number is a UK size)", Birkenstock "Footwear (EU-SIZED ONLY -
// no US run exists)". `detectSizeSystem` reads that off the row labels, which
// announce their own system ("UK 3 = US M4 / US W5 = EU 36").
//
// One brand is refused outright and should be: Crocs stamps "M4 / W6" on the
// same shoe. There is no single scale to return, and the chart's own scope line
// calls it "dual US M/W". Refusing is the correct answer, not a gap.
//
// ⚠ THE GENERIC CONVERSION TABLE AND DR. MARTENS' OWN CHART DISAGREE BY EXACTLY
// HALF A SIZE, on all ten rows. `SHOE_SIZES` (mirrored into parcel-estimate as
// anchors) holds usMen = uk + 0.5; the Dr. Martens chart runs UK 3 = US M4
// through UK 12 = US M13, i.e. usMen = uk + 1. Verified row by row, not
// assumed. Returning "uk" therefore lands half a size low instead of a whole
// size low, which is a real improvement on reading UK 3 as US men's 3 and is
// still not exact. Recorded rather than papered over: the exact answer IS
// available, because the chart rows state the US equivalent per row, but taking
// it means returning a NUMBER instead of a SCALE, and that is a different
// contract from the one AC2 already shipped and pinned with tests.
//
// EVERY UNCERTAIN CASE RETURNS NULL, and null means "behave exactly as today".
// `shoeSizeToUsMen` treats an absent scale as US men's, which is the assumption
// every existing row was recorded under. Refusing is always safe here; guessing
// is not.

import { findSizingCharts, type SizingChart } from "./sizing-charts.ts";
import { detectSizeSystem, normalizeDepartment } from "./size-systems.ts";
import { resolveDepartment } from "./aspect-registry.ts";
import type { ShoeSizeScale } from "./parcel-estimate.ts";

/**
 * Words that mark a chart as footwear, matched against its garment scope and
 * its category keywords.
 *
 * Matched on the CHART, never on the item: an item titled "kitten heel dress"
 * is a dress, and the charts this runs over are already narrowed to one brand,
 * so a false positive would have to be a footwear word inside that same brand's
 * apparel chart.
 */
const FOOTWEAR = /shoe|boot|sneaker|footwear|sandal|heel|loafer|clog/i;

function isFootwearChart(c: SizingChart): boolean {
  return FOOTWEAR.test(c.garment) || c.categoryMatch.some((m) => FOOTWEAR.test(m));
}

/**
 * The scale a brand's stamped shoe number is on, or null when nothing curated
 * says.
 *
 * `department` is the ITEM's, not the chart's - pass what `inferDepartment()`
 * returns, or a column if you have one. "Unisex Adult", "Boys" and null all
 * read as unknown, because no offset exists for them that is not invented.
 */
export function resolveShoeSizeScale(
  brand: string | null | undefined,
  department: string | null | undefined,
): ShoeSizeScale | null {
  // NO EMPTY-BRAND GUARD, on purpose. An `if (!brand) return null` looked
  // right and changed nothing: findSizingCharts normalises a null, undefined,
  // "" or "   " brand to no brand-specific match, the filter below empties the
  // pool, and the function already returns null. Sabotage caught it standing
  // there looking load-bearing, which is the shape worth not shipping.
  //
  // findSizingCharts also falls back to the GENERIC charts when a brand has none of
  // its own, and a generic chart says nothing about this brand's stamping. Drop
  // that fallback by requiring a brand-specific chart.
  const brandCharts = findSizingCharts(brand, null).filter((c) => c.brandMatch.length > 0);
  const foot = brandCharts.filter(isFootwearChart);
  if (foot.length === 0) return null;

  // A brand whose footwear charts disagree about the system is not one system.
  // Reducing it to one would assert something false about half its rows - the
  // same refusal detectSizeSystem already makes within a single chart.
  const systems = new Set(foot.map((c) => detectSizeSystem(c)));
  if (systems.size !== 1) return null;
  const system = [...systems][0];

  // A non-US stamping is answered by the brand and the department cannot change
  // it: Dr. Martens stamps UK on the women's last too.
  if (system === "UK") return "uk";
  if (system === "EU") return "eu";
  if (system === "JP") return "jp";

  // "alpha" and null are not scales. Neither is IT/FR/AU, which no footwear
  // chart uses today and which SHOE_SIZES has no column for.
  if (system !== "US") return null;

  const dep = normalizeDepartment(department);
  if (dep === "Women") return "us_women";
  if (dep === "Men") return "us_men";
  return null;
}

/**
 * The attribute key a seller's stated scale is stored under.
 *
 * `inventory_items.attributes` and NOT the shoes measurement template, which is
 * what US-2796 AC1 originally asked for. That was measured and it destroys data:
 * a scale is a string and both phones store measurements as a NUMERIC map.
 * Android's MeasurementCatalog.decode keeps a key only when doubleOrNull is
 * non-null, so a round trip through the phone DELETES the scale. iOS is worse -
 * decodeMeasurements is `try? JSONDecoder().decode([String: Double].self ...)`,
 * so ONE string makes the whole decode throw and every other measurement on the
 * item vanishes from the canvas. Owner's decision 2026-08-23: store it beside
 * department, where no measurement decoder ever touches it.
 */
export const SHOE_SIZE_SCALE_ATTRIBUTE = "shoe_size_scale";

/** The five scales, as stored. Exported so a writer cannot invent a sixth. */
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
 * STRICT, AND AN UNRECOGNISED VALUE READS AS ABSENT rather than as an error.
 * That is AC4's promise: a shoe with no scale must behave exactly as it does
 * today. Throwing, or guessing at "mens" or "US Women", would both break it -
 * one by failing an estimate that used to work, the other by inventing a
 * meaning the seller did not choose. Normalisation is limited to case, spaces
 * and hyphens, which are typing variants of the same token rather than
 * different answers.
 */
export function statedShoeSizeScale(
  attributes: Record<string, string | string[]> | null | undefined,
): ShoeSizeScale | null {
  const raw = attributes?.[SHOE_SIZE_SCALE_ATTRIBUTE];
  const first = Array.isArray(raw) ? raw[0] : raw;
  if (typeof first !== "string") return null;
  // [\s-] — WHITESPACE and hyphen. This shipped for a few minutes as [s-],
  // which matches the LETTER s, so "us_women" normalised to "u__women" and
  // every scale but "uk" and "eu" silently stopped parsing. The tests caught it;
  // the cause was writing source through a shell heredoc, which eats one
  // backslash level. Source files go through the editor, not a heredoc.
  const token = first.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (SHOE_SIZE_SCALES as readonly string[]).includes(token)
    ? (token as ShoeSizeScale)
    : null;
}

/**
 * What scale this item's shoe number is on: what it SAYS, else what its brand
 * chart implies.
 *
 * Same precedence as `resolveDepartment`, and for the same reason. The seller
 * is holding the shoe; the brand chart is a generalisation about a catalogue.
 * A curated chart cannot know that this particular pair is a women's colourway
 * of a unisex last, and 22 of the 26 charted footwear brands publish BOTH a
 * men's and a women's chart - so the inference leans on department, which is
 * itself often inferred from a title. Two inferences deep is not something to
 * prefer over an answer.
 *
 * Null when neither says, which sizeFactor already reads as US men's.
 */
export function resolveShoeSizeScaleForItem(item: {
  brand?: string | null;
  attributes?: Record<string, string | string[]> | null;
  item_category: string | null;
  size?: string | null;
  style?: string | null;
  title?: string | null;
  description?: string | null;
  condition_notes?: string | null;
}): ShoeSizeScale | null {
  const stated = statedShoeSizeScale(item.attributes);
  if (stated) return stated;
  return resolveShoeSizeScale(item.brand, resolveDepartment(item));
}
