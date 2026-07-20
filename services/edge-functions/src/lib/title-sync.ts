// US-1891: backwards title sync.
//
// ↳ UNCALLED BY DESIGN, NOT BY ACCIDENT (re-audited 2026-07-18, header corrected
//   2026-07-19). See vault/70-agent/shipped-but-unwired.md and US-1995.
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
// ⚠ DO NOT "FIX" THE ZERO CALLER COUNT BY WIRING THIS INTO AN EDGE ROUTE.
//
// An earlier version of this header said the gap was "the edge item update
// path". THERE IS NO SUCH ENDPOINT — no route in services/edge-functions does
// .update() on inventory_items, so anyone acting on that sentence would spend
// the session hunting for something that was never built. The audit that
// established this is recorded in US-1995.
//
// Every surface that writes a SYNCABLE_TITLE_FIELD has since been checked
// individually, and the edge is not among them:
//
//   web item canvas ....... wired (buildTitleSyncPatch)
//   web bulk edit ......... wired (buildTitleSyncPatch) — was the real gap
//   AutoLister ............ N/A: regenerates titles wholesale, so nothing to
//                           substitute into
//   identification-verify . N/A: writes only { attributes, ai_field_sources };
//                           touches no field a title can contain
//   CSV import ............ N/A: fill-only, so the old value is always blank
//                           and the substitution is a provable no-op
//   iOS ................... THE ONE REMAINING GAP, and it cannot consume this
//                           module — it needs a Swift port
//
// SO WHY DOES THIS FILE STILL EXIST? It is the reference implementation the
// Swift port is meant to mirror, and it is one half of the behavioural parity
// fixture (src/test/fixtures/title-sync-cases.json) asserted by BOTH the deno
// and vitest suites. Deleting it would remove one side of the only guard that
// keeps the copies honest. scripts/audit-unwired-exports.mjs will keep
// reporting this module as unwired; that report is correct and expected, and
// this block is the answer to it.
//
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
