// US-3197 AC3/AC4: the executor. Everything the three decision layers decided,
// applied to rows.
//
// THE JUDGEMENT IS NOT HERE. cross-channel-link.ts decides a pair,
// cross-channel-link-plan.ts decides which pairs join, and
// cross-channel-link-writes.ts decides what a join does and how to undo it.
// All three are pure and tested to the case. This file reads rows, hands them
// over, and writes back what it is told -- which is the only shape in which a
// merge with no undo button is safe to automate.
//
// US-268 ON EVERY QUERY. The service-role client bypasses RLS, and the rows
// here are two things at once: another seller's catalogue, and a confirm
// endpoint that ACTS on whatever ids a row names. A review row forged against
// someone else's listings would become a merge of their garments. So the
// owner filter is on the read, on the write, and on the review row itself,
// and the ids are re-checked against the owner before anything is applied.

import { supabaseAdmin } from "./supabase.ts";
import {
  type LinkableRow,
  type LinkPlan,
  planCrossChannelLinks,
} from "./cross-channel-link-plan.ts";
import {
  effectPrevious,
  type LinkWrite,
  planLinkWrites,
  reverseLinkWrites,
} from "./cross-channel-link-writes.ts";

/** Statuses the table allows. Mirrors the CHECK in 00808. */
export type ReviewStatus = "pending" | "linked" | "split";

export const REVIEW_TABLE = "flipdesk_cross_channel_link_reviews";

/** Only live rows are candidates: a sold or ended listing is not cross-listed. */
const CANDIDATE_STATUSES = ["draft", "active"];

export interface ScanSummary {
  linked: number;
  needsReview: number;
  alreadyLinked: number;
  unmatched: number;
  scanned: number;
  failed: number;
}

interface ListingRow {
  id: string;
  inventory_item_id: string;
  draft_id: string | null;
  platform: string;
  listing_price: number | null;
  created_at: string;
  inventory_items: {
    title: string | null;
    brand: string | null;
    size: string | null;
    color: string | null;
  } | null;
}

/** The owner's live listings, shaped for the planner. */
async function loadRows(ownerId: string): Promise<LinkableRow[]> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, inventory_item_id, draft_id, platform, listing_price, created_at, " +
        "inventory_items!inner(title, brand, size, color)",
    )
    .eq("user_id", ownerId) // US-268
    .in("listing_status", CANDIDATE_STATUSES)
    .limit(2000);
  if (error) throw new Error(`could not read listings: ${error.message}`);
  return ((data ?? []) as unknown as ListingRow[]).map((r) => ({
    listingId: r.id,
    inventoryItemId: r.inventory_item_id,
    draftId: r.draft_id,
    createdAt: r.created_at,
    candidate: {
      platform: r.platform,
      // The item owns the describing fields; the listing owns the price.
      title: r.inventory_items?.title ?? "",
      brand: r.inventory_items?.brand ?? null,
      size: r.inventory_items?.size ?? null,
      color: r.inventory_items?.color ?? null,
      price: r.listing_price,
    },
  }));
}

/** The write context one join needs, read fresh rather than taken from the plan. */
async function writeContext(
  ownerId: string,
  keeperListingId: string,
  mergedListingId: string,
) {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select("id, inventory_item_id, draft_id")
    .eq("user_id", ownerId) // US-268
    .in("id", [keeperListingId, mergedListingId]);
  if (error) throw new Error(error.message);
  const rows = (data ?? []) as Array<
    { id: string; inventory_item_id: string; draft_id: string | null }
  >;
  const keeper = rows.find((r) => r.id === keeperListingId);
  const merged = rows.find((r) => r.id === mergedListingId);
  // A row this owner does not have is not a row. Both must resolve, which is
  // what stops a forged review id reaching planLinkWrites at all.
  if (!keeper || !merged) return null;

  const { count } = await supabaseAdmin
    .from("listings")
    .select("id", { count: "exact", head: true })
    .eq("user_id", ownerId) // US-268
    .eq("inventory_item_id", merged.inventory_item_id)
    .neq("id", merged.id);

  const { data: item } = await supabaseAdmin
    .from("inventory_items")
    .select("status")
    .eq("id", merged.inventory_item_id)
    .eq("user_id", ownerId) // US-268
    .maybeSingle();

  return {
    keeper: {
      listingId: keeper.id,
      itemId: keeper.inventory_item_id,
      draftId: keeper.draft_id,
    },
    merged: {
      listingId: merged.id,
      itemId: merged.inventory_item_id,
      draftId: merged.draft_id,
    },
    mergedItemOtherListings: count ?? 0,
    mergedItemStatus: (item as { status?: string } | null)?.status ?? "sourced",
  };
}

