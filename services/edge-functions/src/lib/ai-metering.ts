// US-1581: the ONE reserve/refund contract for user-billed AI actions.
//
// Every Anthropic call a USER triggers must count against their monthly
// AI-action allotment through the atomic `reserve_ai_action` CAS (migration
// 00087): reserve BEFORE the model call, refund if the work it paid for
// throws. Before this module, three copies of the primitives lived in
// flipdesk-ai.ts / flipdesk-autolister.ts / raw rpc() calls in flipdesk-scout,
// and several vision endpoints used the deprecated non-atomic
// checkQuota()→increment_ai_actions() flow — which both TOCTOU-raced past the
// cap and, on some endpoints, never checked a cap at all.
//
// Deliberately UNMETERED model calls (billed elsewhere or operator cost) are
// allow-listed in src/tests/ai-metering-coverage_test.ts — the drift test that
// fails CI when a new route imports a model-calling lib without metering.
//
// NOT for grading: the grading pipeline bills per-grade credits
// (grades_used_this_month / credit ledger), a separate system on purpose.

import { supabaseAdmin } from "./supabase.ts";

/** Consistent 429 body for an exhausted monthly allowance. */
export const QUOTA_EXHAUSTED_MESSAGE =
  "You've used all your AI actions for this month. Your allowance resets at the start of next month.";

/** Same wall, but the seller can buy their way past it right now (US-3138). */
export const QUOTA_EXHAUSTED_TOP_UP_MESSAGE =
  "You've used all your AI actions for this month. Top up with Action Credits, " +
  "or upgrade your plan.";

/**
 * The seller's own cap is what bit, not the plan's. Deliberately a DIFFERENT
 * message with no top-up offer: users.ai_action_limit exists to stop runaway
 * spend, so answering it with "buy more" is the opposite of what it is for.
 */
export const SELF_CAP_REACHED_MESSAGE =
  "You've reached the AI-action limit you set for yourself. Raise it in Settings " +
  "to keep going.";

/**
 * US-3138: what a caller is authorized to spend.
 *
 * `limit` is the effective monthly cap, already min(plan, self-cap), and -1
 * means unlimited. `allowCredits` says whether an exhausted allowance may fall
 * through to the Action Credit wallet.
 *
 * allowCredits exists because by the time a limit reaches this layer the plan
 * cap and the seller's self-imposed cap have been collapsed into one number, so
 * nothing downstream can tell which one bit. Only checkQuota knows, and hitting
 * your OWN limit must never silently spend money.
 */
export interface AiSpendAuthority {
  limit: number;
  allowCredits: boolean;
}

/** Which pocket paid for a reserved action. 'exhausted' means nothing did. */
export type AiSpendSource = "allowance" | "credits" | "exhausted";

/**
 * A bare number stays accepted and means "plan cap, credits allowed", which is
 * the correct reading for every caller that predates the self-cap distinction.
 */
export function toSpendAuthority(
  authority: number | AiSpendAuthority,
): AiSpendAuthority {
  return typeof authority === "number"
    ? { limit: authority, allowCredits: true }
    : authority;
}

/**
 * Has users.ai_actions_used_this_month rolled over — i.e. is the stored counter
 * left from a PRIOR calendar month, making the effective usage 0?
 *
 * US-2179: the authority is reserve_ai_action (migration 00087), which rolls the
 * counter over lazily — nothing zeroes it at midnight on the 1st, so every READER
 * has to apply the same rollover or it reports a user pinned at their cap into
 * the new month. This is the single TS mirror of that SQL predicate
 * (`date_trunc('month', reset_at) < date_trunc('month', now())`), shared by
 * plan-gate's readUsage, flipdesk-ai's checkQuota, and the billing-summary usage
 * meter — three readers that each had (or lacked) their own copy.
 *
 * Compared in UTC to match date_trunc under the DB's UTC session timezone.
 */
export function aiActionsRolledOver(
  resetAt: string | Date | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!resetAt) return false;
  const reset = resetAt instanceof Date ? resetAt : new Date(resetAt);
  if (Number.isNaN(reset.getTime())) return false;
  if (reset.getUTCFullYear() < now.getUTCFullYear()) return true;
  return (
    reset.getUTCFullYear() === now.getUTCFullYear() &&
    reset.getUTCMonth() < now.getUTCMonth()
  );
}

