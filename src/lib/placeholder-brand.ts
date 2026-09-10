// A placeholder brand is not a brand.
//
// Sellers stage rows in a Google Sheet before the item exists: a title, a
// price, and "Unknown" or nothing in the brand column. Those rows import as
// text-only listings and later get merged with the real item by AutoLister.
// Until that merge happens they are UNREALIZED — a line of intent, not a
// garment that was sourced, listed and sold.
//
// Left in, they land in every brand-grouped report as one fat bucket that
// outranks every real brand and answers no question a seller has: "No brand"
// sitting at the top of sell-through is an artifact of the intake path, not a
// finding about what sells.
//
// The deliberate non-member of the list is "Unbranded". eBay ships it as a real
// aspect value for a garment that genuinely carries no label, so a seller who
// typed it MEANT it. Hiding it would delete data rather than noise.
//
// Pure string work, no React and no supabase, so every case below unit-tests
// directly.

/**
 * Normalized brand strings that mean "nobody filled this in".
 *
 * Compared against the whole trimmed, lowercased value — never a substring, so
 * "No Fear", "None of the Above" and "NA-KD" stay real brands.
 */
export const PLACEHOLDER_BRAND_VALUES: ReadonlySet<string> = new Set([
  "",
  // What the sell-through RPC and capitalVelocity() coalesce a blank brand to
  // before the row ever reaches the client.
  "no brand",
  "unknown",
  "unknown brand",
  "brand unknown",
  "no name",
  "noname",
  "none",
  "n/a",
  "n\\a",
  "na",
  "n.a.",
  "tbd",
  "unspecified",
  "not specified",
  "placeholder",
  "blank",
  "null",
]);

/** A value made only of filler punctuation: "-", "--", "?", "???", ".". */
const PUNCTUATION_ONLY = /^[-_.?/\\|*]+$/;

/**
 * True when this brand is a staging placeholder rather than a real label.
 *
 * Takes either the raw `brand` column or the already-coalesced group label a
 * report row carries, so one predicate covers both sides.
 */
export function isPlaceholderBrand(brand: string | null | undefined): boolean {
  const value = (brand ?? "").trim().toLowerCase();
  if (PLACEHOLDER_BRAND_VALUES.has(value)) return true;
  return PUNCTUATION_ONLY.test(value);
}

export interface PlaceholderBrandSplit<T> {
  /** Rows carrying a real brand, in the order they arrived. */
  real: T[];
  /** Rows whose brand is a placeholder, in the order they arrived. */
  placeholder: T[];
}

/**
 * Splits brand-grouped report rows into the ones worth ranking and the ones
 * that are still unrealized.
 *
 * A split rather than a filter on purpose: the count of what was set aside gets
 * shown next to the table. A report that silently drops rows is a report nobody
 * can reconcile against their inventory.
 */
export function splitPlaceholderBrandRows<T>(
  rows: readonly T[],
  groupOf: (row: T) => string | null | undefined,
): PlaceholderBrandSplit<T> {
  const real: T[] = [];
  const placeholder: T[] = [];
  for (const row of rows) {
    if (isPlaceholderBrand(groupOf(row))) placeholder.push(row);
    else real.push(row);
  }
  return { real, placeholder };
}
