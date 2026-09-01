// US-9207: GET /api/flipdesk/time-saved?month=YYYY-MM
//
//   -> { month, totalMinutes, lines: [{ task, count, minutes }], minutesPerTask }
//
// Sums the manual minutes (lib/time-saved.ts) for the tasks FlipDesk did for
// this seller in the month: the rows each task leaves behind are counted, and
// a task with no row contributes nothing. It never guesses at work the seller
// skipped or did by hand.
//
// SECURITY (US-268): the service-role client bypasses RLS, so every count is
// scoped to the verified owner: user_id on the tables that carry one, and the
// inventory_items!inner(user_id) join on item_photos and listings. A user or
// owner id in the query is REJECTED rather than ignored, so a caller cannot
// turn this into a read of someone else's month.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  classifyAiLog,
  monthRange,
  sumTimeSaved,
  TIME_SAVED_MINUTES,
  type TimeSavedCounts,
  type TimeSavedTask,
} from "../lib/time-saved.ts";

export const flipdeskTimeSavedRoutes = new Hono<{
  Variables: { userId: string; workspaceOwnerId?: string };
}>();

const REJECTED_PARAMS = ["user_id", "userId", "owner_id", "ownerId", "workspace_owner_id"];

/** A count query; a failed one reads as zero rather than failing the meter. */
async function countOf(q: PromiseLike<{ count: number | null; error: unknown }>): Promise<number> {
  try {
    const { count, error } = await q;
    if (error) return 0;
    return count ?? 0;
  } catch {
    return 0;
  }
}

flipdeskTimeSavedRoutes.get("/", async (c) => {
  const ownerId = c.get("workspaceOwnerId") ?? c.get("userId");
  for (const p of REJECTED_PARAMS) {
    if (c.req.query(p) != null) {
      return c.json({ error: `${p} is not a parameter here; the month is always the caller's own.` }, 400);
    }
  }
  const range = monthRange(c.req.query("month"));
  if (!range) return c.json({ error: "month must look like YYYY-MM." }, 400);
  const { start, end } = range;

  const counts: TimeSavedCounts = {};

  // Photo edit: a photo that went through the editor keeps its original beside
  // the edited file, or carries the recipe that produced it.
  counts.photo_edit = await countOf(
    supabaseAdmin
      .from("item_photos")
      .select("id, inventory_items!inner(user_id)", { count: "exact", head: true })
      .eq("inventory_items.user_id", ownerId)
      .gte("created_at", start)
      .lt("created_at", end)
      .or("edit_recipe.not.is.null,original_storage_path.not.is.null"),
  );

  // AI passes: one log row per call, classified by what it suggested.
  {
    const { data } = await supabaseAdmin
      .from("ai_enrichment_log")
      .select("suggested_fields")
      .eq("user_id", ownerId)
      .gte("created_at", start)
      .lt("created_at", end)
      .limit(5000);
    for (const row of (data ?? []) as Array<{ suggested_fields: unknown }>) {
      const task = classifyAiLog(row.suggested_fields);
      if (!task) continue;
      counts[task] = (counts[task] ?? 0) + 1;
    }
  }

  // Comps: a listing whose price came from the grade or the comp median
  // (US-9205) rather than the seller's own research.
  counts.comps = await countOf(
    supabaseAdmin
      .from("listings")
      .select("id, inventory_items!inner(user_id)", { count: "exact", head: true })
      .eq("inventory_items.user_id", ownerId)
      .in("price_set_by", ["graded", "comp_median"])
      .gte("updated_at", start)
      .lt("updated_at", end),
  );

  // Cross-list: a GradeThread-originated listing that went live on a channel
  // other than eBay in the month (cross-push siblings and extension writebacks).
  counts.cross_list = await countOf(
    supabaseAdmin
      .from("listings")
      .select("id, inventory_items!inner(user_id)", { count: "exact", head: true })
      .eq("inventory_items.user_id", ownerId)
      .eq("listing_origin", "gradethread")
      .neq("platform", "ebay")
      .not("listed_at", "is", null)
      .gte("listed_at", start)
      .lt("listed_at", end),
  );

  // Delist and relist: desktop-extension jobs the queue ran to completion, plus
  // the listings the server ended or copied itself.
  const queueDone = (kind: TimeSavedTask) =>
    countOf(
      supabaseAdmin
        .from("extension_work_queue")
        .select("id", { count: "exact", head: true })
        .eq("user_id", ownerId)
        .eq("kind", kind)
        .eq("status", "done")
        .gte("completed_at", start)
        .lt("completed_at", end),
    );
  const endedAfterSale = await countOf(
    supabaseAdmin
      .from("listings")
      .select("id, inventory_items!inner(user_id)", { count: "exact", head: true })
      .eq("inventory_items.user_id", ownerId)
      .eq("listing_status", "ended")
      .not("delist_requested_at", "is", null)
      .gte("updated_at", start)
      .lt("updated_at", end),
  );
  counts.delist = (await queueDone("delist")) + endedAfterSale;
  const relistedRows = await countOf(
    supabaseAdmin
      .from("listings")
      .select("id, inventory_items!inner(user_id)", { count: "exact", head: true })
      .eq("inventory_items.user_id", ownerId)
      .eq("listing_status", "relisted")
      .gte("updated_at", start)
      .lt("updated_at", end),
  );
  counts.relist = (await queueDone("relist")) + relistedRows;

  const summary = sumTimeSaved(counts);
  return c.json({
    month: range.month,
    totalMinutes: summary.totalMinutes,
    lines: summary.lines,
    minutesPerTask: TIME_SAVED_MINUTES,
  });
});
