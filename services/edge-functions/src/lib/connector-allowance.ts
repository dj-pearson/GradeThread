// US-9101: the connector's MONTHLY allowance.
//
// The owner's decision, 2026-08-19: connector write actions get their OWN
// counter rather than sharing aiActionsPerMonth. Sharing is simpler, and it is
// the one thing that cannot be undone later without a repricing — a seller who
// has been told "750 AI actions" cannot be told afterwards that some of them
// were always the connector's.
//
// ── Why there is no new column ───────────────────────────────────────────
//
// mcp_tool_calls already records every call with its owner, its tool and its
// timestamp, and it is already indexed on (owner_user_id, created_at desc). So
// the counter is a COUNT over that table rather than a number to increment,
// which means:
//
//   • no migration, so nothing is held waiting on an operator;
//   • no second source of truth to drift from the audit log;
//   • and no way to spend an action without leaving a row, because the row IS
//     the spend.
//
// The cost is a count per write call instead of a read of one integer. Against
// a partial index on one seller's month that is not the expensive part of a
// publish.
//
// ── What counts ──────────────────────────────────────────────────────────
//
// Only SUCCESSFUL calls to tools that change something. A refused call, a
// preview and a read all cost nothing: charging for "can I?" would teach a
// model to ask less, which is the opposite of what the preview protocol wants.

import { supabaseAdmin } from "./supabase.ts";
import { getPlanMatrix } from "./pricing-config.ts";
import { effectivePlanFor } from "./grade-pricing.ts";
import { redactError } from "./log-redact.ts";
import { debitActionCredits } from "./action-credits.ts";

// deno-lint-ignore no-explicit-any
export type AllowanceDb = any;

export interface AllowanceVerdict {
  allowed: boolean;
  used: number;
  /** -1 means unlimited. */
  limit: number;
  /** ISO time the month rolls over, so a caller can say when to come back. */
  resetsAt: string;
  message?: string;
  /**
   * US-3138: which pocket paid. "credits" means the monthly allowance was gone
   * and an Action Credit covered this call, so the caller should tell the
   * seller -- silently spending a credit they bought is still spending money.
   */
  paidWith?: "allowance" | "credits";
  /**
   * True only when buying Action Credits would actually unblock this call.
   *
   * FALSE when the plan does not include the connector at all: no number of
   * credits opens a feature the tier does not carry, and offering them would be
   * taking money for nothing.
   */
  canTopUp?: boolean;
}

/** The first instant of the next calendar month, in UTC. */
export function monthWindow(nowMs: number): { startIso: string; resetsAtIso: string } {
  const now = new Date(nowMs);
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return { startIso: new Date(start).toISOString(), resetsAtIso: new Date(next).toISOString() };
}

/**
 * How many connector write actions this seller has spent this month.
 *
 * Throws rather than returning 0 when the count is unavailable: the caller
 * fails CLOSED on the write path, and "unknown" must not read as "none" for an
 * allowance that gates publishing.
 */
export async function connectorActionsUsed(
  ownerUserId: string,
  writeToolNames: readonly string[],
  nowMs: number = Date.now(),
  db: AllowanceDb = supabaseAdmin,
): Promise<number> {
  if (writeToolNames.length === 0) return 0;
  const { startIso } = monthWindow(nowMs);

  const { count, error } = await db
    .from("mcp_tool_calls")
    .select("id", { count: "exact", head: true })
    .eq("owner_user_id", ownerUserId)
    .eq("result_status", "ok")
    .in("tool_name", writeToolNames)
    .gte("created_at", startIso);

  if (error) throw new Error(`connector allowance unavailable: ${redactError(error)}`);
  return count ?? 0;
}

/**
 * Would one more write action fit in this seller's plan allowance?
 *
 * Resolved from the EFFECTIVE plan, the same way every other gate resolves it —
 * a paused subscription or an expired trial falls back to Free, where the
 * allowance is zero, so a downgrade actually stops the connector rather than
 * grandfathering it.
 */
/**
 * The wallet fallback, injectable for tests. It goes through supabaseAdmin
 * rather than the `db` above, so without this seam every stubbed test in
 * connector-allowance_test.ts would make a real rpc call to whatever
 * SUPABASE_URL happened to be set to.
 */
export interface AllowanceDeps {
  debit: (ownerUserId: string) => Promise<boolean>;
}

const defaultDeps: AllowanceDeps = {
  debit: (ownerUserId) =>
    debitActionCredits(
      ownerUserId,
      "connector_action",
      "monthly connector allowance exhausted",
    ),
};

export async function checkConnectorAllowance(
  ownerUserId: string,
  writeToolNames: readonly string[],
  nowMs: number = Date.now(),
  db: AllowanceDb = supabaseAdmin,
  deps: AllowanceDeps = defaultDeps,
): Promise<AllowanceVerdict> {
  const { resetsAtIso } = monthWindow(nowMs);

  const { data: userRow } = await db
    .from("users")
    .select("flipdesk_plan, subscription_status, trial_ends_at, past_due_since")
    .eq("id", ownerUserId)
    .maybeSingle();

  const user = userRow as
    | {
      flipdesk_plan: string;
      subscription_status: string | null;
      trial_ends_at: string | null;
      past_due_since: string | null;
    }
    | null;

  if (!user) {
    // Fails CLOSED. A caller we cannot resolve has no allowance.
    return {
      allowed: false,
      used: 0,
      limit: 0,
      resetsAt: resetsAtIso,
      message: "We could not read your plan, so the connector is paused. Try again shortly.",
    };
  }

  const plan = effectivePlanFor(
    user.flipdesk_plan,
    user.subscription_status,
    user.trial_ends_at,
    new Date(nowMs),
    user.past_due_since,
  );
  const matrix = await getPlanMatrix();
  const limit = matrix[plan as keyof typeof matrix]?.connectorActionsPerMonth ?? 0;

  if (limit === -1) {
    return { allowed: true, used: 0, limit: -1, resetsAt: resetsAtIso, paidWith: "allowance" };
  }

  // US-3138: the plan does not carry the connector at all. This is a FEATURE
  // gate, not a volume wall, so it must never reach the wallet -- a credit
  // cannot buy a capability the tier does not include, and charging for one
  // would be taking money for nothing. Handled before the count so a Free
  // seller is not billed a query either.
  if (limit === 0) {
    return {
      allowed: false,
      used: 0,
      limit: 0,
      resetsAt: resetsAtIso,
      canTopUp: false,
      message:
        "The Claude connector is not included in this plan. See https://gradethread.com/pricing.",
    };
  }

  const used = await connectorActionsUsed(ownerUserId, writeToolNames, nowMs, db);
  if (used + 1 > limit) {
    // US-3138: the allowance is gone, but the seller may have prepaid for this.
    // Debiting HERE rather than returning a refusal for the caller to retry is
    // deliberate: this meter has no counter row to lock (the count is a query
    // over mcp_tool_calls), so there is no atomic reserve to push the fallback
    // into. The wallet debit is itself atomic and is the reservation.
    if (await deps.debit(ownerUserId)) {
      return { allowed: true, used, limit, resetsAt: resetsAtIso, paidWith: "credits" };
    }
    return {
      allowed: false,
      used,
      limit,
      resetsAt: resetsAtIso,
      canTopUp: true,
      message: `You have used all ${limit} connector actions for this month. ` +
        `They reset on ${resetsAtIso.slice(0, 10)}. Top up with Action Credits, ` +
        `or upgrade for a bigger monthly allowance.`,
    };
  }

  return { allowed: true, used, limit, resetsAt: resetsAtIso, paidWith: "allowance" };
}
