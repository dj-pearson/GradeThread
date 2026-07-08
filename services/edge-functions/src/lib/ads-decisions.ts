// US-1702: recommendation review workflow — approve / dismiss / snooze.
//
// The state machine: proposed → approved (→ applied/failed via US-1703) |
// dismissed | snoozed. Actionable states are proposed, approved, and snoozed —
// an operator can always wake or re-decide a snoozed rec early (that IS the
// un-snooze control); applied/dismissed/failed are terminal. Approval is the
// apply-gate, so only an executable (non-report-only) rec may be approved. Every
// decision is recorded as an action='decision' row in ads_change_audit (actor +
// payload snapshot). The pure transition helpers are unit-tested; the DB write
// takes an injected client.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isExecutableChangeType } from "./google-ads-mutate.ts";
import { isAppleExecutableChangeType } from "./apple-search-ads-mutate.ts";

export type RecStatus = "proposed" | "approved" | "applied" | "dismissed" | "snoozed" | "failed";
export type Decision = "approve" | "dismiss" | "snooze";

/**
 * Can a recommendation in `status` be decided now? Actionable states are
 * proposed, approved, and snoozed. A snoozed rec is always decidable so the
 * operator can un-snooze (approve), dismiss, or re-snooze it early — the whole
 * point of the un-snooze affordance. Applied/dismissed/failed are terminal.
 */
export function canDecide(status: string): boolean {
  return status === "proposed" || status === "approved" || status === "snoozed";
}

/** Is this change type actually pushable to its platform (vs report-only)? */
export function isExecutable(platform: string, changeType: string): boolean {
  return platform === "apple_search_ads"
    ? isAppleExecutableChangeType(changeType)
    : isExecutableChangeType(changeType);
}

export function nextStatus(decision: Decision): RecStatus {
  return decision === "approve" ? "approved" : decision === "dismiss" ? "dismissed" : "snoozed";
}

/** Only an APPROVED recommendation is eligible for US-1703's apply. */
export function isApplyable(status: string): boolean {
  return status === "approved";
}

interface DecisionRec {
  id: string;
  platform: string;
  change_type: string;
  target_type: string | null;
  target_resource: string;
  status: string;
  snooze_until: string | null;
  dismiss_reason: string | null;
  payload: Record<string, unknown> | null;
}

export interface DecisionResult {
  ok: boolean;
  message?: string;
  status?: RecStatus;
  httpStatus: number;
}

/**
 * Apply a review decision: validate the transition, update the recommendation
 * status (+ snooze_until / dismiss_reason), and write the decision audit row.
 */
export async function recordDecision(
  supabase: SupabaseClient,
  opts: { recId: string; decision: Decision; actorUserId: string | null; reason?: string | null; until?: string | null },
): Promise<DecisionResult> {
  const { data, error } = await supabase
    .from("ads_recommendations")
    .select("id, platform, change_type, target_type, target_resource, status, snooze_until, dismiss_reason, payload")
    .eq("id", opts.recId)
    .maybeSingle();
  if (error || !data) return { ok: false, message: "Recommendation not found.", httpStatus: 404 };
  const rec = data as DecisionRec;

  if (!canDecide(rec.status)) {
    return { ok: false, message: `A ${rec.status} recommendation can't be ${opts.decision}d.`, httpStatus: 409 };
  }
  if (opts.decision === "snooze" && !opts.until) {
    return { ok: false, message: "Snooze requires an 'until' date.", httpStatus: 400 };
  }
  // Approval is the apply-gate; a report-only rec can never be applied, so it
  // must never reach 'approved' (else it strands in a dead, un-exitable state).
  if (opts.decision === "approve" && !isExecutable(rec.platform, rec.change_type)) {
    return { ok: false, message: "This recommendation is report-only and can't be approved.", httpStatus: 422 };
  }

  const status = nextStatus(opts.decision);
  const patch: Record<string, unknown> = { status };
  if (opts.decision === "snooze") patch.snooze_until = opts.until;
  if (opts.decision === "dismiss") patch.dismiss_reason = opts.reason ?? null;
  if (opts.decision === "approve") { patch.snooze_until = null; }

  // Atomic guard: only write if the status is still what we read. If a concurrent
  // path (e.g. an apply flipping approved→applied) changed it, match 0 rows and
  // 409 instead of silently clobbering the newer state.
  const upd = await supabase
    .from("ads_recommendations")
    .update(patch)
    .eq("id", rec.id)
    .eq("status", rec.status)
    .select("id");
  if (upd.error) return { ok: false, message: "Couldn't record the decision.", httpStatus: 500 };
  if (!upd.data || upd.data.length === 0) {
    return { ok: false, message: "This recommendation changed since it loaded — refresh and try again.", httpStatus: 409 };
  }

  // Decision audit row (actor + snapshot) in the existing ledger. The audit IS
  // the point of this workflow — if it fails, undo the status flip so we never
  // leave an unaudited state change.
  const audit = await supabase.from("ads_change_audit").insert({
    platform: rec.platform,
    recommendation_id: rec.id,
    change_type: rec.change_type,
    target_type: rec.target_type,
    target_resource: rec.target_resource,
    dry_run: false,
    success: true,
    action: "decision",
    result: { decision: opts.decision, reason: opts.reason ?? null, until: opts.until ?? null, payload: rec.payload ?? {} },
    owner_user_id: opts.actorUserId,
  });
  if (audit.error) {
    await supabase
      .from("ads_recommendations")
      .update({ status: rec.status, snooze_until: rec.snooze_until, dismiss_reason: rec.dismiss_reason })
      .eq("id", rec.id)
      .eq("status", status);
    console.error("recordDecision: audit insert failed; reverted status", audit.error);
    return { ok: false, message: "Couldn't record the decision. Please try again.", httpStatus: 500 };
  }

  return { ok: true, status, httpStatus: 200 };
}
