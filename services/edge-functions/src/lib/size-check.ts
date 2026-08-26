// US-2916: turn a brand size chart into the FLAT measurements a garment of each
// size is expected to show, then judge whether an item's own measurements agree
// with the size on its label.
//
// THE UNIT PROBLEM this module exists to solve. Every chart in the corpus holds
// BODY measurements — the wearer's chest, not the garment's. A seller measures
// the garment flat: pit to pit, one side only. Those two numbers are never
// comparable directly. A men's Large body chest of 41-43 in becomes a flat
// pit-to-pit of roughly 22 to 26.5 in once you add the ease a garment is cut
// with and halve the circumference. Comparing 22 against 41 would flag every
// correctly sized item on the platform.
//
//     flat = (bodyCircumference + ease) / 2
//
// The low edge of a band uses the group's SLIM ease and the high edge its
// RELAXED ease, so the band spans the whole range of cuts a brand sells under
// one size label. That width is deliberate: it is what keeps the check quiet on
// an oversized tee and loud on an XS wearing a Large tag.
//
// LENGTH keys (inseam) are not circumferences. They are compared directly, with
// no halving and no ease.
//
// The ease numbers are the ones src/lib/fit-model.ts already ships. Edge code
// cannot import from src/, so this module declares its own copy and
// src/test/size-check-ease-parity.test.ts fails if the two ever diverge.
//
// Pure: no network, no env, no model. Everything here is arithmetic and string
// matching, so it runs identically on the edge, in the browser, on iOS and on
// Android — which is the point, since all four hold a copy.

import type { SizingChart, SizingRow } from "./sizing-charts.ts";
import type { MeasurementGroup } from "./measurement-templates.ts";

/**
 * What the numbers in a chart MEAN. Almost every chart is `body` (the wearer),
 * which is why it is the default. `flat` exists for the brands that publish
 * garment specs instead — adding ease to those would be adding ease on top of
 * ease.
 */
export type MeasurementBasis = "body" | "flat";

/**
 * How much the chart behind a verdict is worth trusting. Drives the tolerance:
 * one size step is enough to speak up on a chart a human checked, two are
 * needed on a generic fallback.
 */
export type SizeChartTier = "verified" | "brand" | "generic" | "none";

/** The measurement keys a band can be built for. */
export type SizeBandKey = "chest" | "bust" | "waist" | "hip" | "inseam";

export const SIZE_BAND_KEYS: readonly SizeBandKey[] = [
  "chest",
  "bust",
  "waist",
  "hip",
  "inseam",
];

/** Expected flat range in inches, inclusive on both ends. */
export type SizeBand = [number, number];

export interface SizeBandRow {
  /** The brand's own label for this size, verbatim from the chart. */
  size: string;
  /** Position in the chart, smallest first. */
  index: number;
  bands: Partial<Record<SizeBandKey, SizeBand>>;
}

export type SizeCheckStatus = "ok" | "off" | "unknown";

export interface SizeCheckVerdict {
  status: SizeCheckStatus;
  /** The size the measurements point at, or an edge phrase like "smaller than XS". */
  impliedSize: string | null;
  /** Size steps between the label and the implied size. 0 when they agree. */
  stepsOff: number;
  /** The measurement driving the verdict. */
  key: SizeBandKey | null;
  /** The labelled size's own band for that key. */
  expected: SizeBand | null;
}

// ── Ease ────────────────────────────────────────────────────────────────────
//
// MIRRORS src/lib/fit-model.ts. `slim` is that file's slim band and `relaxed`
// its relaxed band, per garment group. Changing a number here without changing
// it there fails src/test/size-check-ease-parity.test.ts.

interface Ease {
  slim: number;
  relaxed: number;
}

const TOP_CHEST_EASE: Ease = { slim: 3, relaxed: 10 };
const OUTER_CHEST_EASE: Ease = { slim: 6, relaxed: 16 };
const DRESS_CHEST_EASE: Ease = { slim: 3, relaxed: 10 };
const WAIST_EASE: Ease = { slim: 1, relaxed: 5 };
const HIP_EASE: Ease = { slim: 2, relaxed: 8 };

type EaseTable = Partial<Record<SizeBandKey, Ease>>;

