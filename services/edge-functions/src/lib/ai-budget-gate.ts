// US-895 follow-up: INLINE AI budget kill-switch (cached).
//
// The cron guardrail (routes/jobs-ai-budget.ts) evaluates ai_budget_status() and
// flips a feature kill-switch off when a hard USD budget is breached — but only
// at its tick interval, so spend can overshoot between ticks. This module adds a
// cheap, cached inline check the high-volume grading path can call on EVERY
// request so a breach short-circuits within CACHE_TTL_MS (seconds), not minutes.
//
// It reuses the SAME ai_budget_status() source of truth the cron uses, so the two
// never disagree. On error it DEGRADES rather than failing fully open (US-2013):
// the last known kill set is retained, so a read failure can never un-kill a
// feature whose hard ceiling was already hit, while features with no known
// breach keep working — the cron + the feature flag remain the authoritative
// backstops and a transient DB blip must not halt all AI. Only budgets with
// action='kill' hard-block here ('alert'/'throttle' do not).
//
// Recovery is automatic: the gate clears as soon as ai_budget_status() reports
// the budget is no longer breached — i.e. the operator raises the limit, disables
// the budget, or the period rolls over. (Re-enabling the flag alone without
// addressing spend doesn't clear it, but the cron would immediately re-kill in
// that case anyway, so the inline gate introduces no new lockout.)

import { supabaseAdmin } from "./supabase.ts";
import type { BudgetStatus } from "./ai-budget.ts";

const CACHE_TTL_MS = 30_000;
let cache: { killed: Set<string>; expires: number } | null = null;
/**
 * US-2013: the last set we successfully read. Retained across errors — see
 * loadKilledFeatures.
 */
let lastKnownKilled: Set<string> = new Set();

/**
 * Reads the budget status. Injectable so the RETENTION behaviour below can be
 * tested without a database — it is the part that is easy to get wrong and
 * whose failure (silently un-killing a breached feature) is invisible.
 * Returns null to mean "could not determine", never an empty success.
 */
export type BudgetStatusReader = () => Promise<BudgetStatus[] | null>;

const defaultReader: BudgetStatusReader = async () => {
  const { data, error } = await supabaseAdmin.rpc("ai_budget_status");
  if (error || !Array.isArray(data)) return null;
  return data as BudgetStatus[];
};

async function loadKilledFeatures(
  now: number,
  read: BudgetStatusReader = defaultReader,
): Promise<Set<string>> {
  if (cache && cache.expires > now) return cache.killed;

  let killed: Set<string> | null = null;
  try {
    const rows = await read();
    if (rows !== null) {
      const fresh = new Set<string>();
      for (const s of rows) {
        if (s.enabled && s.breached && s.action === "kill") fresh.add(s.feature);
      }
      killed = fresh;
    }
  } catch {
    // fall through to the retained set below
  }

  if (killed === null) {
    // US-2013: RETAIN the last known kill set instead of caching an EMPTY one.
    //
    // The old behaviour did not merely "fail open" — on any read error it cached
    // an empty set for the TTL, which ACTIVELY ERASED a known breach. A feature
    // whose hard USD ceiling had already been hit silently resumed spending for
    // 30s per failed read, for as long as the outage lasted.
    //
    // That mattered because it was CORRELATED: the per-user rate limiters read
    // the same Postgres, so one degradation removed the per-user cap and the
    // hard spend cap together, while Anthropic stayed up and billable.
    //
    // Blanket fail-CLOSED (block everything when unreadable) was considered and
    // rejected: the header's reasoning still holds — a transient blip must not
    // halt all AI, and the cron plus the feature flag remain the authoritative
    // backstops. Retaining is strictly better than either extreme. A feature we
    // KNOW is breached stays blocked; a feature we have no reason to block keeps
    // working. An error can no longer un-kill anything.
    //
    // The retained set is not refreshed here, so recovery still happens on the
    // first SUCCESSFUL read — an operator raising the limit is reflected within
    // one TTL, exactly as before.
    killed = lastKnownKilled;
    console.warn(
      `[ai-budget-gate] status read failed — retaining ${killed.size} known ` +
        `killed feature(s) rather than clearing the gate`,
    );
  } else {
    lastKnownKilled = killed;
  }

  cache = { killed, expires: now + CACHE_TTL_MS };
  return killed;
}

/**
 * True when `feature` has an enabled, action='kill' budget that is currently
 * breached — i.e. its hard USD ceiling has been hit and the feature should be
 * paused. Cached for CACHE_TTL_MS. On a read error the last known kill set is
 * RETAINED (US-2013) — an error can never clear an existing block.
 */
export async function isAiBudgetExhausted(
  feature: string,
  read?: BudgetStatusReader,
): Promise<boolean> {
  return (await loadKilledFeatures(Date.now(), read)).has(feature);
}

/** Drop the cache (e.g. after an admin changes a budget) so the next call is fresh. */
export function clearAiBudgetGateCache(): void {
  cache = null;
  // US-2013: also drop the retained set. An admin editing a budget is an
  // authoritative signal that the old verdict is stale — keeping it would make
  // "I raised the limit" not take effect until the next successful read.
  lastKnownKilled = new Set();
}

/**
 * TEST SEAM (US-2013): expire the TTL cache while KEEPING the retained
 * last-known kill set — i.e. simulate the next request after the cache window
 * lapses, which is the only state in which retention is observable.
 *
 * clearAiBudgetGateCache() deliberately drops BOTH (an admin budget edit must
 * not leave a stale verdict), so it cannot be used to test retention. Without
 * this seam a retention test silently reads the TTL cache instead and passes
 * for the wrong reason — which is exactly what the first draft of
 * ai-budget-gate_test.ts did.
 */
export function expireAiBudgetGateCacheForTest(): void {
  cache = null;
}

/** Standard 503 body for a feature paused by a hard budget breach. */
export function aiBudgetExceededBody(feature: string): { error: string; code: string } {
  return {
    error: `${feature === "grading" ? "Grading" : "This feature"} is temporarily paused due to capacity limits. Please try again shortly.`,
    code: "AI_BUDGET_EXCEEDED",
  };
}
