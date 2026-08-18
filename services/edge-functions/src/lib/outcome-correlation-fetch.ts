// US-2280: the IMPURE half — assemble OutcomeRows for the grade-vs-realized-price
// correlation. The maths lives in outcome-correlation.ts and never imports this.
//
// ⚠ THIS READ IS DELIBERATELY NOT TENANT-SCOPED, and that is the one thing about
// it a reviewer must not skim. It is a PLATFORM aggregate for grading
// calibration, mounted under /api/admin/*, which sits behind adminAuthMiddleware
// — authorization-gated rather than tenant-gated, the same posture as
// computeDefectAccuracyReport beside it. The tenant-isolation suite documents
// this exact case: "an admin console that could only see its own rows would be
// useless", so the property to hold is not "B cannot read A's row".
//
// The property that IS held: nothing per-seller survives into the output. Every
// row is projected into `OutcomeRow`, which has no user id, no item id, no
// listing id and no free text — a source-scanned guard in
// outcome-correlation_test.ts fails if that ever changes. So the aggregate
// cannot carry a seller even by accident, which is what AC4 asks for.
//
// NO JOIN IN SQL, on purpose. A view or an RPC would be a migration, and a
// migration is held from push until the operator applies it — so this would sit
// unusable behind a deploy gate. Five bounded reads plus an in-memory join needs
// no schema change and can ship today. If this ever becomes hot, a view is the
// optimisation and it is a deliberate follow-up rather than an oversight.
//
// EVERY READ IS BOUNDED AND ORDERED. PostgREST silently truncates at db-max-rows
// and reports it only in a Content-Range header supabase-js does not surface, so
// an unordered read would drop an arbitrary subset every run. Ordered by
// created_at descending, a cap can only ever drop the OLDEST rows, which is the
// half a calibration window wants to drop anyway.

import { supabaseAdmin } from "./supabase.ts";
import type { OutcomeRow } from "./outcome-correlation.ts";

/** Graded FlipDesk items scanned per run. */
export const OUTCOME_SCAN_CAP = 2_000;
/** PostgREST `.in()` list size. Long URLs get rejected by proxies well before Postgres cares. */
const ID_CHUNK = 200;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Read a table in id-chunks and merge the rows. Every call is bounded by the chunk. */
async function readByIds<T>(
  table: string,
  columns: string,
  column: string,
  ids: string[],
): Promise<T[]> {
  const out: T[] = [];
  for (const group of chunk(ids, ID_CHUNK)) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select(columns)
      .in(column, group);
    if (error) throw new Error(`${table} read failed: ${error.message}`);
    out.push(...((data ?? []) as T[]));
  }
  return out;
}

/** The five reads, already fetched. Split out so the JOIN is pure and testable. */
export interface OutcomeJoinInput {
  links: Array<{ submission_id: string | null; inventory_item_id: string }>;
  reports: Array<{ id: string; submission_id: string; overall_score: number | null }>;
  sales: Array<{ inventory_item_id: string; sale_price: number | null }>;
  comps: Array<{ inventory_item_id: string; comp_median_cents: number | null }>;
  items: Array<{ id: string; category: string | null; status: string | null }>;
  disputedReportIds: ReadonlySet<string>;
}

/**
 * Stitch the five reads into OutcomeRows. PURE — this is where every judgement
 * about what counts lives, so it is the half worth testing.
 *
 * A SALE IS WHAT MAKES A ROW EXIST. No sale, no outcome, no row: an item that
 * was graded and never sold tells us nothing about whether the grade predicted
 * its price, and counting it would drag the population toward unsold inventory.
 */