const GROUP_EASE: Record<MeasurementGroup, EaseTable> = {
  top: { chest: TOP_CHEST_EASE, bust: TOP_CHEST_EASE, waist: WAIST_EASE, hip: HIP_EASE },
  outerwear: {
    chest: OUTER_CHEST_EASE,
    bust: OUTER_CHEST_EASE,
    waist: WAIST_EASE,
    hip: HIP_EASE,
  },
  dress: { chest: DRESS_CHEST_EASE, bust: DRESS_CHEST_EASE, waist: WAIST_EASE, hip: HIP_EASE },
  // inseam needs no entry: length keys never take ease.
  bottom: { waist: WAIST_EASE, hip: HIP_EASE },
  // US-2464: a suit is measured as a top and a bottom at once, so it takes the
  // outerwear chest (it is worn over a shirt) and the bottom's waist and hip.
  suit: {
    chest: OUTER_CHEST_EASE,
    bust: OUTER_CHEST_EASE,
    waist: WAIST_EASE,
    hip: HIP_EASE,
  },
  // Groups with no body dimension to size against. An empty table means every
  // band is skipped, which is the honest answer: a watch has no chest.
  shoes: {},
  watch: {},
  bag: {},
  accessory: {},
  headwear: {},
  generic: {},
};

/** Length keys compare directly: no halving, no ease. */
const LENGTH_KEYS: readonly SizeBandKey[] = ["inseam"];

function isLengthKey(key: SizeBandKey): boolean {
  return LENGTH_KEYS.includes(key);
}

// ── Parsing chart values ────────────────────────────────────────────────────

/**
 * Read a chart cell as a numeric range. The corpus writes both shapes: a range
 * ("34-36") and a singleton ("31"). Anything non-numeric returns null and is
 * SKIPPED — never coerced to zero, which would put a phantom band at the bottom
 * of the chart and make every real measurement look oversized.
 */
export function parseChartValue(raw: string | undefined | null): [number, number] | null {
  if (typeof raw !== "string") return null;
  const text = raw.trim();
  if (!text) return null;
  const m = text.match(/^(\d+(?:\.\d+)?)\s*(?:[-–—to]+\s*(\d+(?:\.\d+)?))?$/i);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo <= 0 || hi <= 0) return null;
  return lo <= hi ? [lo, hi] : [hi, lo];
}

/**
 * The chart keys that are measurements. Sweaty Betty's rows carry a `us` key
 * whose value is a US SIZE NUMBER, not inches — reading it as a measurement
 * would build a band around "8 inches" and flag every item on the brand.
 * Allow-listing the real keys is the only safe direction: an unknown key is
 * ignored rather than guessed at.
 */
function bandKeyFor(chartKey: string): SizeBandKey | null {
  const k = chartKey.trim().toLowerCase();
  if (k === "chest") return "chest";
  if (k === "bust") return "bust";
  if (k === "waist") return "waist";
  if (k === "hip" || k === "hips") return "hip";
  if (k === "inseam") return "inseam";
  return null;
}

// ── Band building ───────────────────────────────────────────────────────────

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function bandFor(
  key: SizeBandKey,
  value: [number, number],
  ease: Ease | undefined,
  basis: MeasurementBasis,
): SizeBand | null {
  if (isLengthKey(key)) return [round1(value[0]), round1(value[1])];
  // A chart that already publishes flat garment specs needs no conversion at
  // all: the number IS the expected flat measurement.
  if (basis === "flat") return [round1(value[0]), round1(value[1])];
  if (!ease) return null;
  return [round1((value[0] + ease.slim) / 2), round1((value[1] + ease.relaxed) / 2)];
}

/**
 * Convert a size chart into the flat measurements each size is expected to
 * show. Rows keep the chart's own order (smallest first) and its own labels.
 * A row that yields no usable band is still returned, with `bands: {}` — its
 * position in the sequence is what makes "two sizes off" mean anything.
 */
export function buildSizeBands(
  chart: Pick<SizingChart, "rows">,
  garmentGroup: MeasurementGroup,
  basis: MeasurementBasis = "body",
): SizeBandRow[] {
  const easeTable = GROUP_EASE[garmentGroup] ?? {};
  return chart.rows.map((row: SizingRow, index: number) => {
    const bands: Partial<Record<SizeBandKey, SizeBand>> = {};
    for (const [chartKey, raw] of Object.entries(row.measurements ?? {})) {
      const key = bandKeyFor(chartKey);
      if (!key) continue;
      const value = parseChartValue(raw);
      if (!value) continue;
      const band = bandFor(key, value, easeTable[key], basis);
      if (band) bands[key] = band;
    }
    return { size: row.size, index, bands };
  });
}

