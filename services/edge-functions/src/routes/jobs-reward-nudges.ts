// US-1859: the re-engagement nudge sweep.
//
// A cron rather than a lazy read, unlike quests and season rollover. The reason
// is the whole point of the feature: quests are evaluated when the user opens
// their rewards screen, and a LAPSING user is by definition not opening it. The
// one surface that has to reach people who are away cannot be triggered by them.
//
// The run has two halves and they are independent:
//   1. SWEEP — for a bounded set of recently-active accounts, evaluate one nudge
//      each (or record a holdout row) via lib/rewards-nudges.ts.
//   2. ATTRIBUTE — score open sends, INCLUDING the holdout rows, against the
//      same conversion rule, so the lift report has both arms.
//
// Bounded by construction: MAX_USERS per side, one candidate per user, and the
// engine's own frequency cap means most evaluated users produce nothing. Failing
// half-way is safe — the UNIQUE (user_id, type, subject, period) claim makes the
// next run pick up where this one stopped without re-notifying anyone.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { requireJobSecret } from "../lib/job-auth.ts";
import { acquireJobLock } from "../lib/job-lock.ts";
import { buildRunContext, nudgeUser, runAttributionPass } from "../lib/rewards-nudges.ts";
import {
  completedYears,
  loadAnniversaryDueUsers,
  loadLoyaltyStanding,
  markAnniversaryDelivered,
} from "../lib/rewards-loyalty.ts";
import { readRewardState } from "../lib/rewards-engine.ts";
import { grantTangibleRewards } from "../lib/rewards-tangible.ts";

/** Per side. A sweep that tried to reach every account would be a sweep that
 *  times out; the cap is a working set, and the engine re-reads it every run. */
const MAX_USERS = 400;
const DAY_MS = 86_400_000;

/**
 * Who is worth evaluating.
 *
 * SELLERS: accounts with a `user_reward_state` row — a row exists only after a
 * first rewardable act, so this is "people who have engaged at least once",
 * which is exactly the population a re-engagement nudge is for. Ordered by
 * `updated_at` DESC so the working set is the recently-warm end rather than a
 * long-cold tail nothing will bring back.
 *
 * BUYERS: accounts with a confirmation in the recent window — the streak nudge
 * needs an existing chain, so an account with no recent confirmation has nothing
 * at risk and nothing to say.
 */
async function loadCandidateUsers(nowMs: number): Promise<{
  sellers: string[];
  buyers: Set<string>;
}> {
  const [stateRes, outcomeRes] = await Promise.all([
    supabaseAdmin
      .from("user_reward_state")
      .select("user_id")
      .order("updated_at", { ascending: false })
      .limit(MAX_USERS),
    supabaseAdmin
      .from("grade_outcomes")
      .select("buyer_user_id")
      .eq("match_status", "confirmed")
      .gte("created_at", new Date(nowMs - 70 * DAY_MS).toISOString())
      .not("buyer_user_id", "is", null)
      .order("created_at", { ascending: false })
      .limit(5000),
  ]);

  if (stateRes.error) {
    console.error("[reward-nudges] seller candidate load failed:", stateRes.error.message);
  }
  if (outcomeRes.error) {
    console.error("[reward-nudges] buyer candidate load failed:", outcomeRes.error.message);
  }

  const sellers = ((stateRes.data ?? []) as Array<{ user_id: string }>).map((r) => r.user_id);
  const buyers = new Set<string>();
  for (const r of (outcomeRes.data ?? []) as Array<{ buyer_user_id: string | null }>) {
    if (r.buyer_user_id && buyers.size < MAX_USERS) buyers.add(r.buyer_user_id);
  }
  return { sellers, buyers };
}

/**
 * US-1914: the anniversary pass.
 *
 * It rides THIS cron rather than getting one of its own, for a reason that is
 * about correctness rather than tidiness: an anniversary is a date, so the sweep
 * has to run daily, and this is already the daily reward sweep. A second cron
 * would be a second lock, a second registry entry and a second thing to notice
 * has stopped.
 *
 * The candidate set is the OPPOSITE of the nudge sweep's, and deliberately so:
 * the nudge sweep takes the recently-warm end of user_reward_state, while this
 * one is indexed on anniversary_due_at and finds people precisely BECAUSE they
 * have not been around. A loyalty reward that only reached active users would be
 * an activity reward with a different name.
 *
 * Delivery is grantTangibleRewards — the same rail, the same ceilings, the same
 * guardrails. Nothing here can pay anyone; it can only tell the rail that a year
 * has come round.
 */
