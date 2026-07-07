// US-1702: recommendation review workflow — approve / dismiss / snooze.
//
// The state machine: proposed → approved (→ applied/failed via US-1703) |
// dismissed | snoozed. Only 'proposed' (or a snoozed rec whose snooze_until has
// passed) can be decided; applied/dismissed are terminal. Every decision is
// recorded as an action='decision' row in ads_change_audit (actor + payload
// snapshot). The pure transition helpers are unit-tested; the DB write takes an
// injected client.

import type { SupabaseClient } from "@supabase/supabase-js";

export type RecStatus = "proposed" | "approved" | "applied" | "dismissed" | "snoozed" | "failed";
export type Decision = "approve" | "dismiss" | "snooze";

/**
 * Can a recommendation in `status` be decided now? Only actionable states
 * (proposed, or snoozed once `snoozeUntil` has passed). Applied/dismissed are
 * terminal; approved can be re-decided (e.g. dismissed before it applies).
 */
export function canDecide(status: string, snoozeUntil: string | null = null, now: Date = new Date()): boolean {
  if (status === "proposed" || status === "approved") return true;
  if (status === "snoozed") {
    // A snooze that hasn't elapsed yet is still "asleep" — not actionable.
    return snoozeUntil == null || new Date(snoozeUntil).getTime() <= now.getTime();
  }
  return false; // applied / dismissed / failed
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
    .select("id, platform, change_type, target_type, target_resource, status, snooze_until, payload")
    .eq("id", opts.recId)
    .maybeSingle();
  if (error || !data) return { ok: false, message: "Recommendation not found.", httpStatus: 404 };
  const rec = data as DecisionRec;

  if (!canDecide(rec.status, rec.snooze_until)) {
    return { ok: false, message: `A ${rec.status} recommendation can't be ${opts.decision}d.`, httpStatus: 409 };
  }
  if (opts.decision === "snooze" && !opts.until) {
    return { ok: false, message: "Snooze requires an 'until' date.", httpStatus: 400 };
  }

  const status = nextStatus(opts.decision);
  const patch: Record<string, unknown> = { status };
  if (opts.decision === "snooze") patch.snooze_until = opts.until;
  if (opts.decision === "dismiss") patch.dismiss_reason = opts.reason ?? null;
  if (opts.decision === "approve") { patch.snooze_until = null; }
  const upd = await supabase.from("ads_recommendations").update(patch).eq("id", rec.id);
  if (upd.error) return { ok: false, message: "Couldn't record the decision.", httpStatus: 500 };

  // Decision audit row (actor + snapshot) in the existing ledger.
  await supabase.from("ads_change_audit").insert({
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

  return { ok: true, status, httpStatus: 200 };
}
