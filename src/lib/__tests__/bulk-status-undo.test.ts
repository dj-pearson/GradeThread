import { describe, it, expect } from "vitest";
import {
  planStatusUndo,
  undoEntriesFor,
  describeSkipped,
  bulkEditUndoItems,
  unrevertableEditCount,
  type StatusUndoEntry,
} from "../bulk-status-undo";

// US-2172 AC3: an undo that quietly writes over something newer is worse than
// no undo, because the seller believes they reverted a mistake and instead made
// a second one. Every rule below is a case that cannot be reached by clicking
// around — it needs the world to change BETWEEN the batch and the undo click.

const entry = (over: Partial<StatusUndoEntry> = {}): StatusUndoEntry => ({
  itemId: "i1",
  title: "Nike windbreaker",
  appliedStatus: "archived",
  previousStatus: "listed",
  ...over,
});

describe("planStatusUndo", () => {
  it("restores a row that is still where the batch left it", () => {
    const plan = planStatusUndo(
      [entry()],
      [{ itemId: "i1", status: "archived" }],
    );
    expect(plan.restore).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  it("skips a row someone moved after the batch", () => {
    // The undo is older than the change it would overwrite.
    const plan = planStatusUndo(
      [entry()],
      [{ itemId: "i1", status: "sold" }],
    );
    expect(plan.restore).toEqual([]);
    expect(plan.skipped).toEqual([
      { title: "Nike windbreaker", reason: "already moved to sold" },
    ]);
  });

  it("skips a row that is gone", () => {
    const plan = planStatusUndo([entry()], []);
    expect(plan.restore).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("no longer in your inventory");
  });

  it("refuses to rewind a listing that sold since the batch", () => {
    // The expensive one: restoring `active` over a sold listing re-exposes
    // stock that is already gone and invites a second sale of one garment.
    const plan = planStatusUndo(
      [
        entry({
          listing: { id: "l1", previousStatus: "active", previousIsActive: true },
        }),
      ],
      [{ itemId: "i1", status: "archived", listingStatus: "sold" }],
    );
    expect(plan.restore).toEqual([]);
    expect(plan.skipped[0]?.reason).toBe("sold since");
  });

  it("refuses to rewind a listing the seller ended since the batch", () => {
    const plan = planStatusUndo(
      [
        entry({
          listing: { id: "l1", previousStatus: "active", previousIsActive: true },
        }),
      ],
      [{ itemId: "i1", status: "archived", listingStatus: "ended" }],
    );
    expect(plan.skipped[0]?.reason).toBe("ended since");
  });

  it("still restores when the listing is somewhere non-terminal", () => {
    const plan = planStatusUndo(
      [
        entry({
          listing: { id: "l1", previousStatus: "active", previousIsActive: true },
        }),
      ],
      [{ itemId: "i1", status: "archived", listingStatus: "draft" }],
    );
    expect(plan.restore).toHaveLength(1);
  });

  it("does not apply the listing rule to a row whose listing was untouched", () => {
    // A non-demote batch never rewrote the listing row, so its current state is
    // none of the undo's business — refusing here would block a safe restore.
    const plan = planStatusUndo(
      [entry({ listing: undefined })],
      [{ itemId: "i1", status: "archived", listingStatus: "sold" }],
    );
    expect(plan.restore).toHaveLength(1);
    expect(plan.skipped).toEqual([]);
  });

  it("sorts a mixed batch into both buckets without dropping a row", () => {
    const entries = [
      entry({ itemId: "a", title: "A" }),
      entry({ itemId: "b", title: "B" }),
      entry({ itemId: "c", title: "C" }),
    ];
    const plan = planStatusUndo(entries, [
      { itemId: "a", status: "archived" },
      { itemId: "b", status: "shipped" },
      // "c" is absent.
    ]);
    expect(plan.restore.map((r) => r.itemId)).toEqual(["a"]);
    expect(plan.skipped.map((s) => s.title)).toEqual(["B", "C"]);
    expect(plan.restore.length + plan.skipped.length).toBe(entries.length);
  });
});

describe("undoEntriesFor", () => {
  it("drops rows the batch never changed", () => {
    // The batch skips a row already at the target status. Offering to "undo" it
    // would write a status the seller never asked to change.
    const out = undoEntriesFor([
      entry({ itemId: "a", previousStatus: "listed" }),
      entry({ itemId: "b", previousStatus: "archived" }),
    ]);
    expect(out.map((e) => e.itemId)).toEqual(["a"]);
  });
});

describe("describeSkipped", () => {
  it("is empty when nothing was skipped", () => {
    expect(describeSkipped([])).toBe("");
  });

  it("names rows instead of counting them", () => {
    expect(describeSkipped([{ title: "A", reason: "sold since" }])).toBe(
      "A (sold since)",
    );
  });

  it("names the first two and counts the rest", () => {
    const out = describeSkipped([
      { title: "A", reason: "sold since" },
      { title: "B", reason: "ended since" },
      { title: "C", reason: "sold since" },
      { title: "D", reason: "sold since" },
    ]);
    expect(out).toBe("A (sold since), B (ended since), and 2 more");
  });
});

// ── Bulk EDIT undo (US-2172 AC5) ───────────────────────────────────────────

describe("bulkEditUndoItems", () => {
  it("sends each row back to its OWN former value", () => {
    // The whole reason the per-listing body shape exists: one shared patch
    // cannot say "a goes to 30, b goes to 12".
    const items = bulkEditUndoItems([
      { listing_id: "a", status: "ok", previous: { listing_price: 30 } },
      { listing_id: "b", status: "ok", previous: { listing_price: 12 } },
    ]);
    expect(items).toEqual([
      { listing_id: "a", edit: { price: 30 } },
      { listing_id: "b", edit: { price: 12 } },
    ]);
  });

  it("maps every editable column onto its request field", () => {
    const items = bulkEditUndoItems([
      {
        listing_id: "a",
        status: "ok",
        previous: {
          listing_price: 20,
          quantity: 2,
          ebay_condition: "USED_EXCELLENT",
          shipping_policy_id: "ship-1",
        },
      },
    ]);
    expect(items[0]?.edit).toEqual({
      price: 20,
      quantity: 2,
      ebay_condition: "USED_EXCELLENT",
      shipping_policy_id: "ship-1",
    });
  });

  it("excludes a blocked row — it never changed", () => {
    expect(
      bulkEditUndoItems([
        { listing_id: "a", status: "blocked", previous: { listing_price: 30 } },
      ]),
    ).toEqual([]);
  });

  it("excludes a failed row — restoring it would push a value nobody set", () => {
    expect(
      bulkEditUndoItems([
        { listing_id: "a", status: "error", previous: { listing_price: 30 } },
      ]),
    ).toEqual([]);
  });

  it("excludes a row whose prior value we never learned", () => {
    expect(bulkEditUndoItems([{ listing_id: "a", status: "ok" }])).toEqual([]);
  });

  it("excludes a NULL former value rather than pretending to clear it", () => {
    // The edit endpoint's normalizer drops nulls and blanks by design — it
    // validates rather than clears — so asking it to write one silently
    // no-ops. An Undo that reports success and changes nothing is the exact
    // failure AC4 names.
    expect(
      bulkEditUndoItems([
        { listing_id: "a", status: "ok", previous: { ebay_condition: null } },
      ]),
    ).toEqual([]);
    expect(
      bulkEditUndoItems([
        { listing_id: "a", status: "ok", previous: { shipping_policy_id: "" } },
      ]),
    ).toEqual([]);
  });

  it("keeps the reversible half of a row with one null field", () => {
    const items = bulkEditUndoItems([
      {
        listing_id: "a",
        status: "ok",
        previous: { listing_price: 30, ebay_condition: null },
      },
    ]);
    expect(items[0]?.edit).toEqual({ price: 30 });
  });

  it("ignores a column the edit endpoint cannot write", () => {
    expect(
      bulkEditUndoItems([
        { listing_id: "a", status: "ok", previous: { listing_status: "draft" } },
      ]),
    ).toEqual([]);
  });
});

describe("unrevertableEditCount", () => {
  it("counts the edited rows that cannot be put back", () => {
    const results = [
      { listing_id: "a", status: "ok" as const, previous: { listing_price: 30 } },
      { listing_id: "b", status: "ok" as const, previous: { ebay_condition: null } },
      { listing_id: "c", status: "ok" as const },
      { listing_id: "d", status: "blocked" as const },
    ];
    // a is reversible; b and c are not; d was never edited so it doesn't count.
    expect(unrevertableEditCount(results)).toBe(2);
  });

  it("is zero when everything reverses", () => {
    expect(
      unrevertableEditCount([
        { listing_id: "a", status: "ok", previous: { listing_price: 30 } },
      ]),
    ).toBe(0);
  });
});
