// US-3068: the evidence pack, answered from a return id.
//
// The extension sits on an eBay Seller Hub return page. It has the RETURN id
// from the URL and nothing else, because US-3042's rule holds here too: on eBay
// the only thing read off the page is an id, and everything else comes from
// eBay's API through our server.
//
// ⚠ THE STORY'S OWN AC2 DOES NOT WORK, and this module is the correction.
//
//  1. It says to call the SEND route with a "preview flag". Preview is a
//     separate route on purpose — the send route's header says why: two routes
//     that must agree about a verdict, with the rarer path holding the one
//     nobody re-checked. That is the gap US-2707 exists to close, and a preview
//     mode on the send route is the same mistake wearing a flag.
//
//  2. The existing preview needs `{ order_id, complaint }`. planEvidence starts
//     from `sales.platform_order_id` and matches the buyer's complaint text
//     against the report's defects. The extension has neither, and AC1 forbids
//     it from scraping the page to find them.
//
//  3. It says the route is reached through extensionOrUserAuthMiddleware.
//     /api/flipdesk/ebay/* is mounted with ebayAuthMiddleware, which falls
//     through to a user JWT — an extension token is refused there.
//
// So the gap closes SERVER-SIDE, using a row that already exists.
// `marketplace_post_sale_cases` carries the return id, the order id and the
// buyer's stated reason, all tenant-scoped, so a return id resolves to exactly
// the two things planEvidence wants without the extension reading anything.
//
// ONE PLANNER STILL. This resolves inputs and then calls the same
// `planEvidence` the post-sale surface calls. It decides no verdict of its own.

import { supabaseAdmin } from "./supabase.ts";
import { type EvidenceContext, planEvidence } from "./evidence-plan.ts";
import type { Citation } from "./dispute-evidence.ts";

/** What a return id resolves to, or null when this workspace has no such case. */
export interface ReturnCaseRef {
  orderId: string;
  /** The buyer's stated reason. planEvidence matches it against the defects. */
  complaint: string;
  itemExternalId: string | null;
}

/**
 * eBay return ids are opaque strings. Bounded and character-checked before they
 * reach a query — not because the client is parameterised (it is), but because
 * an unbounded id from a URL is a thing to say no to on sight.
 */
const RETURN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

export function isPlausibleReturnId(v: unknown): v is string {
  return typeof v === "string" && RETURN_ID_RE.test(v);
}

/**
 * The order and complaint behind a return, for this workspace only.
 *
 * Null means "no case row this workspace owns", which is the same answer for a
 * return that belongs to somebody else and a return we have never synced. That
 * is deliberate: distinguishing them would tell a caller whether an id exists,
 * and the id came off a page anyone can open.
 */
export async function resolveReturnCase(
  ownerId: string,
  returnId: string,
): Promise<ReturnCaseRef | null> {
  if (!isPlausibleReturnId(returnId)) return null;
  const { data, error } = await supabaseAdmin
    .from("marketplace_post_sale_cases")
    .select("external_order_id, item_external_id, reason")
    .eq("user_id", ownerId) // US-268
    .eq("case_type", "return")
    .eq("external_id", returnId)
    .maybeSingle();
  if (error) return null;
  const row = data as
    | { external_order_id?: string | null; item_external_id?: string | null; reason?: string | null }
    | null;
  const orderId = (row?.external_order_id ?? "").trim();
  const complaint = (row?.reason ?? "").trim();
  if (!orderId || !complaint) return null;
  return { orderId, complaint, itemExternalId: row?.item_external_id ?? null };
}

/**
 * What the overlay renders. A closed set of verdicts, because the extension
 * picks its wording from a table rather than printing anything the server sent
 * (US-9111: no untrusted string reaches overlay copy).
 */
export type ShieldVerdict = "assemble" | "refuse-undisclosed" | "no-report";

export interface ShieldAnswer {
  verdict: ShieldVerdict;
  /** Absent on no-report. Everything below is drawn from the grade report. */
  certificateNumber?: string | null;
  gradedAt?: string | null;
  defectCount?: number;
  hasPublicationSnapshot?: boolean;
  /**
   * The citations the pack would make. Empty on a refusal.
   *
   * ⚠ TYPED, NOT FREE TEXT, and the buyer's complaint is NOT here. AC5 applies
   * the US-9111 untrusted-string rule to overlay copy, and the genuinely
   * untrusted string on this page is what the BUYER wrote. A citation quotes
   * our own grade report and the seller's own published listing — both of which
   * the seller may read back — but the complaint never leaves the server.
   */
  citations?: Citation[];
}

/**
 * Turn a planner context into the answer the overlay renders.
 *
 * Pure, so the three renders can be tested without a database.
 *
 * A NULL CONTEXT IS "no-report", NOT AN ERROR. planEvidence returns null for a
 * return with no graded item, no submission, no report, or no recorded defects
 * — and the honest answer to all of those is the same: there is nothing here to
 * argue with. Dressing it as a failure would put a retry in front of a seller
 * for a pack that will never exist.
 */
export function shieldAnswerFrom(context: EvidenceContext | null): ShieldAnswer {
  if (!context) return { verdict: "no-report" };

  // ⚠ THE REFUSAL IS THE POINT OF THE FEATURE, not an edge case. A pack that
  // would argue from a defect the listing never disclosed is a pack that proves
  // the buyer right. US-2703's constraint: it refuses to assemble, and the
  // surface tells the seller to consider a refund instead.
  const verdict: ShieldVerdict = context.plan.mayAutoAssemble
    ? "assemble"
    : "refuse-undisclosed";

  return {
    verdict,
    certificateNumber: context.stamp.certificateNumber,
    gradedAt: context.gradedAt,
    defectCount: context.defectCount,
    hasPublicationSnapshot: context.hasSnapshot,
    // Nothing to copy on a refusal, so nothing is sent.
    citations: verdict === "assemble" ? context.plan.citations : [],
  };
}

/** The whole read: return id in, renderable answer out. */
export async function returnShieldAnswer(
  ownerId: string,
  returnId: string,
): Promise<ShieldAnswer> {
  const ref = await resolveReturnCase(ownerId, returnId);
  if (!ref) return { verdict: "no-report" };
  return shieldAnswerFrom(await planEvidence(ownerId, ref.orderId, ref.complaint));
}
