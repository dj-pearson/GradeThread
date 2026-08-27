// US-2937: a not-as-described return is the strongest grading-accuracy signal
// the product produces, and nothing read it.
//
// A human review says "the model called it 8.5 and a reviewer said 8.0". A SNAD
// return says something stronger and rarer: a real buyer paid real money, held
// the garment, and said the condition was not what we published. That is the
// market disagreeing with the grade, and until now it landed in the post-sale
// page and stopped there.
//
// ── SIGNAL, NOT VERDICT ─────────────────────────────────────────────────────
//
// A buyer says "not as described" for reasons that have nothing to do with the
// grade: they wanted a different size, the colour looked different on their
// screen, they changed their mind and picked the reason that gets free return
// postage. So this NEVER:
//   • rewrites the stored grade,
//   • touches a published certificate,
//   • reaches a customer-facing accuracy figure.
//
// It writes ONE thing: a `grade_outcomes` row tagged `marketplace_snad`, which
// the admin review queue can filter on and a human can confirm or dismiss. The
// public readers exclude that source by name — see NON_SALE_OUTCOME_SOURCES.
//
// ── WHY grade_outcomes AND NOT A NEW TABLE ──────────────────────────────────
//
// The table already exists for exactly this shape (00036: a grade report, the
// sale it came from, and whether a dispute followed), it already has the
// (grade_report_id, sale_id) unique index that makes re-recording idempotent,
// and `computeOutcomeFeedback` already slices it by garment category. A second
// table would be a second answer to "did this grade hold up".

import { supabaseAdmin } from "./supabase.ts";
import { isSnadReason } from "./post-sale-analytics.ts";

/**
 * The `source` value for a marketplace SNAD observation.
 *
 * Its own value rather than reusing `flipdesk`, because a flipdesk row means "a
 * graded item sold" and this one means "a graded item came back". Counting them
 * together would inflate the public graded-sales figure with returns.
 */
export const SNAD_OUTCOME_SOURCE = "marketplace_snad";

/**
 * Sources that are NOT a sale, and must be excluded from any sale-count or
 * public accuracy figure.
 *
 * One list, exported, because it was previously spelled as a bare
 * `.neq("source", "buyer_arrival")` in two places — and a third source added
 * later would have silently joined the sale count in both.
 */
export const NON_SALE_OUTCOME_SOURCES = ["buyer_arrival", SNAD_OUTCOME_SOURCE] as const;

export interface SnadCandidate {
  caseId: string;
  reason: string | null;
  inventoryItemId: string | null;
  saleId: string | null;
}

/**
 * Should this case produce an accuracy observation? Pure.
 *
 * Two conditions, and both are refusals in the safe direction: the reason has
 * to read as a condition complaint, and the case has to be linked to a local
 * item. An unlinked case cannot be attributed to a grade report, so recording
 * it would put a signal against nothing.
 */
export function isSnadObservation(candidate: SnadCandidate): boolean {
  if (!candidate.inventoryItemId) return false;
  return isSnadReason(candidate.reason);
}

export interface SnadSignalDeps {
  loadCandidates: (ownerId: string) => Promise<SnadCandidate[]>;
  /** inventory_item_id → the newest grade report id, for items that have one. */
  loadReportIds: (itemIds: string[]) => Promise<Map<string, string>>;
  record: (
    rows: Array<{ gradeReportId: string; inventoryItemId: string; saleId: string | null }>,
  ) => Promise<number>;
}

/** Bound on one sweep's work. A backlog drains over successive sweeps. */
const CANDIDATE_SCAN_CAP = 200;