async function runAnniversaryPass(
  nowMs: number,
): Promise<{ anniversary_checked: number; anniversary_granted: number }> {
  let granted = 0;
  const due = await loadAnniversaryDueUsers(nowMs);
  for (const row of due) {
    try {
      const standing = await loadLoyaltyStanding(row.userId, nowMs);
      if (!standing?.due) {
        // No year owed. If the delivery WINDOW lapsed while the sweep was down,
        // advance the marker so the row stops being due forever — otherwise a
        // handful of missed accounts sit at the head of the index and crowd out
        // everyone whose anniversary is actually today.
        //
        // A PAUSED programme deliberately does NOT advance. Pausing a reward must
        // never quietly consume the year it was paused over.
        const cfg = standing?.config;
        if (cfg?.enabled && cfg.anniversaryEnabled && standing) {
          const years = completedYears(Date.parse(standing.memberSince), nowMs);
          if (years > standing.lastAnniversaryYear) {
            await markAnniversaryDelivered(
              row.userId,
              Date.parse(standing.memberSince),
              years,
              nowMs,
            );
          }
        }
        continue;
      }
      const state = await readRewardState(row.userId);
      const keys = await grantTangibleRewards(
        row.userId,
        state?.xpTotal ?? 0,
        nowMs,
        standing,
      );
      if (keys.some((k) => k.includes(":y"))) granted++;
    } catch (err) {
      console.error(
        `[reward-nudges] anniversary for ${row.userId} failed:`,
        err instanceof Error ? err.message : String(err),
      );
    }
  }
  return { anniversary_checked: due.length, anniversary_granted: granted };
}

export async function handleRewardNudgesCron(c: Context): Promise<Response> {
  if (!(await requireJobSecret(c))) return c.json({ error: "Unauthorized" }, 401);
  const lock = await acquireJobLock("reward-nudges", 600);
  if (!lock.acquired) return c.json({ ok: true, skipped: true, reason: lock.reason });

  try {
    const nowMs = Date.now();
    const ctx = await buildRunContext(nowMs);

    // The attribution pass runs even when the kill-switch is off: sends that
    // already happened still deserve to be scored, and freezing the measurement
    // when the feature is paused is how a paused experiment loses its own data.
    const attribution = await runAttributionPass(ctx.config, nowMs);

    // US-1914: the anniversary pass runs regardless of the NUDGE kill-switch.
    // They are different programmes — pausing "we noticed you were quiet" must
    // not also cancel a thank-you somebody has been a customer for a year to
    // earn. Its own switch is `rewards_loyalty_config.anniversary_enabled`.
    const anniversary = await runAnniversaryPass(nowMs);

    if (!ctx.config.enabled) {
      return c.json({ ok: true, disabled: true, ...attribution, ...anniversary });
    }

    const { sellers, buyers } = await loadCandidateUsers(nowMs);
    const all = new Set<string>([...sellers, ...buyers]);

    let sent = 0;
    let holdout = 0;
    let skipped = 0;
    // Sequential on purpose: each user's evaluation is several round trips and
    // the run has a 10-minute lock, so throughput is not the constraint —
    // predictable load on a shared Postgres during a daily sweep is.
    for (const userId of all) {
      const result = await nudgeUser(userId, ctx, {
        buyer: buyers.has(userId),
        seller: sellers.includes(userId),
      });
      if (result.outcome === "sent") sent++;
      else if (result.outcome === "holdout") holdout++;
      else skipped++;
    }

    return c.json({
      ok: true,
      evaluated: all.size,
      sent,
      holdout,
      skipped,
      ...attribution,
      ...anniversary,
    });
  } catch (err) {
    console.error(
      "[reward-nudges] cron failed:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "Reward-nudges job failed." }, 500);
  }
}
