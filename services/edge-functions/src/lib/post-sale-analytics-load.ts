// US-2936: the five reads behind the return analytics.
//
// Separated from the arithmetic (post-sale-analytics.ts) so the arithmetic can
// be tested without a database, and separated from the route so the query plan
// is legible in one place.
//
// FIVE QUERIES, NOT ONE PER SALE. Ninety days of sales is a few hundred rows,
// and the naive shape — resolve the grade report and the publication snapshot
// per sale — is a few hundred round trips on a page open. Everything here is
// bulk: one `in(...)` per table, then matched in memory.
//
// Every query is scoped by `user_id` on the owner (US-268). The service-role
// client bypasses RLS, so those filters are the lock.

import { supabaseAdmin } from "./supabase.ts";
import { latestPublicationsFor } from "./listing-publications.ts";
import { findDisclosure, type PublicationSnapshot } from "./dispute-evidence.ts";
import type { ReportedDefect } from "./complaint-match.ts";
import type { AnalyticsCase, AnalyticsSale } from "./post-sale-analytics.ts";

/** Ceiling on one window's sales. A seller past this reads a truncated window. */
export const SALES_SCAN_CAP = 2000;

export interface AnalyticsInputs {
  sales: AnalyticsSale[];
  cases: AnalyticsCase[];
  /** True when the sales scan hit the cap, so the UI can say the window is partial. */
  truncated: boolean;
}

export async function loadReturnAnalyticsInputs(
  ownerId: string,
  sinceIso: string,
): Promise<AnalyticsInputs> {
  // 1. The denominator: every sale in the window.
  const { data: salesData, error: salesError } = await supabaseAdmin
    .from("sales")
    .select("id, inventory_item_id, listing_id, sale_date")
    .eq("user_id", ownerId)
    .gte("sale_date", sinceIso)
    .order("sale_date", { ascending: false })
    .limit(SALES_SCAN_CAP);
  if (salesError) {
    console.error("[post-sale-analytics] sales:", salesError.message);
    return { sales: [], cases: [], truncated: false };
  }
  const saleRows = (salesData ?? []) as unknown as Array<{
    id: string;
    inventory_item_id: string | null;
    listing_id: string | null;
  }>;
  const itemIds = [...new Set(saleRows.map((s) => s.inventory_item_id).filter(Boolean))] as string[];
  if (itemIds.length === 0) {
    return { sales: [], cases: [], truncated: false };
  }

  // 2. Brand and category.
  const { data: itemData } = await supabaseAdmin
    .from("inventory_items")
    .select("id, brand, garment_category")
    .eq("user_id", ownerId)
    .in("id", itemIds);
  const itemById = new Map(
    ((itemData ?? []) as unknown as Array<{
      id: string;
      brand: string | null;
      garment_category: string | null;
    }>).map((i) => [i.id, i]),
  );

  // 3. The grade report behind each item, via the grading submission link.
  const { data: gradingData } = await supabaseAdmin
    .from("flipdesk_grading_submissions")
    .select("inventory_item_id, submission_id, created_at")
    .eq("user_id", ownerId)
    .in("inventory_item_id", itemIds)
    .not("submission_id", "is", null)
    .order("created_at", { ascending: false });
  const submissionByItem = new Map<string, string>();
  for (
    const g of (gradingData ?? []) as unknown as Array<{
      inventory_item_id: string | null;
      submission_id: string | null;
    }>
  ) {
    // Newest first, keep the first — the same rule the singular reader uses.
    if (!g.inventory_item_id || !g.submission_id) continue;
    if (!submissionByItem.has(g.inventory_item_id)) {
      submissionByItem.set(g.inventory_item_id, g.submission_id);
    }
  }

  const submissionIds = [...submissionByItem.values()];
  const reportBySubmission = new Map<
    string,
    { defects: ReportedDefect[]; score: number | null }
  >();
  if (submissionIds.length > 0) {
    const { data: reportData } = await supabaseAdmin
      .from("grade_reports")
      .select("submission_id, defects_found, overall_score, created_at")
      .in("submission_id", submissionIds)
      .order("created_at", { ascending: false });
    for (
      const r of (reportData ?? []) as unknown as Array<{
        submission_id: string | null;
        defects_found: unknown;
        overall_score: number | string | null;
      }>
    ) {
      if (!r.submission_id || reportBySubmission.has(r.submission_id)) continue;
      const score = r.overall_score == null ? null : Number(r.overall_score);
      reportBySubmission.set(r.submission_id, {
        defects: Array.isArray(r.defects_found) ? (r.defects_found as ReportedDefect[]) : [],
        score: score != null && Number.isFinite(score) ? score : null,
      });
    }
  }

  // 4. What each listing actually SAID when it was published. This is the read
  //    that makes the disclosure slice mean "the listing mentioned it" rather
  //    than "the report recorded it" — two very different claims, and the whole
  //    interest of the comparison is in the gap between them.
  const listingIds = [...new Set(saleRows.map((s) => s.listing_id).filter(Boolean))] as string[];
  const snapshots = await latestPublicationsFor(supabaseAdmin, listingIds, ownerId);

  const sales: AnalyticsSale[] = saleRows.map((s) => {
    const item = s.inventory_item_id ? itemById.get(s.inventory_item_id) : undefined;
    const submissionId = s.inventory_item_id
      ? submissionByItem.get(s.inventory_item_id)
      : undefined;
    const report = submissionId ? reportBySubmission.get(submissionId) : undefined;
    let disclosedDefects: number | null = null;
    if (report) {
      const snapRow = s.listing_id ? snapshots.get(s.listing_id) : undefined;
      const snapshot: PublicationSnapshot | null = snapRow
        ? {
          description: snapRow.description,
          aspects: snapRow.aspects,
          publishedAt: snapRow.published_at,
          lastConfirmedAt: snapRow.last_confirmed_at,
        }
        : null;
      // No snapshot means we do not know what the listing said, which is NOT
      // the same as "it disclosed nothing". Left null so the item falls into
      // neither disclosure bucket rather than manufacturing the finding.
      disclosedDefects = snapshot
        ? report.defects.filter((d) => findDisclosure(d, snapshot) !== null).length
        : null;
    }
    return {
      inventoryItemId: s.inventory_item_id,
      brand: item?.brand ?? null,
      category: item?.garment_category ?? null,
      grade: report?.score ?? null,
      disclosedDefects,
    };
  });

  // 5. Every post-sale case on those items.
  const { data: caseData } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select("case_type, reason, inventory_item_id, opened_at, closed_at")
    .eq("user_id", ownerId)
    .in("inventory_item_id", itemIds);
  const cases: AnalyticsCase[] = ((caseData ?? []) as unknown as Array<{
    case_type: string;
    reason: string | null;
    inventory_item_id: string | null;
    opened_at: string | null;
    closed_at: string | null;
  }>).map((c) => ({
    caseType: c.case_type,
    reason: c.reason,
    inventoryItemId: c.inventory_item_id,
    openedAt: c.opened_at,
    closedAt: c.closed_at,
  }));

  return { sales, cases, truncated: saleRows.length >= SALES_SCAN_CAP };
}
