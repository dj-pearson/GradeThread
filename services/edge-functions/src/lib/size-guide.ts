// US-3283: shape a brand size chart into something a seller can read.
//
// WHY THIS EXISTS ALONGSIDE size-check.ts. That module answers one question —
// "does this item's size label agree with what it measures?" — and to answer it
// it throws away everything it cannot turn into a number: a footwear chart's
// US/UK/EU columns, a bag's dimensions, a watch's case diameter, the row note
// that says the run skips 35 and 37. Every one of those is exactly what a
// seller wants to SEE.
//
// So the band table and the guide table are two different projections of the
// same chart, and neither is a superset of the other:
//
//   buildSizeBands  → numbers only, converted to expected FLAT measurements
//   buildSizeGuide  → every column, verbatim, in the chart's own words
//
// Verbatim is the rule here. A chart cell that reads "US 8 / UK 12" is printed
// as "US 8 / UK 12". The moment this module starts normalising cells it starts
// making claims the brand did not make, and a size guide that quietly rewrites
// the brand's own numbers is worse than no size guide.
//
// Pure: no network, no env, no model.

import type { SizingChart } from "./sizing-charts.ts";
import { bandKeyFor, type SizeBandKey, type SizeChartTier } from "./size-check.ts";
import type { MeasurementBasis } from "./size-check.ts";

/**
 * Keys that are prose about the row rather than a measurement of it. They
 * become a footnote under the row instead of a column, because a column of
 * sentences makes every other column unreadable.
 */
const FOOTNOTE_KEYS = new Set(["note", "warning", "caveat"]);

/**
 * Keys that describe the product rather than its size. They are real
 * information and worth showing, but they belong after the measurements, not
 * between the chest and the waist.
 */
const TRAILING_KEYS = new Set([
  "material",
  "hardware",
  "crystal",
  "battery",
  "water_resistance",
  "capacity",
  "confidence",
]);

/**
 * Display names for the keys the corpus actually uses. Anything absent falls
 * through to `humanize`, which is good enough for a key like `strap_drop_in`
 * and deliberately never invents a unit the key name does not carry.
 */
const COLUMN_LABELS: Record<string, string> = {
  chest: "Chest",
  bust: "Bust",
  underbust: "Underbust",
  waist: "Waist",
  hip: "Hip",
  hips: "Hip",
  seat: "Seat",
  inseam: "Inseam",
  sleeve: "Sleeve",
  neck: "Neck",
  length: "Length",
  height: "Height",
  weight: "Weight",
  numeric: "US numeric",
  denim: "Denim waist",
  footLength: "Foot length",
  us: "US",
  uk: "UK",
  eu: "EU",
  jp: "JP",
  fr: "FR",
  it: "IT",
  uk_fr_it: "UK / FR / IT",
  usAge: "US age",
  age: "Age",
  capacity: "Capacity",
  material: "Material",
  hardware: "Hardware",
  crystal: "Crystal",
  battery: "Battery",
  confidence: "Confidence",
};

/** `strap_drop_in` → "Strap drop (in)"; `caseMm` → "Case mm". */
function humanize(key: string): string {
  let k = key.trim();
  let suffix = "";
  const unit = k.match(/_(in|cm|mm)$/i);
  if (unit) {
    suffix = ` (${unit[1]!.toLowerCase()})`;
    k = k.slice(0, -unit[0].length);
  }
  const words = k
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim()
    .toLowerCase();
  if (!words) return key + suffix;
  return words.charAt(0).toUpperCase() + words.slice(1) + suffix;
}

export interface SizeGuideColumn {
  /** The chart's own key, used to look a cell up in a row. */
  key: string;
  label: string;
  /**
   * Set when this column is a measurement the item's own numbers can be
   * compared against, so the panel can mark where the item lands. null on a
   * column like `us` or `dimensions_in`, which are not measurements of the
   * wearer at all.
   */
  bandKey: SizeBandKey | null;
}

export interface SizeGuideRow {
  size: string;
  /** Position in the run. Matches the band table's `index` for the same chart. */
  index: number;
  /** Column key → the chart's printed value, verbatim. Missing keys are absent. */
  values: Record<string, string>;
  /** Row-level prose (`note` / `warning`), joined. */
  footnote: string | null;
}

export interface SizeGuideChart {
  brand: string;
  department: string;
  /** The chart's own garment scope, which is where the units are usually said. */
  garment: string;
  note: string | null;
  sizeSystem: string | null;
  sizeClass: string | null;
  measurementBasis: MeasurementBasis;
  sourceUrl: string | null;
  tier: SizeChartTier;
  columns: SizeGuideColumn[];
  rows: SizeGuideRow[];
}

function cell(raw: unknown): string | null {
  if (typeof raw === "number") return String(raw);
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  return text ? text : null;
}

/**
 * Column order: measurement columns first in the order the chart itself
 * introduces them, then the descriptive ones. First-appearance order matters —
 * a chart's author put chest before waist for a reason, and re-sorting
 * alphabetically would put `bust` ahead of `band` on a bra chart.
 */
function columnsFor(chart: Pick<SizingChart, "rows">): SizeGuideColumn[] {
  const seen: string[] = [];
  for (const row of chart.rows ?? []) {
    for (const key of Object.keys(row.measurements ?? {})) {
      if (FOOTNOTE_KEYS.has(key.trim().toLowerCase())) continue;
      if (cell((row.measurements as Record<string, unknown>)[key]) === null) continue;
      if (!seen.includes(key)) seen.push(key);
    }
  }
  const lead = seen.filter((k) => !TRAILING_KEYS.has(k.trim().toLowerCase()));
  const trail = seen.filter((k) => TRAILING_KEYS.has(k.trim().toLowerCase()));
  return [...lead, ...trail].map((key) => ({
    key,
    label: COLUMN_LABELS[key] ?? humanize(key),
    bandKey: bandKeyFor(key),
  }));
}

function rowsFor(chart: Pick<SizingChart, "rows">): SizeGuideRow[] {
  return (chart.rows ?? []).map((row, index) => {
    const values: Record<string, string> = {};
    const notes: string[] = [];
    for (const [key, raw] of Object.entries(row.measurements ?? {})) {
      const text = cell(raw);
      if (text === null) continue;
      if (FOOTNOTE_KEYS.has(key.trim().toLowerCase())) {
        notes.push(text);
        continue;
      }
      values[key] = text;
    }
    return {
      size: row.size,
      index,
      values,
      footnote: notes.length > 0 ? notes.join(" ") : null,
    };
  });
}

/**
 * The readable projection of one chart. Returns null for a chart with no
 * printable row, which is the same "say nothing" answer the band table gives —
 * an empty grid with a brand name over it reads as a broken feature.
 */
export function buildSizeGuide(
  chart: SizingChart,
  tier: SizeChartTier,
): SizeGuideChart | null {
  const columns = columnsFor(chart);
  const rows = rowsFor(chart);
  if (columns.length === 0 || rows.length === 0) return null;
  return {
    brand: chart.brand,
    department: chart.department,
    garment: chart.garment,
    note: chart.note ?? null,
    sizeSystem: chart.sizeSystem ?? null,
    sizeClass: chart.sizeClass ?? null,
    measurementBasis: chart.measurementBasis === "flat" ? "flat" : "body",
    sourceUrl: chart.sourceUrl ?? null,
    tier,
    columns,
    rows,
  };
}
