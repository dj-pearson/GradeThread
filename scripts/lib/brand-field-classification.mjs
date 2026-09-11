// US-3307: the Node view of the ONE brand-field classification.
//
// The data lives in src/lib/brand-field-classification.json and nothing here
// restates it. This file is the reader for Node scripts; the frontend reader is
// src/lib/brand-field-classification.ts and the two must behave identically,
// which src/lib/__tests__/brand-field-classification.test.ts checks by running
// this file's own self-test cases through the TypeScript one.
//
// Before US-3307 the same knowledge existed in three places that had already
// drifted: scripts/brand-kb-gap.mjs's NOT_A_BRAND (12 values, the only one that
// knew about Norman Rockwell), src/lib/placeholder-brand.ts (18 values, and the
// only one that got the Unbranded distinction right), and a three-value inline
// check in services/edge-functions/src/lib/style-code-prospect.ts.
//
// ⚠ readFileSync, not `import ... with { type: "json" }`. Import attributes are
// available on Node 22 but the repo's scripts are run by several node versions
// and by vitest, and a JSON import assertion that silently changes shape between
// them is not worth the syntax.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// fileURLToPath, never url.pathname: on Windows a file: URL's pathname is
// "/C:/Users/..." and readFileSync rejects the leading slash, so a guard that
// imports this file fails locally while passing in CI.
const HERE = dirname(fileURLToPath(import.meta.url));
export const CLASSIFICATION_PATH = join(
  HERE,
  "..",
  "..",
  "src",
  "lib",
  "brand-field-classification.json",
);

const data = JSON.parse(readFileSync(CLASSIFICATION_PATH, "utf8"));

export const BRAND_FIELD_CLASSIFICATION_VERSION = data.version;
export const BRAND_FIELD_CLASSES = data.classes;
export const BRAND_FIELD_VALUES = data.values;

/** brandKey(), kept identical to brand-normalize.ts and to the TS reader. */
export function brandFieldKey(raw) {
  return String(raw ?? "").toLowerCase().replace(/[^a-z0-9]/g, "");
}

const BY_KEY = new Map(data.values.map((v) => [v.key, v]));

/**
 * Classify one brand-field value. Exact match on the normalized key, never a
 * substring and never a heuristic. An unrecognised value is always `maker`,
 * because a silently swallowed real brand is invisible and a wrongly-proposed
 * pack is not.
 */
export function classifyBrandField(raw) {
  const value = String(raw ?? "").replace(/\s+/g, " ").trim();
  const key = brandFieldKey(value);

  if (key === "") {
    return {
      value,
      key,
      class: "blank",
      recordsMaker: false,
      reason: value === ""
        ? "The field is empty."
        : `"${value}" is punctuation only, which says nothing about a maker.`,
      guidance: data.classes.blank.guidance,
    };
  }

  const hit = BY_KEY.get(key);
  if (hit) {
    const meta = data.classes[hit.class];
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

/** Not a maker and not a recorded "no label": brand-field noise. */
export function isNonBrandValue(raw) {
  const v = classifyBrandField(raw);
  return v.class !== "maker" && v.class !== "unbranded";
}

/** True when the item has NO recorded maker. `unbranded` counts as recorded. */
export function hasNoRecordedMaker(raw) {
  return !classifyBrandField(raw).recordsMaker;
}

export const CLASS_ORDER = [
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
 * Tally a demand list of { brand, count }.
 *
 * BOTH denominators, always. Distinct values answer "how much of the brand
 * vocabulary is noise"; items answer "how many garments have no maker on file".
 * These are different numbers and US-3307's title quotes the first one as if it
 * were the second.
 */
export function tallyBrandField(demand) {
  const byClass = new Map(
    CLASS_ORDER.map((c) => [c, { class: c, values: 0, items: 0 }]),
  );
  let totalValues = 0;
  let totalItems = 0;
  let itemsWithNoMaker = 0;
  let valuesWithNoMaker = 0;

  for (const d of demand) {
    const verdict = classifyBrandField(d.brand);
    const count = Number.isFinite(d.count) ? d.count : 0;
    const row = byClass.get(verdict.class);
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
    rows: CLASS_ORDER.map((c) => byClass.get(c)),
    totalValues,
    totalItems,
    itemsWithNoMaker,
    valuesWithNoMaker,
  };
}

/**
 * The cases both readers must agree on, exported so the vitest parity test can
 * run the very same list through the TypeScript reader rather than restating it.
 */
export const PARITY_CASES = [
  ["Norman Rockwell", "licensor"],
  ["norman rockwell", "licensor"],
  ["Cashmere", "material"],
  ["Goodwill", "retailer"],
  ["Vintage", "descriptor"],
  ["Unbranded", "unbranded"],
  ["Handmade", "unbranded"],
  ["Unknown", "unknown"],
  ["N/A", "unknown"],
  ["No Brand", "unknown"],
  ["None", "unknown"],
  ["", "blank"],
  ["   ", "blank"],
  ["-", "blank"],
  ["???", "blank"],
  // Real houses that are ordinary words. Every one of these must survive.
  ["MOTHER", "maker"],
  ["FRAME", "maker"],
  ["Quince", "maker"],
  ["Vince", "maker"],
  ["No Fear", "maker"],
  ["NA-KD", "maker"],
  ["None of the Above", "maker"],
  ["Vintage Havana", "maker"],
  ["The Original Retro Brand", "maker"],
  ["Bella+Canvas", "maker"],
  ["Gildan", "maker"],
  ["Stüssy", "maker"],
];