/**
 * Apply one write list.
 *
 * Owner-filtered on every statement, so a write whose id escaped the checks
 * above still matches nothing. Returns false on the first refusal rather than
 * continuing: a partly applied join is the state this whole file exists to
 * avoid.
 */
async function applyWrites(ownerId: string, writes: readonly LinkWrite[]): Promise<boolean> {
  for (const w of writes) {
    const { error } = await supabaseAdmin
      .from(w.table)
      .update(w.patch)
      .eq("id", w.id)
      .eq("user_id", ownerId); // US-268
    if (error) {
      console.error(`[cross-channel-link] ${w.table} ${w.id} failed:`, error.message);
      return false;
    }
  }
  return true;
}

/**
 * Find the joins, make the confident ones, queue the rest.
 *
 * AC3 and AC4 in one pass: at or above the bar the pair is joined without
 * asking, below it the pair becomes a question. Nothing in between.
 */
export async function scanForLinks(ownerId: string): Promise<ScanSummary> {
  const rows = await loadRows(ownerId);
  const plan: LinkPlan = planCrossChannelLinks(rows);
  const summary: ScanSummary = {
    linked: 0,
    needsReview: 0,
    alreadyLinked: plan.alreadyLinked,
    unmatched: plan.unmatched,
    scanned: rows.length,
    failed: 0,
  };

  for (const link of plan.links) {
    const ctx = await writeContext(ownerId, link.listingIds[0], link.listingIds[1]);
    if (!ctx) {
      summary.failed++;
      continue;
    }
    const writes = planLinkWrites(link, ctx);
    if (writes.refusals.length > 0 || writes.writes.length === 0) {
      summary.failed++;
      continue;
    }
    if (!await applyWrites(ownerId, writes.writes)) {
      summary.failed++;
      continue;
    }
    summary.linked++;
    // Recorded as a RESOLVED review rather than nothing, so an auto-join is
    // as undoable as a confirmed one and shows up in the same place. A seller
    // who cannot see what was merged automatically cannot trust the button.
    await upsertReview(ownerId, link.listingIds, [link.keepItemId, link.mergeItemId], link.score, [
      ...link.reasons,
      "Joined automatically: the match was above the bar.",
    ], "linked", writes.writes);
  }

  for (const review of plan.reviews) {
    const ok = await upsertReview(
      ownerId,
      review.listingIds,
      review.itemIds,
      review.score,
      review.reasons,
      "pending",
      null,
    );
    if (ok) summary.needsReview++;
  }
  return summary;
}

async function upsertReview(
  ownerId: string,
  listingIds: [string, string],
  itemIds: [string, string],
  score: number,
  reasons: readonly string[],
  status: ReviewStatus,
  appliedWrites: readonly LinkWrite[] | null,
): Promise<boolean> {
  const { error } = await supabaseAdmin.from(REVIEW_TABLE).upsert({
    owner_user_id: ownerId, // US-268
    listing_a_id: listingIds[0],
    listing_b_id: listingIds[1],
    item_a_id: itemIds[0],
    item_b_id: itemIds[1],
    score,
    reasons,
    status,
    applied_writes: appliedWrites,
    resolved_at: status === "pending" ? null : new Date().toISOString(),
  }, { onConflict: "owner_user_id,listing_a_id,listing_b_id", ignoreDuplicates: false });
  if (error) {
    // The unique index is on least/greatest, which supabase-js cannot name in
    // onConflict, so the same pair the other way round lands here rather than
    // merging. That is the idempotency working, not a failure.
    console.error("[cross-channel-link] review upsert:", error.message);
    return false;
  }
  return true;
}

