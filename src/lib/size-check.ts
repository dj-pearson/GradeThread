// US-2918: the browser half of the size check.
//
// The MATH lives on the edge (services/edge-functions/src/lib/size-check.ts):
// it turns a brand's body-measurement chart into the flat range a garment of
// each size should show, using the ease numbers from fit-model.ts. This module
// does the LOOKUP only — place the item's size in the returned table, compare
// the measurements, report the disagreement — because that is what has to run on
// every keystroke with no network call.
//
// Splitting it that way is US-2915's architecture decision: the judgement lives
// in one place, each client does arithmetic on a small table, and the composer
// never waits on a request to tell a seller their Large measures like an XS.
//
// The two fixture cases in src/lib/size-check.test.ts are the SAME two the edge
// suite, the iOS suite and the Android suite run, and
// src/test/size-check-fixture-parity.test.ts fails if any of the four drifts.

/** Expected flat range in inches, inclusive on both ends. */
export type SizeBand = [number, number];

export type SizeBandKey = "chest" | "bust" | "waist" | "hip" | "inseam";

export const SIZE_BAND_KEYS: readonly SizeBandKey[] = [
  "chest",
  "bust",
  "waist",
  "hip",
  "inseam",
];

export interface SizeBandRow {
  size: string;
  index: number;
  bands: Partial<Record<SizeBandKey, SizeBand>>;
}

/** How much the chart behind a verdict is worth trusting. */
export type SizeChartTier = "verified" | "brand" | "generic" | "none";

/** The body of GET /api/flipdesk/size-bands. */
export interface SizeBandsResponse {
  tier: SizeChartTier;
  brandLabel: string | null;
  department: string | null;
  garment: string | null;
  sourceUrl: string | null;
  sizeSystem: string | null;
  sizeClass: string | null;
  measurementBasis: "body" | "flat";
  rows: SizeBandRow[];
}

export type SizeCheckStatus = "ok" | "off" | "unknown";

export interface SizeCheckVerdict {
  status: SizeCheckStatus;
  impliedSize: string | null;
  stepsOff: number;
  key: SizeBandKey | null;
  expected: SizeBand | null;
}

const UNKNOWN: SizeCheckVerdict = {
  status: "unknown",
  impliedSize: null,
  stepsOff: 0,
  key: null,
  expected: null,
};

// ── Matching a size label to a row ──────────────────────────────────────────
//
// Mirrors resolveSizeRow in the edge module. Sellers write the same size five
// ways and the corpus writes it three more, so both halves normalise before
// comparing: "Large", "l", "  L  " are one size, "2XL" and "XXL" are one size,
// and a bare "12" is deliberately NOT a "UK 12" — the corpus warns that
// assuming so is the costliest mistake on a UK-sized brand.

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

function numericAlias(prefix: string, n: string): string {
  const norm = String(Number(n));
  return prefix && prefix !== "us" ? prefix + norm : norm;
}

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

  const range = rest.match(/^(\d+(?:\.\d+)?)-(\d+(?:\.\d+)?)$/);
  if (range) {
    for (const n of [range[1]!, range[2]!]) out.push(numericAlias(prefix, n));
    return out;
  }
  if (/^\d+(?:\.\d+)?$/.test(rest)) {
    out.push(numericAlias(prefix, rest));
    return out;
  }
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
  const waistTag = rest.match(/^w(\d+(?:\.\d+)?)$/);
  if (waistTag) {
    out.push(rest, String(Number(waistTag[1])));
    return out;
  }
  if (rest) out.push(prefix + rest);
  return out;
}

function aliasesForLabel(label: string): Set<string> {
  const out = new Set<string>();
  for (const part of label.split(/[/,|]|\bor\b/i)) {
    for (const a of aliasesForPart(part)) out.add(a);
  }
  return out;
}

/**
 * Where an item's size text sits in the band table, or null when nothing
 * matches. Never falls back to index 0 — a size we cannot place is a size we do
 * not judge.
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

/**
 * Size steps required before a disagreement is worth saying out loud: one on a
 * chart a human checked against the brand's own guide, two on a generic
 * fallback that is an estimate and says so.
 */
export function toleranceFor(tier: SizeChartTier): number {
  return tier === "generic" ? 2 : 1;
}

interface KeyVerdict {
  key: SizeBandKey;
  stepsOff: number;
  impliedSize: string;
  expected: SizeBand | null;
}

function edgeDistance(band: SizeBand, value: number): number {
  if (value < band[0]) return band[0] - value;
  if (value > band[1]) return value - band[1];
  return 0;
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

export interface SizeCheckInput {
  bands: SizeBandRow[];
  rowIndex: number | null;
  measurements: Record<string, unknown>;
  tier: SizeChartTier;
}

/**
 * Does the item's own measurement agree with the size on its label? When more
 * than one key can be judged, the one with the LARGEST disagreement wins, so
 * the note names the measurement actually driving it.
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

// ── Copy ────────────────────────────────────────────────────────────────────

/**
 * The size the "Change to …" button would write, or null when there is nothing
 * to change to. An edge verdict ("smaller than XS") names a size the brand does
 * not make, so there is no one-click fix for it — the seller has to decide.
 */
export function fixableSize(verdict: SizeCheckVerdict): string | null {
  const implied = verdict.impliedSize;
  if (verdict.status !== "off" || !implied) return null;
  if (/^(smaller|larger) than /.test(implied)) return null;
  return implied;
}

/** "Measurements point to XS, not Large. A Large usually measures 22 to 26.5 in here." */
export function discrepancyNote(
  verdict: SizeCheckVerdict,
  labelledSize: string,
): string {
  const parts = [`Measurements point to ${verdict.impliedSize}, not ${labelledSize}.`];
  if (verdict.expected) {
    parts.push(
      `A ${labelledSize} usually measures ${verdict.expected[0]} to ${verdict.expected[1]} in here.`,
    );
  }
  return parts.join(" ");
}

/**
 * What the seller should know about the chart behind the note. A generic chart
 * is an estimate and must say so out loud — US-2915 accepted that this check
 * catches gross errors and stays quiet on subtle ones, and a note that hides
 * which kind of chart it used cannot be judged by the person reading it.
 */
export function tierNote(tier: SizeChartTier, brand: string | null): string | null {
  if (tier === "generic") {
    return brand
      ? `Estimate only — no ${brand} chart on file.`
      : "Estimate only — no brand chart on file.";
  }
  return null;
}
