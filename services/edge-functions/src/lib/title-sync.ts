// US-1891: backwards title sync.
//
// ↳ NOW WIRED (US-1995, 2026-08-08). This module was uncalled for three weeks
//   and the header below used to explain why that was correct. It is called
//   now, by reconcile-fields.ts. See vault/70-agent/shipped-but-unwired.md.
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
// ⚠ THE OLD HEADER HERE WAS WRONG, AND IT IS WORTH KNOWING HOW.
//
// It said "DO NOT fix the zero caller count by wiring this into an edge route",
// on the reasoning that no edge route does .update() on inventory_items. That
// second claim was false: reconcile/apply in flipdesk-autolister.ts writes
// inventory_items AND listings from buildMergeWrites. The header also listed
// "web item canvas ....... wired", naming a file that had already been deleted;
// its replacement, composer.tsx, inherited none of the sync. So a confident
// DO-NOT-TOUCH block was standing guard over two live gaps.
//
// The lesson is narrow and repeatable: a header that argues from an ABSENCE
// ("no route does X") ages badly, because nothing fails when the absence ends.
// Where a claim like that is load-bearing, pin it with a test, not a comment.
//
// Every surface that writes a SYNCABLE_TITLE_FIELD, re-audited 2026-08-08:
//
//   web composer .......... wired (buildTitleSyncPatch) — was the P1 gap
//   web bulk edit ......... wired (buildTitleSyncPatch)
//   web grid inline edit .. wired (buildTitleSyncPatch)
//   edge reconcile/apply .. wired HERE, via reconcile-fields.ts: the kept title
//                           is reconciled against the winning brand/size/
//                           color/style. Pinned by reconcile-fields_test.ts.
//   AutoLister generate ... N/A: regenerates titles wholesale, so nothing to
//                           substitute into
//   identification-verify . N/A: writes only { attributes, ai_field_sources };
//                           touches no field a title can contain
//   CSV import ............ N/A: fill-only, so the old value is always blank
//                           and the substitution is a provable no-op
//   iOS ................... THE ONE REMAINING GAP, and it cannot consume this
//                           module — it needs a Swift port (AIItemFieldWriter)
//
// US-2817 (2026-08-22) added a writer this audit had no row for, and it landed
// in the exempt column rather than the wired one. Bulk re-identify
// (flipdesk-ai.ts /bulk-extract, mode 'reidentify') REPLACES an AI-written
// brand/size/color/style with a better one, so the CSV-import reasoning above
// ("fill-only, the old value is always blank") is exactly what stops applying.
// It is wired, through a new edge title-sync-patch.ts that ports the web
// orchestration; the two copies are pinned behaviourally by
// src/test/fixtures/title-sync-patch-cases.json.
//
// Worth reading the shape of the N/A rows before adding one: each argues from a
// property of the CALLER, and a new caller is free not to have that property.
// They are dated observations, not exemptions.
//
// This file is also one half of the behavioural parity fixture
// (src/test/fixtures/title-sync-cases.json) asserted by BOTH the deno and
// vitest suites, which is what keeps it honest against the web copy.
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

// Boundaries: not preceded/followed by a letter or number. Lets "L" match as a
// whole token but never inside "XL" or "Long".
function tokenBoundedRe(value: string): RegExp {
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRe(value)}(?![\\p{L}\\p{N}])`,
    "giu",
  );
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
 *
 * IDEMPOTENT (US-1995): applying the same change twice equals applying it once.
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

  // US-1995: this has to be IDEMPOTENT, and a bare replace is not.
  //
  // When the new value CONTAINS the old one — "L" -> "L/XL", "North Face" ->
  // "The North Face", "Blue" -> "Blue Navy", "501" -> "501 Original" — a second
  // pass matches the old value sitting inside the replacement it just wrote and
  // expands again: "L/XL/XL", "The The North Face". Those are not exotic inputs;
  // widening a size and qualifying a brand are everyday seller corrections.
  //
  // It matters because idempotence is the ONLY thing standing between two
  // surfaces that both sync and a corrupted title. `changes` is computed from a
  // captured before-map, so a retried mutation or a not-yet-invalidated query
  // cache replays {from: old, to: new} against a title that already holds the
  // new value. "Pick one owner per surface" is the design, but it is a
  // convention, and a convention is not a guard.
  //
  // So in the containing case, spans that ALREADY read as the new value are
  // protected and only occurrences outside them are replaced.
  const expands = tokenBoundedRe(oldVal).test(newVal);
  const guarded: Array<[number, number]> = expands
    ? [...src.matchAll(tokenBoundedRe(newVal))].map((m) => {
      const start = m.index ?? 0;
      return [start, start + m[0].length] as [number, number];
    })
    : [];

  let out = "";
  let cursor = 0;
  for (const m of src.matchAll(tokenBoundedRe(oldVal))) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (guarded.some(([gs, ge]) => start >= gs && end <= ge)) continue;
    out += src.slice(cursor, start) + transferCase(m[0], newVal);
    cursor = end;
  }
  return out + src.slice(cursor);
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
