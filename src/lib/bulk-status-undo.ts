// US-2172: undo for the listings table's bulk "Set status…" action.
//
// Setting a status across a selection is the second most expensive mis-click on
// this page (after a bulk markdown, which US-2172 already made reversible). It
// is also the one that looks harmless: nothing is pushed to a marketplace, so
// there is no failure to notice — the seller just finds 200 items in the wrong
// stage, with no record of where each one came from.
//
// The awkward part, and the reason this is a planner rather than a "write the
// old value back" loop: a demote to a draft-like status ALSO rewrites the
// item's listing row (listing_status -> draft, is_active -> false, via
// syncListingForDraftStatus). Restoring only the item status would leave the
// listing half-rewound, which is a worse state than either end of the action.
// So an undo entry carries both halves, and undoing is refused per-row when
// either half has moved on since.
//
// Everything here is pure: the page owns the reads and writes, this owns the
// decision. That split is what makes the "has it moved on?" rules testable,
// because they are exactly the rules that cannot be exercised by clicking.

/** What one row looked like BEFORE the bulk action touched it. */
export interface StatusUndoEntry {
  readonly itemId: string;
  readonly title: string;
  /** The status the bulk action set. Used to detect later changes. */
  readonly appliedStatus: string;
  readonly previousStatus: string;
  /** Present only when the demote path also rewrote the listing row. */
  readonly listing?: {
    readonly id: string;
    readonly previousStatus: string | null;
    readonly previousIsActive: boolean | null;
  };
}

/** The row's state right now, as read back at undo time. */
export interface CurrentRow {
  readonly itemId: string;
  readonly status: string;
  readonly listingStatus?: string | null;
}

export interface StatusUndoPlan {
  readonly restore: StatusUndoEntry[];
  readonly skipped: { readonly title: string; readonly reason: string }[];
}

/**
 * A listing state that undo must never rewind. `sold` is the one that costs
 * real money — putting a sold listing back to active re-exposes stock that is
 * already gone. `ended` is a deliberate seller action taken AFTER the batch,
 * and silently reversing it is the same class of surprise.
 */
const TERMINAL_LISTING_STATUSES = new Set(["sold", "ended"]);

/**
 * Decide which rows can be put back, and name the ones that cannot.
 *
 * `current` is the state read fresh at undo time — NOT the cached array the
 * batch ran against. The gap between the action and the undo click is exactly
 * where a sale lands, so planning off stale rows would restore a status over
 * the top of one.
 *
 * A row missing from `current` is skipped rather than restored: it was deleted,
 * or is no longer the caller's, and inventing a write for it is worse than
 * saying so.
 */
export function planStatusUndo(
  entries: readonly StatusUndoEntry[],
  current: readonly CurrentRow[],
): StatusUndoPlan {
  const byId = new Map(current.map((r) => [r.itemId, r]));
  const restore: StatusUndoEntry[] = [];
  const skipped: { title: string; reason: string }[] = [];

  for (const entry of entries) {
    const now = byId.get(entry.itemId);
    if (!now) {
      skipped.push({ title: entry.title, reason: "no longer in your inventory" });
      continue;
    }
    if (now.status !== entry.appliedStatus) {
      // Something moved this row after the batch — a sync, another tab, a
      // teammate. Whatever it was, it is more recent than the undo, and
      // overwriting it would silently discard a newer decision.
      skipped.push({ title: entry.title, reason: `already moved to ${now.status}` });
      continue;
    }
    if (
      entry.listing &&
      now.listingStatus != null &&
      TERMINAL_LISTING_STATUSES.has(now.listingStatus)
    ) {
      skipped.push({
        title: entry.title,
        reason: now.listingStatus === "sold" ? "sold since" : "ended since",
      });
      continue;
    }
    restore.push(entry);
  }

  return { restore, skipped };
}

/**
 * Build the undo entries for a batch, from the rows that ACTUALLY changed.
 *
 * A row already at the target status is not included: the batch skipped it, so
 * "undoing" it would write a status the seller never asked to change.
 */
export function undoEntriesFor(
  changed: readonly StatusUndoEntry[],
): StatusUndoEntry[] {
  return changed.filter((e) => e.previousStatus !== e.appliedStatus);
}

/**
 * One line naming what could not be put back, for the undo toast.
 *
 * Names the first two rather than a bare count: "3 skipped" with no titles is
 * what sends a seller hunting through 200 rows to find out which.
 */
export function describeSkipped(
  skipped: readonly { title: string; reason: string }[],
): string {
  if (skipped.length === 0) return "";
  const named = skipped
    .slice(0, 2)
    .map((s) => `${s.title} (${s.reason})`)
    .join(", ");
  const rest = skipped.length - Math.min(2, skipped.length);
  return rest > 0 ? `${named}, and ${rest} more` : named;
}

// ── Bulk EDIT undo (US-2172 AC5) ───────────────────────────────────────────
//
// Same idea as the status undo, different evidence. The edit response hands
// back each row's prior values, so the undo is a second bulk edit in the
// per-listing `items` shape — every row going back to its OWN former value.

/** The listings columns a bulk edit can write, and their request-field names. */
const EDIT_FIELD_BY_COLUMN: Record<string, string> = {
  listing_price: "price",
  quantity: "quantity",
  ebay_condition: "ebay_condition",
  ebay_condition_description: "ebay_condition_description",
  shipping_policy_id: "shipping_policy_id",
  payment_policy_id: "payment_policy_id",
  return_policy_id: "return_policy_id",
  platform_category_id: "platform_category_id",
};

export interface BulkEditRowResult {
  readonly listing_id: string;
  readonly status: "ok" | "blocked" | "error";
  readonly previous?: Record<string, unknown>;
}

export interface BulkEditUndoItem {
  readonly listing_id: string;
  readonly edit: Record<string, unknown>;
}

/**
 * Turn a bulk-edit response into the undo request that reverses it.
 *
 * Three rows are deliberately excluded, and each exclusion is the same
 * principle: never push a value the seller did not change.
 *
 *   • a row that was BLOCKED or ERRORED — it never changed, so "restoring" it
 *     would write a value nobody asked for;
 *   • a row with no `previous` — we do not know where it came from, and a
 *     guessed restore is worse than none;
 *   • a NULL former value — the edit endpoint's normalizer drops nulls and
 *     blank strings by design (it validates rather than clears), so asking it
 *     to write one would silently no-op. Saying "N couldn't be put back" beats
 *     a button that reports success and changes nothing.
 *
 * Returns an empty array when nothing is reversible, which the caller reads as
 * "offer no Undo button" rather than one that does nothing.
 */
export function bulkEditUndoItems(
  results: readonly BulkEditRowResult[],
): BulkEditUndoItem[] {
  const items: BulkEditUndoItem[] = [];
  for (const r of results) {
    if (r.status !== "ok" || !r.previous) continue;
    const edit: Record<string, unknown> = {};
    for (const [column, value] of Object.entries(r.previous)) {
      const field = EDIT_FIELD_BY_COLUMN[column];
      if (!field) continue;
      if (value === null || value === undefined || value === "") continue;
      edit[field] = value;
    }
    if (Object.keys(edit).length > 0) {
      items.push({ listing_id: r.listing_id, edit });
    }
  }
  return items;
}

/**
 * How many successfully-edited rows CANNOT be put back, so the toast can say so
 * instead of implying a clean reversal.
 */
export function unrevertableEditCount(
  results: readonly BulkEditRowResult[],
): number {
  const okRows = results.filter((r) => r.status === "ok").length;
  return okRows - bulkEditUndoItems(results).length;
}
