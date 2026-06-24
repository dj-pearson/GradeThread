// US-895 follow-up: INLINE AI budget kill-switch (cached).
//
// The cron guardrail (routes/jobs-ai-budget.ts) evaluates ai_budget_status() and
// flips a feature kill-switch off when a hard USD budget is breached — but only
// at its tick interval, so spend can overshoot between ticks. This module adds a
// cheap, cached inline check the high-volume grading path can call on EVERY
// request so a breach short-circuits within CACHE_TTL_MS (seconds), not minutes.
//
// It reuses the SAME ai_budget_status() source of truth the cron uses, so the two
// never disagree. FAIL-OPEN on error: the cron + the feature flag remain the
// authoritative backstops and a transient DB blip must not halt all AI. Only
// budgets with action='kill' hard-block here ('alert'/'throttle' do not).
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

async function loadKilledFeatures(now: number): Promise<Set<string>> {
  if (cache && cache.expires > now) return cache.killed;
  const killed = new Set<string>();
  try {
    const { data, error } = await supabaseAdmin.rpc("ai_budget_status");
    if (!error && Array.isArray(data)) {
      for (const s of data as BudgetStatus[]) {
        if (s.enabled && s.breached && s.action === "kill") killed.add(s.feature);
      }
    }
    // On error we cache an empty set for the TTL too — fail-open, and don't
    // hammer the RPC every request during an outage.
  } catch {
    // fail-open
  }
  cache = { killed, expires: now + CACHE_TTL_MS };
  return killed;
}

/**
 * True when `feature` has an enabled, action='kill' budget that is currently
 * breached — i.e. its hard USD ceiling has been hit and the feature should be
 * paused. Cached for CACHE_TTL_MS; fail-open on error.
 */
export async function isAiBudgetExhausted(feature: string): Promise<boolean> {
  return (await loadKilledFeatures(Date.now())).has(feature);
}

/** Drop the cache (e.g. after an admin changes a budget) so the next call is fresh. */
export function clearAiBudgetGateCache(): void {
  cache = null;
}

/** Standard 503 body for a feature paused by a hard budget breach. */
export function aiBudgetExceededBody(feature: string): { error: string; code: string } {
  return {
    error: `${feature === "grading" ? "Grading" : "This feature"} is temporarily paused due to capacity limits. Please try again shortly.`,
    code: "AI_BUDGET_EXCEEDED",
  };
}
