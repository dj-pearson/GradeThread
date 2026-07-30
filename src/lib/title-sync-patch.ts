// US-1995: the ORCHESTRATION around backwards title sync, as a pure function.
//
// title-sync.ts owns the substitution. This owns the decisions WRAPPED around
// it — which base title to start from, whether both A/B variants move, and
// whether the change needs review — because those were previously written out
// longhand inside the retired item canvas and would otherwise be copy-pasted into every
// other surface that edits an item.
//
// That is the whole lesson of this story: the pure helper was shared and the
// orchestration was not, so only one surface ever ran it. A seller who
// bulk-corrects a brand across 40 drafts still gets 40 stale titles.
//
// Pure and side-effect free: it returns a patch for the caller to write.

import { syncTitle, trimTitleToLimit, type FieldChange } from "@/lib/title-sync";

export interface TitleVariant {
  title?: string;
  [k: string]: unknown;
}

export interface TitleSyncPatchInput {
  /** The listing's current title (fall back to the item title upstream). */
  baseTitle: string | null | undefined;
  /** The A/B variants, if this listing has them. */
  variants?: unknown;
  /** Field changes from changesFromItemDiff(). */
  changes: readonly FieldChange[];
  /**
   * The title the AI generated (ai_generated_snapshot.title). When the current
   * title differs, the seller hand-edited it and the substitution needs review
   * rather than silent application.
   */
  snapshotTitle?: string | null;
  /**
   * True for a listing that is LIVE on the marketplace. A live listing never
   * silently changes: it queues the revise-in-place prompt, never an end/relist.
   */
  isLive?: boolean;
  /**
   * listing_origin. An 'ebay'-origin listing is eBay's to own — the sync
   * contract forbids writing its title (vault/20-domain/sync-source-of-truth.md), so this
   * returns an empty patch for those.
   */
  listingOrigin?: string | null;
}

export interface TitleSyncPatch {
  listing_title?: string;
  title_variants?: unknown;
  needs_review?: boolean;
}

/**
 * Build the listings patch for a set of item field changes.
 * Returns an EMPTY object when nothing should change — callers can skip the
 * write entirely on `Object.keys(patch).length === 0`.
 */
export function buildTitleSyncPatch(input: TitleSyncPatchInput): TitleSyncPatch {
  const { changes, listingOrigin } = input;
  if (!changes.length) return {};

  // eBay owns an ebay-origin listing's title. Never write it (US-1891 AC3).
  if (listingOrigin === "ebay") return {};

  const baseTitle = (input.baseTitle ?? "").trim();
  if (!baseTitle) return {};

  const synced = syncTitle(baseTitle, [...changes]);
  // Compare against the TRIMMED base: syncTitle re-trims to eBay's cap, so an
  // 81-char title that only lost its tail is not a substitution and must not
  // masquerade as one.
  if (!synced || synced === trimTitleToLimit(baseTitle)) return {};

  const patch: TitleSyncPatch = { listing_title: synced };

  // Both A/B variants get the substitution — a stale brand in variant B is the
  // same bug, just less visible.
  if (Array.isArray(input.variants)) {
    patch.title_variants = (input.variants as TitleVariant[]).map((v) =>
      v && typeof v.title === "string" ? { ...v, title: syncTitle(v.title, [...changes]) } : v,
    );
  }

  // A hand-edited title (diverged from the AI snapshot) or a live listing is
  // flagged rather than silently rewritten: the seller chose those words, or
  // buyers are already seeing them.
  const snapshotTitle = (input.snapshotTitle ?? "").trim();
  const handEdited = !!snapshotTitle && trimTitleToLimit(baseTitle) !== trimTitleToLimit(snapshotTitle);
  if (handEdited || input.isLive) patch.needs_review = true;

  return patch;
}
