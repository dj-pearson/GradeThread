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
 * Atomically reserve one AI action against the monthly cap (-1 = unlimited).
 * Returns true when reserved, false at the cap. THROWS on an rpc failure —
 * callers decide whether that maps to fail-closed (treat as unreserved) or a
 * surfaced error. Most callers want `reserveAiActionSafe`.
 */
export async function reserveAiAction(
  ownerId: string,
  limit: number,
): Promise<boolean> {
  const { data, error } = await supabaseAdmin.rpc("reserve_ai_action", {
    p_user_id: ownerId,
    p_limit: limit,
  });
  if (error) throw new Error(`Quota reservation failed: ${error.message}`);
  return data === true;
}

/**
 * Fail-CLOSED reserve: an rpc error logs and reads as "not reserved" — a
 * broken counter must never hand out free, over-cap actions.
 */
export async function reserveAiActionSafe(
  ownerId: string,
  limit: number,
): Promise<boolean> {
  try {
    return await reserveAiAction(ownerId, limit);
  } catch (err) {
    console.error(
      "[ai-metering] reserve_ai_action failed:",
      err instanceof Error ? err.message : String(err),
    );
    return false;
  }
}

/** Return a reserved action to the pool when the work it paid for failed. */
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
  reserve: (ownerId: string, limit: number) => Promise<boolean>;
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
  limit: number,
  fn: () => Promise<T>,
  deps: MeterDeps = { reserve: reserveAiActionSafe, refund: refundAiAction },
): Promise<T> {
  const reserved = await deps.reserve(ownerId, limit);
  if (!reserved) throw new AiQuotaExhaustedError();
  try {
    return await fn();
  } catch (err) {
    await deps.refund(ownerId);
    throw err;
  }
}
