import { supabaseAdmin } from "./supabase.ts";
import { latestPublication } from "./listing-publications.ts";
import { matchComplaint, type ReportedDefect } from "./complaint-match.ts";
import type { EvidenceStamp } from "./evidence-pack.ts";
import {
  buildEvidencePlan,
  type EvidencePlan,
  type PublicationSnapshot,
} from "./dispute-evidence.ts";

// US-2706 / US-2707: the evidence verdict for one eBay order's item.
//
// ⚠ EXTRACTED FROM routes/flipdesk-ebay.ts BY US-3068, unchanged. The return
// shield needs the same verdict from a different surface, and the alternative
// was a route importing a route — which is exactly what US-3065 spent a pass
// undoing for the extension queue.
//
// ONE PLANNER FOR EVERY CASE TYPE, and that is the rule rather than a
// convenience. A return, a payment dispute and now an on-page shield are
// different eBay surfaces asking the same question — does the grade report back
// this seller — and two planners would be two answers, with the rarer path
// holding the one nobody re-checked. US-2707 exists because that gap was real.

/**
 * US-2706 / US-2707: the evidence verdict for one eBay order's item, or null.
 *
 * ONE planner for both case types. A return and a payment dispute are different
 * eBay surfaces asking the same question - does the grade report back this
 * seller - and two planners would be two answers, with the rarer path holding
 * the one nobody re-checked.
 *
 * Null means "could not decide", never "nothing to worry about". Every lookup
 * here is tenant-scoped by ownerId, and the chain is
 * sale -> inventory item -> grading submission -> grade report, plus the
 * listing's most recent publication snapshot.
 */
export interface EvidenceContext {
  plan: EvidencePlan;
  /** US-2706 AC6: false means the pack can only argue from the grade report. */
  hasSnapshot: boolean;
  stamp: EvidenceStamp;
  gradedAt: string | null;
  defectCount: number;
}

export async function planEvidence(
  ownerId: string,
  orderId: string,
  complaint: string,
): Promise<EvidenceContext | null> {
  try {
    const { data: sale } = await supabaseAdmin
      .from("sales")
      .select("inventory_item_id, listing_id")
      .eq("user_id", ownerId)
      .eq("platform_order_id", orderId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const itemId = (sale as { inventory_item_id?: string } | null)?.inventory_item_id;
    if (!itemId) return null;

    const { data: grading } = await supabaseAdmin
      .from("flipdesk_grading_submissions")
      .select("submission_id")
      .eq("inventory_item_id", itemId)
      .not("submission_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const submissionId = (grading as { submission_id?: string } | null)?.submission_id;
    if (!submissionId) return null;

    const { data: report } = await supabaseAdmin
      .from("grade_reports")
      .select("defects_found, certificate_id, overall_score, grade_tier, created_at")
      .eq("submission_id", submissionId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    const row = report as
      | {
        defects_found?: unknown;
        certificate_id?: string | null;
        overall_score?: number | string | null;
        grade_tier?: string | null;
        created_at?: string | null;
      }
      | null;
    const defects = (row?.defects_found ?? []) as ReportedDefect[];
    if (!Array.isArray(defects) || defects.length === 0) return null;

    const listingId = (sale as { listing_id?: string } | null)?.listing_id ?? null;
    // Through the funnel module, not straight at the table. US-2704's coverage
    // guard caught the direct read here and was right to: one module owning the
    // table is what keeps `published_at DESC` from being re-derived by a reader
    // who would hand a dispute pack the wrong revision.
    let snapshot: PublicationSnapshot | null = null;
    if (listingId) {
      const row = await latestPublication(supabaseAdmin, listingId, ownerId);
      if (row) {
        snapshot = {
          description: row.description,
          aspects: row.aspects,
          publishedAt: row.published_at,
          lastConfirmedAt: row.last_confirmed_at,
        };
      }
    }

    const { matches } = matchComplaint(complaint, defects);
    const plan = buildEvidencePlan({ defects, snapshot, matches });
    return {
      plan,
      hasSnapshot: snapshot !== null,
      // The facts the evidence sheet burns in. Carried out of here because this
      // is the only place that already loaded the report — a second read would
      // be a second chance to pick a different revision of it.
      stamp: {
        certificateNumber: row?.certificate_id ?? null,
        overallScore: Number(row?.overall_score ?? Number.NaN),
        gradeTier: String(row?.grade_tier ?? ""),
      },
      gradedAt: row?.created_at ?? null,
      defectCount: defects.length,
    };
  } catch (err) {
    console.error(
      "[ebay.returns.evidence] could not build the plan:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}
