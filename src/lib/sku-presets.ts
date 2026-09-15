// US-3417: the shapes a SKU pattern can take, and five ready-made ones.
//
// This file holds TYPES and DATA. It holds no carry rule, no rendering and no
// parsing, and src/test/sku-odometer-single-home.test.ts fails the build if any
// of those appear here. All three live in Postgres (migration 00802) and the
// screen reads them through the flipdesk_sku_preview RPC. Two copies of a carry
// rule drift, and the drift stays invisible until two items in one tenant get
// the same SKU.

export const SKU_NUMBERING_HREF = "/dashboard/flipdesk/settings/sku";

export const DEFAULT_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

/**
 * One piece of a SKU, rendered left to right.
 *
 * `number` and `letter` COUNT: each consumes one slot of the counters array, in
 * this same order. `text` and `date` do not. That correspondence is the whole
 * contract between this file and the SQL, so a pattern with two counting
 * segments always has exactly two counters.
 */
export type SkuSegment =
  | { kind: "text"; value: string }
  | { kind: "date"; format: "YYYY" | "YY" | "MM" | "DD" }
  /** `width: 0` means no padding at all, so 1032 renders as "1032". */
  | { kind: "number"; width: number; min: number; max: number }
  | { kind: "letter"; alphabet: string; width: number };

export type SkuPreset = {
  id: string;
  label: string;
  /** What it looks like, shown beside the label. */
  example: string;
  /** One plain sentence. No jargon, no segment vocabulary. */
  blurb: string;
  pattern: SkuSegment[];
  counters: number[];
  resetOnDateChange: boolean;
};

/**
 * The five starting points, so nobody has to think in segments to get going.
 *
 * Ordered easiest first. "Letter plus four digits" is the one the owner's own
 * workplace uses and the reason the odometer carries at all, so its blurb says
 * what happens at the rollover rather than describing the shape.
 */
export const SKU_PRESETS: readonly SkuPreset[] = [
  {
    id: "plain",
    label: "Plain number",
    example: "1, 2, 3",
    blurb: "Counts up with no extra zeros in front.",
    pattern: [{ kind: "number", width: 0, min: 1, max: 99999999 }],
    counters: [1],
    resetOnDateChange: false,
  },
  {
    id: "padded",
    label: "Padded number",
    example: "0001",
    blurb: "Always four digits, so they line up when you sort them.",
    pattern: [{ kind: "number", width: 4, min: 0, max: 9999 }],
    counters: [1],
    resetOnDateChange: false,
  },
  {
    id: "prefix",
    label: "Prefix plus number",
    example: "GT-1001",
    blurb: "Your own letters in front, then a running number.",
    pattern: [
      { kind: "text", value: "GT-" },
      { kind: "number", width: 0, min: 1, max: 99999999 },
    ],
    counters: [1001],
    resetOnDateChange: false,
  },
  {
    id: "letter-four",
    label: "Letter plus four digits",
    example: "J0000",
    blurb: "When the digits run out the letter moves up: J9999 becomes K0000.",
    pattern: [
      { kind: "letter", alphabet: DEFAULT_ALPHABET, width: 1 },
      { kind: "number", width: 4, min: 0, max: 9999 },
    ],
    counters: [0, 0],
    resetOnDateChange: false,
  },
  {
    id: "year",
    label: "Year plus number",
    example: "26-00001",
    blurb: "Starts over at 1 every January.",
    pattern: [
      { kind: "date", format: "YY" },
      { kind: "text", value: "-" },
      { kind: "number", width: 5, min: 1, max: 99999 },
    ],
    counters: [1],
    resetOnDateChange: true,
  },
];

/** True for the segment kinds that consume a counter slot. */
export function isCountingSegment(segment: SkuSegment): boolean {
  return segment.kind === "number" || segment.kind === "letter";
}

/**
 * How many counter slots a pattern needs.
 *
 * Shape only. This says how LONG the counters array must be; it says nothing
 * about what goes in it, which is the database's business.
 */
export function countingSlots(pattern: readonly SkuSegment[]): number {
  return pattern.filter(isCountingSegment).length;
}

/** A fresh segment of the given kind, with defaults a seller would expect. */
export function blankSegment(kind: SkuSegment["kind"]): SkuSegment {
  switch (kind) {
    case "text":
      return { kind: "text", value: "-" };
    case "date":
      return { kind: "date", format: "YY" };
    case "letter":
      return { kind: "letter", alphabet: DEFAULT_ALPHABET, width: 1 };
    case "number":
      return { kind: "number", width: 4, min: 0, max: 9999 };
  }
}

/**
 * Counters resized to fit a pattern, keeping the values that still have a home.
 *
 * Used when a segment is added or removed mid-edit. Anything new starts at its
 * segment's minimum, and a value that no longer has a slot is dropped. The
 * database validates the result again on save, so this only has to avoid
 * sending something obviously wrong while the seller is still typing.
 */
export function fitCounters(
  pattern: readonly SkuSegment[],
  counters: readonly number[],
): number[] {
  const out: number[] = [];
  let i = 0;
  for (const segment of pattern) {
    if (!isCountingSegment(segment)) continue;
    // noUncheckedIndexedAccess is on, so this is number | undefined.
    const existing = counters[i];
    const floor = segment.kind === "number" ? segment.min : 0;
    out.push(existing ?? floor);
    i += 1;
  }
  return out;
}
