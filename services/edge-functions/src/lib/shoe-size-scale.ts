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