export function joinOutcomeRows(input: OutcomeJoinInput): OutcomeRow[] {
  const scoreBySubmission = new Map<string, number>();
  const reportIdBySubmission = new Map<string, string>();
  for (const r of input.reports) {
    reportIdBySubmission.set(r.submission_id, r.id);
    if (typeof r.overall_score === "number") scoreBySubmission.set(r.submission_id, r.overall_score);
  }
  const salePriceByItem = new Map<string, number>();
  for (const s of input.sales) {
    if (typeof s.sale_price === "number") salePriceByItem.set(s.inventory_item_id, s.sale_price);
  }
  const compByItem = new Map<string, number>();
  for (const c of input.comps) {
    if (typeof c.comp_median_cents === "number") {
      compByItem.set(c.inventory_item_id, c.comp_median_cents);
    }
  }
  const itemById = new Map(input.items.map((i) => [i.id, i]));

  const rows: OutcomeRow[] = [];
  for (const link of input.links) {
    if (!link.submission_id) continue;
    const grade = scoreBySubmission.get(link.submission_id);
    const salePrice = salePriceByItem.get(link.inventory_item_id);
    if (grade === undefined || salePrice === undefined) continue;
    const item = itemById.get(link.inventory_item_id);
    const reportId = reportIdBySubmission.get(link.submission_id);
    rows.push({
      grade,
      // sale_price is a decimal in DOLLARS; comp_median_cents is in CENTS. The
      // ratio is dimensionless only if both sides share a unit, and this is the
      // one place that knows they do not. Getting it wrong here would put every
      // realization out by 100x and still produce a plausible-looking
      // coefficient, because a constant factor does not change ranks — which is
      // exactly why it needs a test rather than a careful reader.
      salePriceCents: Math.round(salePrice * 100),
      compMedianCents: compByItem.get(link.inventory_item_id) ?? null,
      category: item?.category ?? "unknown",
      returned: item?.status === "returned",
      disputed: reportId ? input.disputedReportIds.has(reportId) : false,
    });
  }
  return rows;
}

export interface OutcomeFetchResult {
  rows: OutcomeRow[];
  /** What the scan saw, so a caller can tell "no signal" from "no data". */
  scanned: number;
  gradedWithSale: number;
  /** True when the scan hit its cap, so a reader knows the window was clipped. */
  capped: boolean;
}

/**
 * Assemble the correlation input.
 *
 * `sinceIso` bounds the window; omit it for everything up to the cap.
 */
export async function fetchOutcomeRows(sinceIso?: string): Promise<OutcomeFetchResult> {
  // 1. The link table: which graded submissions belong to which FlipDesk item.
  let q = supabaseAdmin
    .from("flipdesk_grading_submissions")
    .select("submission_id, inventory_item_id, graded_at")
    .not("submission_id", "is", null)
    .order("graded_at", { ascending: false })
    .limit(OUTCOME_SCAN_CAP);
  if (sinceIso) q = q.gte("graded_at", sinceIso);
  const { data: linkData, error: linkErr } = await q;
  if (linkErr) throw new Error(`flipdesk_grading_submissions read failed: ${linkErr.message}`);
  const links = (linkData ?? []) as Array<{
    submission_id: string | null;
    inventory_item_id: string;
  }>;
  const scanned = links.length;
  if (scanned === 0) return { rows: [], scanned: 0, gradedWithSale: 0, capped: false };

  const submissionIds = [...new Set(links.map((l) => l.submission_id).filter((s): s is string => !!s))];
  const itemIds = [...new Set(links.map((l) => l.inventory_item_id))];

  // 2-5. The four side reads. Independent, so they run together. `disputes` is
  // NOT among them: it keys on grade_report_id, which does not exist until the
  // reports come back, so it is the one genuinely sequential read.
  const [reports, sales, comps, items] = await Promise.all([
    readByIds<{ id: string; submission_id: string; overall_score: number | null }>(
      "grade_reports",
      "id, submission_id, overall_score",
      "submission_id",
      submissionIds,
    ),
    readByIds<{ inventory_item_id: string; sale_price: number | null }>(
      "sales",
      "inventory_item_id, sale_price",
      "inventory_item_id",
      itemIds,
    ),
    readByIds<{ inventory_item_id: string; comp_median_cents: number | null }>(
      "repricing_suggestions",
      "inventory_item_id, comp_median_cents",
      "inventory_item_id",
      itemIds,
    ),
    readByIds<{ id: string; category: string | null; status: string | null }>(
      "inventory_items",
      "id, category, status",
      "id",
      itemIds,
    ),
  ]);

  // The dispute read is sequential because it keys on grade_report_id.
  const disputedReportIds = new Set(
    (
      await readByIds<{ grade_report_id: string }>(
        "disputes",
        "grade_report_id",
        "grade_report_id",
        reports.map((r) => r.id),
      )
    ).map((d) => d.grade_report_id),
  );

  const rows = joinOutcomeRows({ links, reports, sales, comps, items, disputedReportIds });

  return {
    rows,
    scanned,
    gradedWithSale: rows.length,
    capped: scanned >= OUTCOME_SCAN_CAP,
  };
}
