// US-1891: backwards title sync.
//
// Aspects sync both ways already (US-822/824), but `listing_title` is a
// free-form column that nothing rebuilds — so correcting an item's Brand (or
// size/color/style/department) after AI generation left the OLD value in the one
// field buyers search hardest. This does deterministic, token-boundary
// substitution of old→new field values in a title (case-preserving, size-aware,
// multi-word brands), re-trimmed to eBay's 80-char cap.
//
// Pure + dependency-free (aside from the trim helper) so it's fully
// unit-testable without any DB/eBay/AI calls. The caller decides WHEN to apply
// it (GT-origin non-ebay listings only) and applies it to BOTH title variants.

import { EBAY_TITLE_MAX, trimTitleToLimit } from "./title-trim.ts";

export interface FieldChange {
  /** brand | size | color | style | department — informational only. */
  field?: string;
  from: string | null | undefined;
  to: string | null | undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Carry the CASE STYLE of the matched title token onto the replacement so a
// swap reads naturally: ALL-CAPS stays caps, all-lower stays lower, anything
// else uses the new value's own (canonical) casing.
function transferCase(matched: string, replacement: string): string {
  const letters = matched.replace(/[^\p{L}]/gu, "");
  if (letters.length > 0 && letters === letters.toUpperCase()) {
    return replacement.toUpperCase();
  }
  if (letters.length > 0 && letters === letters.toLowerCase()) {
    return replacement.toLowerCase();
  }
  return replacement;
}

/**
 * Replace whole-token occurrences of `from` with `to` in `title`, matched
 * case-insensitively at non-alphanumeric boundaries. Handles multi-word values
 * ("The North Face") and — because the replaced unit is the bounded token
 * itself — every size shape uniformly: "Size L", "Sz L", and a bare "L" all
 * have the "L" token replaced. Returns the title unchanged when `from` isn't
 * present (the no-op contract) or the change is empty/identical.
 */
export function applyTitleSubstitution(
  title: string,
  from: string | null | undefined,
  to: string | null | undefined,
): string {
  const src = (title ?? "");
  const oldVal = (from ?? "").trim();
  const newVal = (to ?? "").trim();
  if (!oldVal || !newVal) return src;
  if (oldVal.toLowerCase() === newVal.toLowerCase()) return src;

  // Boundaries: not preceded/followed by a letter or number. Lets "L" match as
  // a whole token but never inside "XL" or "Long".
  const re = new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRe(oldVal)}(?![\\p{L}\\p{N}])`,
    "giu",
  );
  return src.replace(re, (m) => transferCase(m, newVal));
}

/**
 * Apply a batch of field changes to a title and re-trim to the limit. Order is
 * preserved (later changes see the results of earlier ones). Empty/no-op
 * changes are skipped. The result is whitespace-normalized + word-boundary
 * trimmed by trimTitleToLimit, so a longer new brand can't overflow 80 chars.
 */
export function syncTitle(
  title: string,
  changes: FieldChange[],
  limit: number = EBAY_TITLE_MAX,
): string {
  let out = title ?? "";
  for (const c of changes) {
    out = applyTitleSubstitution(out, c.from, c.to);
  }
  return trimTitleToLimit(out, limit);
}

/**
 * True when syncing the changes would actually alter the title (after trim).
 * Lets the caller skip a write / diff-chip when nothing changed.
 */
export function titleNeedsSync(
  title: string,
  changes: FieldChange[],
  limit: number = EBAY_TITLE_MAX,
): boolean {
  const synced = syncTitle(title, changes, limit);
  return synced !== trimTitleToLimit(title ?? "", limit);
}

/**
 * Build the FieldChange list from before/after item field maps, keeping only
 * the syncable fields that actually changed. Convenience for the save paths.
 */
export const SYNCABLE_TITLE_FIELDS = [
  "brand",
  "size",
  "color",
  "style",
  "department",
] as const;

export function changesFromItemDiff(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): FieldChange[] {
  const changes: FieldChange[] = [];
  for (const field of SYNCABLE_TITLE_FIELDS) {
    const from = before[field];
    const to = after[field];
    if (
      typeof from === "string" && typeof to === "string" &&
      from.trim() && to.trim() && from.trim() !== to.trim()
    ) {
      changes.push({ field, from, to });
    }
  }
  return changes;
}