// ── Matching a size label to a row ──────────────────────────────────────────

const ALPHA_WORDS: Array<[RegExp, string]> = [
  [/\bextra\s*extra\s*extra\b/g, "xxx"],
  [/\bextra\s*extra\b/g, "xx"],
  [/\bextra\b/g, "x"],
  [/\bdouble\b/g, "xx"],
  [/\btriple\b/g, "xxx"],
  [/\bsmall\b/g, "s"],
  [/\bmedium\b/g, "m"],
  [/\bmed\b/g, "m"],
  [/\blarge\b/g, "l"],
];

const SYSTEM_PREFIX = /^(uk|eu|it|fr|jp|au|us|de)\s*/;

/**
 * Every spelling one label part can be written as. Alpha sizes collapse to the
 * x*[sml] form ("Large", "L", "lge" → "l"; "2XL", "XXL", "extra extra large" →
 * "xxl"). Numeric sizes keep any system prefix ("UK 12" → "uk12") because a UK
 * 12 and a US 12 are two different garments and matching them to each other is
 * the exact mistake the Sweaty Betty chart note warns about.
 */
function aliasesForPart(part: string): string[] {
  let t = part.trim().toLowerCase();
  if (!t) return [];
  t = t.replace(/[().]/g, " ").replace(/\s+/g, " ").trim();
  for (const [re, to] of ALPHA_WORDS) t = t.replace(re, to);
  t = t.replace(/\s|-(?=\D)/g, "");

  const out: string[] = [];
  const sys = t.match(SYSTEM_PREFIX);
  const prefix = sys ? sys[1]! : "";
  const rest = sys ? t.slice(sys[0].length) : t;

  // "16-18" in "UK 16-18 / XL": both numbers name the same row.
  const range = rest.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (range) {
    for (const n of [range[1]!, range[2]!]) out.push(numericAlias(prefix, n));
    return out;
  }
  if (/^\d+(?:\.\d+)?$/.test(rest)) {
    out.push(numericAlias(prefix, rest));
    return out;
  }
  // "2xl" / "3x" → "xxl" / "xxxl".
  const multi = rest.match(/^(\d)x(l|s)?$/);
  if (multi) {
    const n = Number(multi[1]);
    if (n >= 1 && n <= 5) out.push("x".repeat(n) + (multi[2] ?? "l"));
    return out;
  }
  if (/^x*[sml]$/.test(rest)) {
    out.push(rest);
    return out;
  }
  // A waist-in-inches tag ("W30") is also written as the bare number by half
  // the sellers on the platform, so both spellings name the same row.
  const waistTag = rest.match(/^w(\d+(?:\.\d+)?)$/);
  if (waistTag) {
    out.push(rest, String(Number(waistTag[1])));
    return out;
  }
  // Anything else ("one size", a brand's own word) is kept verbatim so an exact
  // string match still works.
  if (rest) out.push(prefix + rest);
  return out;
}

/** A bare number matches only bare numbers; a prefixed one keeps its system. */
function numericAlias(prefix: string, n: string): string {
  const norm = String(Number(n));
  return prefix && prefix !== "us" ? prefix + norm : norm;
}

function aliasesForLabel(label: string): Set<string> {
  const out = new Set<string>();
  for (const part of label.split(/[\/,|]|\bor\b/i)) {
    for (const a of aliasesForPart(part)) out.add(a);
  }
  return out;
}

/**
 * Where an item's size text sits in the band table, or null when nothing
 * matches. Never falls back to index 0: a size we cannot place is a size we do
 * not judge, and guessing "the first row" would flag the whole chart.
 */
export function resolveSizeRow(
  bands: SizeBandRow[],
  sizeLabel: string | null | undefined,
): number | null {
  if (!sizeLabel || !sizeLabel.trim()) return null;
  const want = aliasesForLabel(sizeLabel);
  if (want.size === 0) return null;
  for (const row of bands) {
    const have = aliasesForLabel(row.size);
    for (const a of want) {
      if (have.has(a)) return row.index;
    }
  }
  return null;
}

// ── The verdict ─────────────────────────────────────────────────────────────

/**
 * Which item measurement answers a band key. A top's flat pit-to-pit is stored
 * as `chest` whatever the chart calls it, so bust and chest stand in for each
 * other; nothing else does.
 */
const MEASUREMENT_ALIASES: Record<SizeBandKey, readonly string[]> = {
  chest: ["chest", "bust"],
  bust: ["bust", "chest"],
  waist: ["waist"],
  hip: ["hip", "hips"],
  inseam: ["inseam"],
};

