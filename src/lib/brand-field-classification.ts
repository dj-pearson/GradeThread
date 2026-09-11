// US-3307: what is actually in inventory_items.brand?
//
// The brand field is free text and sellers type what the garment shows them, so
// some of what it holds is not a maker at all. Two of the top twenty-five values
// by item count on prod (measured 2026-09-06) were "norman rockwell", a licensor,
// and "cashmere", a fibre. Both were correctly refused from brand_knowledge, and
// refusing them left the real problem untouched: those garments have a maker, it
// is sewn at the collar, and we have not recorded it.
//
// Refusing a value from the KB and knowing WHAT it is are different jobs. This
// module does the second one.
//
// ── Why the data lives in a .json file ─────────────────────────────────────
//
// Three runtimes need the same answer and none of them can import the others:
// this frontend module, scripts/lib/brand-field-classification.mjs (Node), and
// the vitest guards. src/lib/ebay-aspect-registry.json already solves exactly
// this. The edge service is a separate deployable whose Docker build context is
// services/edge-functions/ only, so it cannot import this file either; the one
// rule it has to agree with (AC4, below) is pinned by a source-scan guard in
// src/test/brand-field-classification-parity.test.ts instead.
//
// ── AC4, which is the distinction worth keeping ────────────────────────────
//
// "Unbranded" is NOT a missing value. eBay ships it as a real Brand aspect value
// for a garment that genuinely carries no label, so a seller who typed it
// answered the question. "Unknown" is different information, and an empty field
// is different again: nobody has looked. Collapsing the three loses the only
// signal that says which items are worth going back to.
//
// So `class` has three separate outcomes for those three states, and
// `recordsMaker` is true for `unbranded` because it IS an answer.

import data from "@/lib/brand-field-classification.json";

/** What a brand-field value turned out to be. */
export type BrandFieldClass =
  | "maker"
  | "licensor"
  | "material"
  | "retailer"
  | "descriptor"
  | "unbranded"
  | "unknown"
  | "blank";

interface ClassMeta {
  label: string;
  meaning: string;
  recordsMaker: boolean;
  guidance: string | null;
}

interface ValueEntry {
  key: string;
  label: string;
  class: BrandFieldClass;
  reason: string;
}

const CLASSES = data.classes as Record<BrandFieldClass, ClassMeta>;
const VALUES = data.values as ValueEntry[];

/** The dated version of the classification, for a report header. */
export const BRAND_FIELD_CLASSIFICATION_VERSION: string = data.version;

/** Every classified value, in file order. Exported for guards and reports. */
export const BRAND_FIELD_VALUES: readonly ValueEntry[] = VALUES;

/** The class metadata, so a report can print what a class MEANS. */
export const BRAND_FIELD_CLASSES: Readonly<Record<BrandFieldClass, ClassMeta>> =
  CLASSES;

const BY_KEY = new Map<string, ValueEntry>(VALUES.map((v) => [v.key, v]));

/**
 * The match key. A deliberate duplicate of brandKey() in
 * services/edge-functions/src/lib/brand-normalize.ts. That file is Deno
 * TypeScript and cannot be imported here. Keep them identical.
 *
 * Lowercase, then drop everything outside [a-z0-9]. Accents strip to nothing,
 * which is why the KB spells Stussy `stssy`; see
 * vault/20-domain/brands/brand-kb-alias-refusals.md.
 */