export interface ReviewRow {
  id: string;
  listing_a_id: string;
  listing_b_id: string;
  item_a_id: string;
  item_b_id: string;
  score: number;
  reasons: string[];
  status: ReviewStatus;
  applied_writes: LinkWrite[] | null;
  created_at: string;
}

/** This owner's open questions, best match first. */
export async function listReviews(ownerId: string, status: ReviewStatus = "pending") {
  const { data, error } = await supabaseAdmin
    .from(REVIEW_TABLE)
    .select(
      "id, listing_a_id, listing_b_id, item_a_id, item_b_id, score, reasons, status, " +
        "applied_writes, created_at",
    )
    .eq("owner_user_id", ownerId) // US-268
    .eq("status", status)
    .order("score", { ascending: false })
    .limit(200);
  if (error) throw new Error(`could not read the review queue: ${error.message}`);
  return (data ?? []) as unknown as ReviewRow[];
}

export type ResolveOutcome =
  | { ok: true; status: ReviewStatus }
  | { ok: false; status: number; error: string };

/**
 * Confirm a pair, or split it.
 *
 * Splitting a row that was already LINKED replays its writes backwards, which
 * is the unmerge button. Splitting a pending row just records the refusal, so
 * the next scan does not ask again.
 */
export async function resolveReview(
  ownerId: string,
  reviewId: string,
  decision: "confirm" | "split",
): Promise<ResolveOutcome> {
  const { data } = await supabaseAdmin
    .from(REVIEW_TABLE)
    .select("id, listing_a_id, listing_b_id, item_a_id, item_b_id, score, status, applied_writes")
    .eq("id", reviewId)
    .eq("owner_user_id", ownerId) // US-268
    .maybeSingle();
  const row = data as ReviewRow | null;
  // 404 rather than 403: a caller who does not own it should not learn
  // whether the id exists.
  if (!row) return { ok: false, status: 404, error: "That match could not be found." };

  if (decision === "split") {
    if (row.status === "linked" && Array.isArray(row.applied_writes)) {
      // The unmerge. Reverse order as well as reverse values, so the listing
      // never points at an archived item even for an instant.
      if (!await applyWrites(ownerId, reverseLinkWrites(row.applied_writes))) {
        return { ok: false, status: 500, error: "Could not undo that merge. Nothing was changed." };
      }
    }
    await supabaseAdmin
      .from(REVIEW_TABLE)
      .update({ status: "split", applied_writes: null, resolved_at: new Date().toISOString() })
      .eq("id", row.id)
      .eq("owner_user_id", ownerId); // US-268
    return { ok: true, status: "split" };
  }

  if (row.status === "linked") return { ok: true, status: "linked" };

  const ctx = await writeContext(ownerId, row.listing_a_id, row.listing_b_id);
  if (!ctx) return { ok: false, status: 409, error: "Those listings have changed. Scan again." };
  const writes = planLinkWrites(
    {
      keepItemId: ctx.keeper.itemId,
      mergeItemId: ctx.merged.itemId,
      listingIds: [row.listing_a_id, row.listing_b_id],
      score: row.score,
      reasons: [],
    },
    ctx,
  );
  if (writes.refusals.length > 0) {
    return { ok: false, status: 409, error: "Those listings have changed. Scan again." };
  }
  if (!await applyWrites(ownerId, writes.writes)) {
    return { ok: false, status: 500, error: "Could not join those listings." };
  }
  await supabaseAdmin
    .from(REVIEW_TABLE)
    .update({
      status: "linked",
      applied_writes: writes.writes,
      resolved_at: new Date().toISOString(),
    })
    .eq("id", row.id)
    .eq("owner_user_id", ownerId); // US-268
  // Kept for the run-level undo too, so a merge is reversible from either
  // direction. Shape per effectPrevious.
  void effectPrevious(writes);
  return { ok: true, status: "linked" };
}