function numeric(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function measurementFor(
  measurements: Record<string, unknown>,
  key: SizeBandKey,
): number | null {
  for (const alias of MEASUREMENT_ALIASES[key]) {
    const n = numeric(measurements[alias]);
    if (n !== null) return n;
  }
  return null;
}

/** Steps required before a disagreement is worth saying out loud. */
export function toleranceFor(tier: SizeChartTier): number {
  return tier === "generic" ? 2 : 1;
}

interface KeyVerdict {
  key: SizeBandKey;
  stepsOff: number;
  impliedSize: string;
  expected: SizeBand | null;
}

function judgeKey(
  bands: SizeBandRow[],
  rowIndex: number,
  key: SizeBandKey,
  value: number,
): KeyVerdict | null {
  const withBand = bands.filter((r) => r.bands[key] !== undefined);
  if (withBand.length === 0) return null;
  const expected = bands[rowIndex]?.bands[key] ?? null;

  const containing = withBand.filter((r) => {
    const b = r.bands[key]!;
    return value >= b[0] && value <= b[1];
  });
  if (containing.length > 0) {
    const nearest = containing.reduce((best, r) =>
      Math.abs(r.index - rowIndex) < Math.abs(best.index - rowIndex) ? r : best
    );
    return {
      key,
      stepsOff: Math.abs(nearest.index - rowIndex),
      impliedSize: nearest.size,
      expected,
    };
  }

  // Off the end of the chart. Naming the edge ("smaller than XS") is the whole
  // point of the motivating case: a 17.5 in flat chest is not "an XS", it is
  // below every size the brand makes, and saying so is more useful than the
  // nearest row's name.
  const smallest = withBand[0]!;
  const largest = withBand[withBand.length - 1]!;
  if (value < smallest.bands[key]![0]) {
    return {
      key,
      stepsOff: rowIndex - (smallest.index - 1),
      impliedSize: `smaller than ${smallest.size}`,
      expected,
    };
  }
  if (value > largest.bands[key]![1]) {
    return {
      key,
      stepsOff: largest.index + 1 - rowIndex,
      impliedSize: `larger than ${largest.size}`,
      expected,
    };
  }

  // In a gap between two bands: take the closer edge.
  const nearest = withBand.reduce((best, r) => {
    const d = edgeDistance(r.bands[key]!, value);
    return d < edgeDistance(best.bands[key]!, value) ? r : best;
  });
  return {
    key,
    stepsOff: Math.abs(nearest.index - rowIndex),
    impliedSize: nearest.size,
    expected,
  };
}

function edgeDistance(band: SizeBand, value: number): number {
  if (value < band[0]) return band[0] - value;
  if (value > band[1]) return value - band[1];
  return 0;
}

export interface SizeCheckInput {
  bands: SizeBandRow[];
  rowIndex: number | null;
  measurements: Record<string, unknown>;
  tier: SizeChartTier;
}

const UNKNOWN: SizeCheckVerdict = {
  status: "unknown",
  impliedSize: null,
  stepsOff: 0,
  key: null,
  expected: null,
};

/**
 * Does the item's own measurement agree with the size on its label?
 *
 * When more than one key can be judged, the one with the LARGEST disagreement
 * wins, so the note names the measurement actually driving it rather than the
 * first one that happened to have a band.
 */
export function checkSize(input: SizeCheckInput): SizeCheckVerdict {
  const { bands, rowIndex, measurements, tier } = input;
  if (rowIndex === null || bands.length === 0 || tier === "none") return UNKNOWN;
  if (rowIndex < 0 || rowIndex >= bands.length) return UNKNOWN;

  const verdicts: KeyVerdict[] = [];
  for (const key of SIZE_BAND_KEYS) {
    const value = measurementFor(measurements ?? {}, key);
    if (value === null) continue;
    const v = judgeKey(bands, rowIndex, key, value);
    if (v) verdicts.push(v);
  }
  if (verdicts.length === 0) return UNKNOWN;

  const worst = verdicts.reduce((a, b) => (b.stepsOff > a.stepsOff ? b : a));
  const status: SizeCheckStatus = worst.stepsOff >= toleranceFor(tier) ? "off" : "ok";
  return {
    status,
    impliedSize: worst.impliedSize,
    stepsOff: worst.stepsOff,
    key: worst.key,
    expected: worst.expected,
  };
}
