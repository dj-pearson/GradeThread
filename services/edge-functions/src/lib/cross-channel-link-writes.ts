// US-3197 AC3, the write half: what a confirmed join actually changes, and
// how to put it back.
//
// THE PHRASE THAT RUNS THROUGH EVERY NOTE ON THIS FEATURE IS "there is no
// unmerge button". This file is the answer to it. Every mutation is emitted
// with the values it overwrote, in the shape `flipdesk_import_effects.previous`
// already uses, so the existing undo path reverses a merge the same way it
// reverses an import. A merge that cannot be undone is a merge a seller
// cannot be offered.
//
// PURE, and the third decision layer built before anything executes --
// cross-channel-link.ts decides a pair, cross-channel-link-plan.ts decides
// which pairs join, and this decides what a join DOES. The executor that
// applies these is mechanical, which is the point: the judgement is all here,
// in plain objects a test can drive.
//
// WHAT A JOIN IS, in this schema. A cross-listing group is "rows whose
// draft_id is X, plus the row X itself" (siblingSelector, US-3367), so the
// ANCHOR listing carries a null draft_id and its siblings point at its ID --
// not at the item. So joining B to A means:
//
//   1. B's listing moves onto A's inventory item.
//   2. B's listing takes A's group anchor as its draft_id. A's OWN draft_id
//      if it has one, because A may already be a sibling in a group; only
//      otherwise A's id.
//   3. B's now-empty inventory item is ARCHIVED -- and only if B's listing
//      was its LAST one.
//
// RULE 3's SECOND HALF IS THE ONE THAT MATTERS. An item can carry several
// listings. Archiving it because one of them moved away would hide an item
// that still has live channels attached, and the seller would find out when a
// buyer did. Archiving rather than deleting is the same reasoning one step
// on: the item may hold photos, measurements and a cost basis that are the
// seller's work, and `archived` is already in item_status.

import type { PlannedLink } from "./cross-channel-link-plan.ts";

/** What the planner needs to know about the two rows as they are now. */
export interface LinkWriteContext {
  /** The listing that keeps its item. */
  keeper: { listingId: string; itemId: string; draftId: string | null };
  /** The listing that moves. */
  merged: { listingId: string; itemId: string; draftId: string | null };
  /**
   * How many OTHER listings hang off the merged listing's item. Zero means
   * the item is emptied by this join and may be archived.
   */
  mergedItemOtherListings: number;
  /** The merged item's status now, so the archive can be undone to it. */
  mergedItemStatus: string;
}

export interface LinkWrite {
  table: "listings" | "inventory_items";
  id: string;
  patch: Record<string, unknown>;
  /** The same keys, holding what they held. This is what undo writes back. */
  previous: Record<string, unknown>;
}

export interface LinkWritePlan {
  writes: LinkWrite[];
  /** The group every joined row now answers to. */
  anchorListingId: string;
  /** False when the merged item still has listings and was left alone. */
  archivedMergedItem: boolean;
  /** Refusals. A non-empty list means NOTHING should be written. */
  refusals: string[];
}

export const ARCHIVED_STATUS = "archived";

/**
 * The exact mutations one confirmed join makes.
 *
 * Refuses rather than half-applies. A refusal returns no writes at all,
 * because a merge that lands one of its two changes leaves a listing pointing
 * at an item it is not on, which is worse than not merging.
 */
export function planLinkWrites(
  link: PlannedLink,
  ctx: LinkWriteContext,
): LinkWritePlan {
  const refusals: string[] = [];

  if (ctx.keeper.listingId === ctx.merged.listingId) {
    refusals.push("a listing cannot be joined to itself");
  }
  if (ctx.keeper.itemId === ctx.merged.itemId) {
    refusals.push("both listings are already on one item");
  }
  if (link.keepItemId !== ctx.keeper.itemId || link.mergeItemId !== ctx.merged.itemId) {
    // The plan was made against rows that have since moved. Applying it would
    // join whatever is there now, which nobody decided.
    refusals.push("the rows moved since the plan was made");
  }
  if (refusals.length > 0) {
    return { writes: [], anchorListingId: ctx.keeper.listingId, refusals, archivedMergedItem: false };
  }

  // A may already be a sibling in a group. Joining to A means joining to A's
  // group, not making a second one.
  const anchorListingId = ctx.keeper.draftId ?? ctx.keeper.listingId;

  const writes: LinkWrite[] = [
    {
      table: "listings",
      id: ctx.merged.listingId,
      patch: { inventory_item_id: ctx.keeper.itemId, draft_id: anchorListingId },
      previous: {
        inventory_item_id: ctx.merged.itemId,
        draft_id: ctx.merged.draftId,
      },
    },
  ];

  // Only when this join emptied it. An item with other listings still has
  // live channels attached and archiving it hides them.
  const archivedMergedItem = ctx.mergedItemOtherListings === 0 &&
    ctx.mergedItemStatus !== ARCHIVED_STATUS;
  if (archivedMergedItem) {
    writes.push({
      table: "inventory_items",
      id: ctx.merged.itemId,
      patch: { status: ARCHIVED_STATUS },
      previous: { status: ctx.mergedItemStatus },
    });
  }

  return { writes, anchorListingId, archivedMergedItem, refusals: [] };
}

/**
 * The same writes, inverted. What undo applies.
 *
 * Reverse ORDER as well as reverse values: the item is un-archived before the
 * listing moves back, so the row never points at an archived item even for an
 * instant.
 */
export function reverseLinkWrites(writes: readonly LinkWrite[]): LinkWrite[] {
  return [...writes].reverse().map((w) => ({
    table: w.table,
    id: w.id,
    patch: { ...w.previous },
    previous: { ...w.patch },
  }));
}

/**
 * The `previous` blob for one `flipdesk_import_effects` row, in the shape the
 * existing undo already reads: the item's own columns at the top level and
 * the listing's under `_listing`.
 */
export function effectPrevious(plan: LinkWritePlan): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const w of plan.writes) {
    if (w.table === "listings") out._listing = { ...w.previous };
    else Object.assign(out, w.previous);
  }
  return out;
}
