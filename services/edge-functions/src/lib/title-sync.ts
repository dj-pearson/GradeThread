// US-1891: backwards title sync.
//
// ↳ REGISTERED AS UNWIRED: vault/70-agent/shipped-but-unwired.md — this edge
//   copy's only consumer is its own test; the web copy shipped, so every
//   non-web surface still leaves a stale brand in listing_title.
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
//
// ⚠ NOTHING IN THE EDGE SERVICE IMPORTS THIS MODULE (verified 2026-07-18).
//
// US-1891 AC2 required the substitution on BOTH "the edge item update path AND
// web item-canvas save". Only the web half shipped: src/lib/title-sync.ts (the
// frontend copy) is wired into item-canvas.tsx persist(), and this copy — its
// declared lockstep mirror — has zero callers. Every export here is reachable
// only from its own tests.
//
// CONSEQUENCE: an item field edit that does NOT go through the web item canvas
// (the edge item-update API, iOS, AutoLister, bulk edit, CSV import) still
// corrects the brand while leaving the OLD brand in listing_title — which is
// precisely the bug US-1891 exists to fix, on every surface except one.
//
// The tests here pass because they call these functions directly, so nothing
// signals the gap. Do not treat this module's coverage as evidence the feature
// works server-side. Tracked as US-1995; wiring it is a real change (it must
// not double-apply against the frontend path, and it has to respect the same
// GT-origin / hand-edited / needs_review rules the canvas applies).

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
