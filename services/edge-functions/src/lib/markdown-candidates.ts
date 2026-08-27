// US-2950: the items an aged-stock markdown rule would cover.
//
// Shared by the hourly runner and the dry-run preview for the same reason the
// send-offer loader is shared: a preview that counted a different set from the
// rule would be worse than no preview, because the seller would enable a rule
// having checked something else.
//
// Tenant-scoped: takes an ownerId and filters every query on it (US-268).

import { supabaseAdmin } from "./supabase.ts";
import type { MarkdownCandidate } from "./markdown-rules.ts";

/** Bound on one pass. A seller past this gets the oldest listings first. */
export const MARKDOWN_SCAN_CAP = 1000;

export async function loadMarkdownCandidates(
  ownerId: string,
  nowMs: number = Date.now(),
): Promise<MarkdownCandidate[]> {
  const { data, error } = await supabaseAdmin
    .from("listings")
    .select(
      "id, listing_title, listing_price, listed_at, inventory_item_id, " +
        "inventory_items!inner(user_id, acquired_price)",
    )
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .eq("listing_status", "active")
    .eq("inventory_items.user_id", ownerId)
    .order("listed_at", { ascending: true, nullsFirst: false })
    .limit(MARKDOWN_SCAN_CAP);
  if (error) {
    console.error("[markdown-candidates] load failed:", error.message);
    return [];
  }
  const rows = (data ?? []) as unknown as Array<{
    id: string;
    listing_title: string | null;
    listing_price: number | null;
    listed_at: string | null;
    inventory_item_id: string | null;
    inventory_items:
      | { acquired_price: number | null }
      | { acquired_price: number | null }[]
      | null;
  }>;
  if (rows.length === 0) return [];

  // The grade, for the minimum-grade floor. One bulk read through the grading
  // link rather than one per listing.
  const itemIds = [...new Set(rows.map((r) => r.inventory_item_id).filter(Boolean))] as string[];
  const gradeByItem = new Map<string, number>();
  if (itemIds.length > 0) {
    const { data: grading } = await supabaseAdmin
      .from("flipdesk_grading_submissions")
      .select("inventory_item_id, submission_id, created_at")
      .eq("user_id", ownerId)
      .in("inventory_item_id", itemIds)
      .not("submission_id", "is", null)
      .order("created_at", { ascending: false });
    const submissionByItem = new Map<string, string>();
    for (
      const g of (grading ?? []) as unknown as Array<{
        inventory_item_id: string | null;
        submission_id: string | null;
      }>
    ) {
      if (!g.inventory_item_id || !g.submission_id) continue;
      if (!submissionByItem.has(g.inventory_item_id)) {
        submissionByItem.set(g.inventory_item_id, g.submission_id);
      }
    }
    const submissionIds = [...submissionByItem.values()];
    if (submissionIds.length > 0) {
      const { data: reports } = await supabaseAdmin
        .from("grade_reports")
        .select("submission_id, overall_score, created_at")
        .in("submission_id", submissionIds)
        .order("created_at", { ascending: false });
      const scoreBySubmission = new Map<string, number>();
      for (
        const r of (reports ?? []) as unknown as Array<{
          submission_id: string | null;
          overall_score: number | string | null;
        }>
      ) {
        if (!r.submission_id || scoreBySubmission.has(r.submission_id)) continue;
        const n = r.overall_score == null ? Number.NaN : Number(r.overall_score);
        if (Number.isFinite(n)) scoreBySubmission.set(r.submission_id, n);
      }
      for (const [itemId, submissionId] of submissionByItem) {
        const score = scoreBySubmission.get(submissionId);
        if (score != null) gradeByItem.set(itemId, score);
      }
    }
  }

  return rows.map((r) => {
    const inv = Array.isArray(r.inventory_items) ? r.inventory_items[0] : r.inventory_items;
    const listedAt = r.listed_at ? Date.parse(r.listed_at) : Number.NaN;
    return {
      listingId: r.id,
      title: r.listing_title,
      priceCents: r.listing_price != null ? Math.round(Number(r.listing_price) * 100) : null,
      costCents: typeof inv?.acquired_price === "number"
        ? Math.round(inv.acquired_price * 100)
        : null,
      daysListed: Number.isFinite(listedAt)
        ? Math.floor((nowMs - listedAt) / 86_400_000)
        : null,
      grade: r.inventory_item_id ? (gradeByItem.get(r.inventory_item_id) ?? null) : null,
    };
  });
}