/** Effective AI actions used this month, honoring the lazy monthly rollover. */
export function effectiveAiActionsUsed(
  usedThisMonth: number | null | undefined,
  resetAt: string | Date | null | undefined,
  now: Date = new Date(),
): number {
  return aiActionsRolledOver(resetAt, now) ? 0 : (usedThisMonth ?? 0);
}

/**
 * Atomically reserve one AI action: monthly allowance first, then the Action
 * Credit wallet, then refuse. Returns WHICH pocket paid. THROWS on an rpc
 * failure — callers decide whether that maps to fail-closed or a surfaced
 * error. Most callers want `reserveAiActionSafe`.
 *
 * The fallback lives inside reserve_ai_action_v2's own users-row lock (00763),
 * not here, because a check-then-act pair at this boundary races and a wallet
 * debit issued from TypeScript after a separate cap read can double-spend.
 */
export async function reserveAiActionSource(
  ownerId: string,
  authority: number | AiSpendAuthority,
): Promise<AiSpendSource> {
  const { limit, allowCredits } = toSpendAuthority(authority);
  const { data, error } = await supabaseAdmin.rpc("reserve_ai_action_v2", {
    p_user_id: ownerId,
    p_limit: limit,
    p_allow_credits: allowCredits,
  });
  if (error) throw new Error(`Quota reservation failed: ${error.message}`);
  return data === "allowance" || data === "credits" ? data : "exhausted";
}

/**
 * Reserve one AI action. True when something paid for it, from either pocket.
 * THROWS on an rpc failure; most callers want `reserveAiActionSafe`.
 */
export async function reserveAiAction(
  ownerId: string,
  authority: number | AiSpendAuthority,
): Promise<boolean> {
  return (await reserveAiActionSource(ownerId, authority)) !== "exhausted";
}

/**
 * Fail-CLOSED reserve: an rpc error logs and reads as "not reserved" — a
 * broken counter must never hand out free, over-cap actions.
 */
export async function reserveAiActionSafe(
  ownerId: string,
  authority: number | AiSpendAuthority,
): Promise<boolean> {
  try {
    return await reserveAiAction(ownerId, authority);
  } catch (err) {
    console.error(
      "[ai-metering] reserve_ai_action failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/**
 * Return a reserved action to whichever pocket paid for it.
 *
 * The signature is deliberately unchanged from before Action Credits, because
 * about thirty call sites use it and none of them know the source. The routing
 * is decided in SQL: refund_ai_action (00763) reads
 * users.ai_actions_credit_paid_this_month and returns a credit to the wallet
 * while any credit-paid action remains this month, otherwise decrements the
 * monthly counter as it always did. Credits are only ever spent AFTER the
 * allowance is gone, so LIFO is the right reading.
 */
export async function refundAiAction(ownerId: string): Promise<void> {
  const { error } = await supabaseAdmin.rpc("refund_ai_action", {
    p_user_id: ownerId,
  });
  if (error) {
    console.error("[ai-metering] refund_ai_action failed:", error.message);
  }
}

/** Thrown by withAiAction when the monthly allowance is exhausted. */
export class AiQuotaExhaustedError extends Error {
  constructor() {
    super(QUOTA_EXHAUSTED_MESSAGE);
    this.name = "AiQuotaExhaustedError";
  }
}

interface MeterDeps {
  reserve: (
    ownerId: string,
    authority: number | AiSpendAuthority,
  ) => Promise<boolean>;
  refund: (ownerId: string) => Promise<void>;
}

/**
 * Run one billed AI action under the reserve/refund contract:
 *  - reserve atomically first (fail-closed); throws AiQuotaExhaustedError at
 *    the cap so callers map it to a 429 with QUOTA_EXHAUSTED_MESSAGE,
 *  - run the model work,
 *  - refund the action if the work throws (the failure is not the user's
 *    spend), then rethrow the original error.
 *
 * `deps` is injectable for tests only.
 */
export async function withAiAction<T>(
  ownerId: string,
  authority: number | AiSpendAuthority,
  fn: () => Promise<T>,
  deps: MeterDeps = { reserve: reserveAiActionSafe, refund: refundAiAction },
): Promise<T> {
  const reserved = await deps.reserve(ownerId, authority);
  if (!reserved) throw new AiQuotaExhaustedError();
  try {
    return await fn();
  } catch (err) {
    await deps.refund(ownerId);
    throw err;
  }
}