export function brandFieldKey(raw: string | null | undefined): string {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

export interface BrandFieldVerdict {
  /** The input, trimmed. Empty string when the field was blank. */
  value: string;
  /** brandFieldKey(value). "" for blank and for punctuation-only values. */
  key: string;
  class: BrandFieldClass;
  /** True when the item HAS a recorded maker: a real brand, or a recorded "no label". */
  recordsMaker: boolean;
  /** Why this class, for a report. Never shown to a seller as-is. */
  reason: string;
  /** Seller-facing next step, or null when nothing is wrong. */
  guidance: string | null;
}

/**
 * Classify one brand-field value.
 *
 * Exact-match on the normalized key, never a substring and never a heuristic. A
 * classifier that guessed "this looks like a material" would eventually swallow
 * MOTHER, FRAME, Quince or Vince, all ordinary words and all real houses, and a
 * silently swallowed brand is invisible. An unrecognised value is always
 * `maker`, which is the direction that gets a human to look at it.
 */
export function classifyBrandField(
  raw: string | null | undefined,
): BrandFieldVerdict {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  const key = brandFieldKey(value);

  if (key === "") {
    // Covers both a genuinely empty field and a punctuation-only one ("-", "?",
    // "..."), which carry no more information than emptiness does.
    const meta = CLASSES.blank;
    return {
      value,
      key,
      class: "blank",
      recordsMaker: false,
      reason:
        value === ""
          ? "The field is empty."
          : `"${value}" is punctuation only, which says nothing about a maker.`,
      guidance: meta.guidance,
    };
  }

  const hit = BY_KEY.get(key);
  if (hit) {
    const meta = CLASSES[hit.class];
    return {
      value,
      key,
      class: hit.class,
      recordsMaker: meta.recordsMaker,
      reason: hit.reason,
      guidance: meta.guidance,
    };
  }

  return {
    value,
    key,
    class: "maker",
    recordsMaker: true,
    reason: "Not on the named non-brand list, so it is treated as a real maker.",
    guidance: null,
  };
}

/** True when the value names something other than a maker AND is not a recorded "no label". */
export function isNonBrandValue(raw: string | null | undefined): boolean {
  const v = classifyBrandField(raw);
  return v.class !== "maker" && v.class !== "unbranded";
}

/**
 * True when this item has NO recorded maker.
 *
 * This is the population US-3307 is about. It deliberately counts `unbranded`
 * as recorded: that garment's maker question is answered.
 */
export function hasNoRecordedMaker(raw: string | null | undefined): boolean {
  return !classifyBrandField(raw).recordsMaker;
}

export interface BrandFieldTallyRow {
  class: BrandFieldClass;
  /** How many DISTINCT brand strings fell in this class. */
  values: number;
  /** How many ITEMS those strings account for. */
  items: number;
}

export interface BrandFieldTally {
  rows: BrandFieldTallyRow[];
  totalValues: number;
  totalItems: number;
  /** Items whose maker is not recorded (every class except maker and unbranded). */
  itemsWithNoMaker: number;
  /** Distinct values that are not a maker and not a recorded "no label". */
  valuesWithNoMaker: number;
}

const CLASS_ORDER: BrandFieldClass[] = [
  "maker",
  "unbranded",
  "licensor",
  "material",
  "retailer",
  "descriptor",
  "unknown",
  "blank",
];

/**
 * Tally a demand list: [{ brand, count }] where count is items carrying that
 * exact string.
 *
 * Counted BOTH ways on purpose. Distinct values answer "how much of the brand
 * vocabulary is noise"; items answer "how many garments have no maker on file".
 * US-3307's own title quotes a distinct-value ratio from the head of a long tail,
 * which is how a number gets repeated for a year and is wrong.
 */
export function tallyBrandField(
  demand: readonly { brand: string | null | undefined; count: number }[],
): BrandFieldTally {
  const byClass = new Map<BrandFieldClass, BrandFieldTallyRow>();
  for (const c of CLASS_ORDER) {
    byClass.set(c, { class: c, values: 0, items: 0 });
  }

  let totalValues = 0;
  let totalItems = 0;
  let itemsWithNoMaker = 0;
  let valuesWithNoMaker = 0;

  for (const d of demand) {
    const verdict = classifyBrandField(d.brand);
    const count = Number.isFinite(d.count) ? d.count : 0;
    const row = byClass.get(verdict.class)!;
    row.values += 1;
    row.items += count;
    totalValues += 1;
    totalItems += count;
    if (!verdict.recordsMaker) {
      itemsWithNoMaker += count;
      valuesWithNoMaker += 1;
    }
  }

  return {
    rows: CLASS_ORDER.map((c) => byClass.get(c)!),
    totalValues,
    totalItems,
    itemsWithNoMaker,
    valuesWithNoMaker,
  };
}