async function loadCandidatesFromDb(ownerId: string): Promise<SnadCandidate[]> {
  const { data, error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select("external_id, reason, inventory_item_id, sale_id")
    .eq("user_id", ownerId)
    .eq("platform", "ebay")
    .not("inventory_item_id", "is", null)
    .order("opened_at", { ascending: false })
    .limit(CANDIDATE_SCAN_CAP);
  if (error) {
    console.error("[grade-snad-signal] loadCandidates:", error.message);
    return [];
  }
  return ((data ?? []) as unknown as Array<{
    external_id: string;
    reason: string | null;
    inventory_item_id: string | null;
    sale_id: string | null;
  }>).map((r) => ({
    caseId: r.external_id,
    reason: r.reason,
    inventoryItemId: r.inventory_item_id,
    saleId: r.sale_id,
  }));
}

async function loadReportIdsFromDb(itemIds: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (itemIds.length === 0) return out;
  const { data: grading } = await supabaseAdmin
    .from("flipdesk_grading_submissions")
    .select("inventory_item_id, submission_id, created_at")
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
  if (submissionIds.length === 0) return out;

  const { data: reports } = await supabaseAdmin
    .from("grade_reports")
    .select("id, submission_id, created_at")
    .in("submission_id", submissionIds)
    .order("created_at", { ascending: false });
  const reportBySubmission = new Map<string, string>();
  for (
    const r of (reports ?? []) as unknown as Array<{ id: string; submission_id: string | null }>
  ) {
    if (!r.submission_id || reportBySubmission.has(r.submission_id)) continue;
    reportBySubmission.set(r.submission_id, r.id);
  }
  for (const [itemId, submissionId] of submissionByItem) {
    const reportId = reportBySubmission.get(submissionId);
    if (reportId) out.set(itemId, reportId);
  }
  return out;
}

async function recordToDb(
  rows: Array<{ gradeReportId: string; inventoryItemId: string; saleId: string | null }>,
): Promise<number> {
  if (rows.length === 0) return 0;
  const { error } = await supabaseAdmin
    .from("grade_outcomes")
    .upsert(
      rows.map((r) => ({
        grade_report_id: r.gradeReportId,
        inventory_item_id: r.inventoryItemId,
        sale_id: r.saleId,
        dispute_reported: true,
        source: SNAD_OUTCOME_SOURCE,
      })),
      // The 00036 index. Re-recording the same case is a no-op rather than a
      // second observation, so a sweep every 15 minutes does not manufacture a
      // dispute rate out of one return.
      { onConflict: "grade_report_id,sale_id", ignoreDuplicates: true },
    );
  if (error) {
    console.error("[grade-snad-signal] record:", error.message);
    return 0;
  }
  return rows.length;
}

const defaultDeps: SnadSignalDeps = {
  loadCandidates: loadCandidatesFromDb,
  loadReportIds: loadReportIdsFromDb,
  record: recordToDb,
};

/**
 * Record SNAD observations for one owner. Returns how many rows were written.
 *
 * Never throws — this rides inside the marketplace sweep, and an accuracy
 * signal is not worth taking a notification run down for.
 */
export async function recordSnadObservations(
  ownerId: string,
  deps: SnadSignalDeps = defaultDeps,
): Promise<number> {
  let candidates: SnadCandidate[];
  try {
    candidates = await deps.loadCandidates(ownerId);
  } catch (err) {
    console.error(
      "[grade-snad-signal] load failed:",
      err instanceof Error ? err.message : String(err),
    );
    return 0;
  }
  const snad = candidates.filter(isSnadObservation);
  if (snad.length === 0) return 0;

  const itemIds = [...new Set(snad.map((c) => c.inventoryItemId!))];
  const reportByItem = await deps.loadReportIds(itemIds);

  // Deduped by (report, sale) BEFORE the write, so a return and its escalated
  // case on the same order do not become two rows racing the same unique index.
  const seen = new Set<string>();
  const rows: Array<{ gradeReportId: string; inventoryItemId: string; saleId: string | null }> = [];
  for (const c of snad) {
    const reportId = reportByItem.get(c.inventoryItemId!);
    // No grade report means there is no grade to hold accountable. Not an
    // error — most sellers list plenty of ungraded items.
    if (!reportId) continue;
    const key = `${reportId}|${c.saleId ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      gradeReportId: reportId,
      inventoryItemId: c.inventoryItemId!,
      saleId: c.saleId,
    });
  }
  return await deps.record(rows);
}
