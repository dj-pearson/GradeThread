// US-3197 AC3: what a confirmed join changes, and that it can be put back.
//
// "There is no unmerge button" appears in every note on this feature. These
// cases are what makes that untrue: every mutation carries what it
// overwrote, and the round-trip is asserted rather than described.

import { assert, assertEquals } from "@std/assert";
import type { PlannedLink } from "../lib/cross-channel-link-plan.ts";
import {
  ARCHIVED_STATUS,
  effectPrevious,
  type LinkWriteContext,
  planLinkWrites,
  reverseLinkWrites,
} from "../lib/cross-channel-link-writes.ts";

const link: PlannedLink = {
  keepItemId: "IA",
  mergeItemId: "IB",
  listingIds: ["LA", "LB"],
  score: 0.93,
  reasons: ["Same brand (Nike)."],
};

function ctx(over: Partial<LinkWriteContext> = {}): LinkWriteContext {
  return {
    keeper: { listingId: "LA", itemId: "IA", draftId: null },
    merged: { listingId: "LB", itemId: "IB", draftId: null },
    mergedItemOtherListings: 0,
    mergedItemStatus: "listed",
    ...over,
  };
}

Deno.test("a join moves the listing and points it at the keeper's group", () => {
  const plan = planLinkWrites(link, ctx());
  assertEquals(plan.refusals, []);
  const listing = plan.writes.find((w) => w.table === "listings");
  assert(listing);
  assertEquals(listing.id, "LB");
  assertEquals(listing.patch, { inventory_item_id: "IA", draft_id: "LA" });
  // The anchor is the keeper LISTING's id, not the item's: the group is
  // "rows whose draft_id is X plus the row X itself".
  assertEquals(plan.anchorListingId, "LA");
});

Deno.test("joining to a row that is already a sibling joins its GROUP, not it", () => {
  // The keeper is itself pointing at an older anchor. Making LB point at LA
  // would build a second group off a row that is not an anchor, and
  // siblingSelector would then find LB from LA but not from the real anchor.
  const plan = planLinkWrites(link, ctx({
    keeper: { listingId: "LA", itemId: "IA", draftId: "ANCHOR" },
  }));
  assertEquals(plan.anchorListingId, "ANCHOR");
  assertEquals(
    plan.writes.find((w) => w.table === "listings")?.patch.draft_id,
    "ANCHOR",
  );
});

Deno.test("the emptied item is archived, not deleted", () => {
  // It may hold photos, measurements and a cost basis that are the seller's
  // work. Archived is already in item_status.
  const plan = planLinkWrites(link, ctx());
  const item = plan.writes.find((w) => w.table === "inventory_items");
  assert(item);
  assertEquals(item.id, "IB");
  assertEquals(item.patch, { status: ARCHIVED_STATUS });
  assertEquals(item.previous, { status: "listed" });
  assertEquals(plan.archivedMergedItem, true);
});

Deno.test("an item with OTHER listings is left alone", () => {
  // THE RULE THAT MATTERS. Archiving an item because one of its listings
  // moved away hides an item that still has live channels attached, and the
  // seller finds out when a buyer does.
  const plan = planLinkWrites(link, ctx({ mergedItemOtherListings: 2 }));
  assertEquals(plan.archivedMergedItem, false);
  assertEquals(plan.writes.filter((w) => w.table === "inventory_items"), []);
  // The listing still moves.
  assertEquals(plan.writes.length, 1);
});

Deno.test("an already-archived item is not re-archived, so undo has nothing to undo", () => {
  const plan = planLinkWrites(link, ctx({ mergedItemStatus: ARCHIVED_STATUS }));
  assertEquals(plan.archivedMergedItem, false);
  assertEquals(plan.writes.length, 1);
});

Deno.test("undo puts every column back, and in the safe order", () => {
  const plan = planLinkWrites(link, ctx());
  const undo = reverseLinkWrites(plan.writes);
  // The item is un-archived BEFORE the listing moves back, so the row never
  // points at an archived item even for an instant.
  assertEquals(undo.map((w) => w.table), ["inventory_items", "listings"]);
  assertEquals(undo[0].patch, { status: "listed" });
  assertEquals(undo[1].patch, { inventory_item_id: "IB", draft_id: null });
});

Deno.test("applying then undoing is the identity", () => {
  // Driven rather than reasoned about: a tiny row store, forward then back.
  const plan = planLinkWrites(link, ctx());
  const rows: Record<string, Record<string, unknown>> = {
    LB: { inventory_item_id: "IB", draft_id: null },
    IB: { status: "listed" },
  };
  const before = structuredClone(rows);
  for (const w of plan.writes) Object.assign(rows[w.id], w.patch);
  assertEquals(rows.LB.inventory_item_id, "IA");
  assertEquals(rows.IB.status, ARCHIVED_STATUS);
  for (const w of reverseLinkWrites(plan.writes)) Object.assign(rows[w.id], w.patch);
  assertEquals(rows, before);
});

Deno.test("a plan made against rows that have since moved is refused whole", () => {
  // Half a merge leaves a listing pointing at an item it is not on, which is
  // worse than not merging. So a refusal emits NO writes.
  for (
    const bad of [
      ctx({ keeper: { listingId: "LA", itemId: "MOVED", draftId: null } }),
      ctx({ merged: { listingId: "LB", itemId: "MOVED", draftId: null } }),
    ]
  ) {
    const plan = planLinkWrites(link, bad);
    assert(plan.refusals.length > 0);
    assertEquals(plan.writes, []);
  }
});

Deno.test("a listing joined to itself, or two rows already on one item, are refused", () => {
  const self = planLinkWrites(link, ctx({
    merged: { listingId: "LA", itemId: "IB", draftId: null },
  }));
  assert(self.refusals.some((r) => r.includes("itself")));
  assertEquals(self.writes, []);

  const same = planLinkWrites(
    { ...link, mergeItemId: "IA" },
    ctx({ merged: { listingId: "LB", itemId: "IA", draftId: null } }),
  );
  assert(same.refusals.some((r) => r.includes("already on one item")));
  assertEquals(same.writes, []);
});

Deno.test("the effect blob matches the shape the existing undo already reads", () => {
  // flipdesk-import.ts's undo reads the item's columns at the top level and
  // the listing's under `_listing`. Writing a different shape would mean a
  // merge the existing undo silently skips.
  const previous = effectPrevious(planLinkWrites(link, ctx()));
  assertEquals(previous._listing, { inventory_item_id: "IB", draft_id: null });
  assertEquals(previous.status, "listed");
});

Deno.test("the undo path this shape targets still reads it that way", async () => {
  // A source scan, because the contract lives in another file and a rename
  // there would leave merges undoable in theory and skipped in practice.
  const undoSrc = await Deno.readTextFile(
    new URL("../routes/flipdesk-import.ts", import.meta.url),
  );
  assert(undoSrc.includes("e.previous._listing"), "undo no longer reads _listing");
  assert(
    /from\("flipdesk_import_effects"\)/.test(undoSrc),
    "undo no longer reads the effects table",
  );
});
