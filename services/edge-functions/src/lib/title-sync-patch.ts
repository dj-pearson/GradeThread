// US-1995 orchestration, EDGE mirror of src/lib/title-sync-patch.ts.
//
// title-sync.ts owns the substitution. This owns the decisions wrapped around
// it — which base title to start from, whether both A/B variants move, and
// whether the change needs review. The web copy has existed since US-1995; the
// edge had no caller that changed a syncable field on an item, so it had no
// copy.
//
// US-2817 created that caller. Bulk re-identify is the first edge path that
// writes a NEW brand/size/color/style over an OLD one, and every earlier edge
// writer was exempt for a reason that no longer holds: AutoLister regenerates
// titles wholesale, CSV import only ever fills blanks (so the substitution is a
// provable no-op), and identification-verify writes nothing a title can carry.
// A re-identify pass is none of those. Without this, correcting "Nike" to
// "Patagonia" on forty old drafts would leave forty titles saying Nike — on the
// one field buyers search hardest, and on exactly the drafts the feature exists
// to fix.
//
// Keep in LOCKSTEP with the web copy. Pure and side-effect free: it returns a
// patch for the caller to write.

// The web mirror re-exports trimTitleToLimit from its own title-sync module;
// on the edge it lives in title-trim.ts, which is where title-sync.ts gets it.
import { syncTitle, type FieldChange } from "./title-sync.ts";
import { trimTitleToLimit } from "./title-trim.ts";

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
   * contract forbids writing its title (vault/20-domain/sync-source-of-truth.md),
   * so this returns an empty patch for those.
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
      v && typeof v.title === "string"
        ? { ...v, title: syncTitle(v.title, [...changes]) }
        : v
    );
  }

  // A hand-edited title (diverged from the AI snapshot) or a live listing is
  // flagged rather than silently rewritten: the seller chose those words, or
  // buyers are already seeing them.
  const snapshotTitle = (input.snapshotTitle ?? "").trim();
  const handEdited = !!snapshotTitle &&
    trimTitleToLimit(baseTitle) !== trimTitleToLimit(snapshotTitle);
  if (handEdited || input.isLive) patch.needs_review = true;

  return patch;
}
