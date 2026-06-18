// US-629 / US-864: referral qualification + reward grant.
//
// Lifecycle of a referral_event.reward_status:
//   pending  → redeemed, awaiting the referred user's first PAID action
//   qualified→ first paid action seen (maybeQualifyReferral)
//   granted  → credits applied to BOTH parties' balances (grantReferralReward)
//
// US-864 closes the loop: qualification now AUTO-GRANTS (it used to stop at
// `qualified` and wait for a manual admin grant). The admin grant endpoint stays
// as an override for the edge cases auto-grant intentionally skips (a party
// suspended after redeeming, or a legacy `qualified` row). Both paths funnel
// through the single grantReferralReward() below, which is the only place that
// moves credit balances — so there is exactly one grant per event and no
// double-grant is possible (it claims the row before granting).

import { supabaseAdmin } from "./supabase.ts";
import { notifyUser } from "./notify.ts";
import { sendReferralRewardEmail } from "./email.ts";
import {
  DEFAULT_REFERRAL_REWARD_CONFIG,
  DEFAULT_REFERRED_SIGNUP_INCENTIVE,
  milestonesReached,
  normalizeReferralRewardConfig,
  normalizeReferredSignupIncentive,
  REFERRAL_REWARD_CONFIG_SETTING_KEY,
  REFERRED_SIGNUP_INCENTIVE_SETTING_KEY,
  type ReferralRewardConfig,
  type ReferredSignupIncentive,
} from "./referral-rewards.ts";
import { getSetting } from "./system-settings.ts";

export type GrantReferralResult =
  | {
    status: "granted";
    referrer_credits: number;
    referred_credits: number;
  }
  | { status: "already_granted" }
  | { status: "not_found" }
  // A party is suspended (US-802) — refuse to move credits to a frozen account.
  | { status: "blocked"; reason: string }
  // US-1069: the referrer hit the admin-configured per-referrer reward cap — the
  // referral qualifies but pays no reward.
  | { status: "capped"; reason: string }
  // US-1069: the referred user qualified after the admin-configured window — the
  // reward is forfeit.
  | { status: "expired"; reason: string }
  | { status: "error"; reason: string };

// US-1069: resolve the admin-configured referral reward economics from
// system_settings (credit sizes, qualification window, per-referrer cap),
// normalized + safe-defaulted. Read through the cached settings registry, so this
// is cheap on the grant/display paths.
export async function getReferralRewardConfig(): Promise<ReferralRewardConfig> {
  const raw = await getSetting<unknown>(
    REFERRAL_REWARD_CONFIG_SETTING_KEY,
    DEFAULT_REFERRAL_REWARD_CONFIG,
  );
  return normalizeReferralRewardConfig(raw);
}

// Best-effort reward notification (in-app + email). Never throws — the credits
// are already granted and the status persisted by the time we get here, so a
// notification failure must not undo or 500 the grant.
async function notifyReward(
  userId: string,
  credits: number,
  isReferrer: boolean,
): Promise<void> {
  try {
    await notifyUser(userId, {
      type: "billing",
      title: "Referral reward added",
      message:
        `${credits} grade credit${credits === 1 ? "" : "s"} were added to your account from a referral.`,
      link: "/dashboard/billing",
    });
    const { data: u } = await supabaseAdmin
      .from("users")
      .select("email, full_name")
      .eq("id", userId)
      .maybeSingle();
    const row = u as { email?: string; full_name?: string | null } | null;
    if (row?.email) {
      await sendReferralRewardEmail(row.email, {
        userName: row.full_name ?? null,
        credits,
        isReferrer,
      });
    }
  } catch (err) {
    console.error(
      "[referrals] reward notify failed:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Grant the referral reward for `eventId` to BOTH parties and mark it granted.
// Idempotent + race-safe: it atomically CLAIMS the row (flips status to granted
// only if it isn't already) BEFORE touching balances, so two concurrent callers
// (e.g. the auto-grant webhook and an admin click) can never both grant. If the
// credit RPC fails after the claim, the claim is rolled back so a retry works.
//
// Safeguards (US-864 AC#4): a suspended referrer or referred user blocks the
// grant — credits never flow to a frozen account. The admin override surfaces
// the same block (it can lift the suspension and retry).
export async function grantReferralReward(
  eventId: string,
): Promise<GrantReferralResult> {
  // US-1069: live, admin-tunable economics (credit sizes, window, cap).
  const config = await getReferralRewardConfig();

  const { data: event } = await supabaseAdmin
    .from("referral_events")
    .select("id, referrer_user_id, referred_user_id, reward_status, created_at, qualified_at")
    .eq("id", eventId)
    .maybeSingle();
  if (!event) return { status: "not_found" };
  const ev = event as {
    id: string;
    referrer_user_id: string;
    referred_user_id: string;
    reward_status: string;
    created_at: string;
    qualified_at: string | null;
  };
  if (ev.reward_status === "granted") return { status: "already_granted" };

  // Fraud safeguard: never reward a suspended account (either side).
  const { data: parties } = await supabaseAdmin
    .from("users")
    .select("id, suspended")
    .in("id", [ev.referrer_user_id, ev.referred_user_id]);
  const suspended = (parties ?? []) as Array<{ id: string; suspended?: boolean }>;
  if (suspended.some((p) => p.suspended)) {
    return { status: "blocked", reason: "A party to this referral is suspended." };
  }

  // US-1069: qualification window — the referred user must have qualified within
  // N days of redeeming. Forfeit (don't grant; leave the row at qualified) if the
  // gap exceeded the window. 0 = no window.
  if (config.qualification_window_days > 0) {
    const redeemedMs = Date.parse(ev.created_at);
    const qualifiedMs = ev.qualified_at ? Date.parse(ev.qualified_at) : Date.now();
    const windowMs = config.qualification_window_days * 86_400_000;
    if (Number.isFinite(redeemedMs) && qualifiedMs - redeemedMs > windowMs) {
      return {
        status: "expired",
        reason: `Referral qualified after the ${config.qualification_window_days}-day window.`,
      };
    }
  }

  // US-1069: per-referrer cap — once a referrer has this many granted referrals,
  // further ones qualify but earn no reward. 0 = unlimited. Counted BEFORE the
  // claim so a re-run stays idempotent (a capped referral never flips to granted).
  if (config.per_referrer_cap > 0) {
    const { count: grantedSoFar } = await supabaseAdmin
      .from("referral_events")
      .select("id", { count: "exact", head: true })
      .eq("referrer_user_id", ev.referrer_user_id)
      .eq("reward_status", "granted");
    if ((grantedSoFar ?? 0) >= config.per_referrer_cap) {
      return {
        status: "capped",
        reason: `Referrer has reached the per-referrer cap of ${config.per_referrer_cap}.`,
      };
    }
  }

  // CLAIM the row: only the caller that flips it off a non-granted status wins.
  const nowIso = new Date().toISOString();
  const { data: claimed, error: claimErr } = await supabaseAdmin
    .from("referral_events")
    .update({
      reward_status: "granted",
      granted_at: nowIso,
      referrer_reward_credits: config.referrer_credits,
      referred_reward_credits: config.referred_credits,
    })
    .eq("id", eventId)
    .neq("reward_status", "granted")
    .select("id");
  if (claimErr) {
    console.error("[referrals] grant claim failed:", claimErr.message);
    return { status: "error", reason: "Could not claim the reward." };
  }
  if (!claimed || claimed.length === 0) {
    // Someone else granted it between our read and our claim.
    return { status: "already_granted" };
  }

  // Apply credits to both balances via the row-locked ledger RPC.
  const grant = (userId: string, credits: number) =>
    supabaseAdmin.rpc("grant_grade_credits", {
      p_user_id: userId,
      p_credits: credits,
      p_reason: "admin_grant",
      p_stripe_payment_intent: null,
      p_notes: `Referral reward (event ${eventId})`,
    });
  const [{ error: e1 }, { error: e2 }] = await Promise.all([
    grant(ev.referrer_user_id, config.referrer_credits),
    grant(ev.referred_user_id, config.referred_credits),
  ]);
  if (e1 || e2) {
    console.error("[referrals] credit grant failed:", e1?.message ?? e2?.message);
    // Roll the claim back to 'qualified' so a retry (auto or admin) can grant.
    await supabaseAdmin
      .from("referral_events")
      .update({
        reward_status: "qualified",
        granted_at: null,
        referrer_reward_credits: null,
        referred_reward_credits: null,
      })
      .eq("id", eventId);
    return { status: "error", reason: "Credit grant failed." };
  }

  await Promise.all([
    notifyReward(ev.referrer_user_id, config.referrer_credits, true),
    notifyReward(ev.referred_user_id, config.referred_credits, false),
  ]);

  // US-1071: now that this grant is committed, check whether the referrer just
  // crossed a milestone tier and owes a one-time bonus. Best-effort — never
  // undoes the grant above.
  await awardReferralMilestones(ev.referrer_user_id);

  return {
    status: "granted",
    referrer_credits: config.referrer_credits,
    referred_credits: config.referred_credits,
  };
}

// US-1071: grant any milestone bonus the referrer has unlocked but not yet been
// paid. Idempotent + race-safe: each bonus is CLAIMED by inserting its
// (user_id, threshold) row (UNIQUE) BEFORE moving credits, so two concurrent
// grant paths can't double-pay a tier. Best-effort — a failure here leaves the
// row unclaimed for a later grant to retry and never breaks the base reward.
export async function awardReferralMilestones(referrerUserId: string): Promise<void> {
  try {
    const { count, error: countErr } = await supabaseAdmin
      .from("referral_events")
      .select("id", { count: "exact", head: true })
      .eq("referrer_user_id", referrerUserId)
      .eq("reward_status", "granted");
    if (countErr) {
      console.error("[referrals] milestone count failed:", countErr.message);
      return;
    }
    const grantedCount = count ?? 0;
    const eligible = milestonesReached(grantedCount);
    if (eligible.length === 0) return;

    // Which tiers were already paid?
    const { data: paidRows } = await supabaseAdmin
      .from("referral_milestone_grants")
      .select("threshold")
      .eq("user_id", referrerUserId);
    const paid = new Set(
      ((paidRows ?? []) as Array<{ threshold: number }>).map((r) => r.threshold),
    );

    for (const m of eligible) {
      if (paid.has(m.threshold)) continue;

      // CLAIM the tier (insert; UNIQUE(user_id, threshold) blocks a double).
      const { error: claimErr } = await supabaseAdmin
        .from("referral_milestone_grants")
        .insert({
          user_id: referrerUserId,
          threshold: m.threshold,
          bonus_credits: m.bonus,
        });
      if (claimErr) {
        // 23505 = a concurrent caller already claimed it — fine, skip.
        if ((claimErr as { code?: string }).code !== "23505") {
          console.error("[referrals] milestone claim failed:", claimErr.message);
        }
        continue;
      }

      const { error: creditErr } = await supabaseAdmin.rpc("grant_grade_credits", {
        p_user_id: referrerUserId,
        p_credits: m.bonus,
        p_reason: "admin_grant",
        p_stripe_payment_intent: null,
        p_notes: `Referral milestone bonus (${m.threshold} referrals)`,
      });
      if (creditErr) {
        // Roll the claim back so a retry can pay it.
        console.error("[referrals] milestone credit failed:", creditErr.message);
        await supabaseAdmin
          .from("referral_milestone_grants")
          .delete()
          .eq("user_id", referrerUserId)
          .eq("threshold", m.threshold);
        continue;
      }

      await notifyUser(referrerUserId, {
        type: "billing",
        title: "Referral milestone reached!",
        message:
          `You hit ${m.threshold} referrals — ${m.bonus} bonus grade credits were added to your account.`,
        link: "/dashboard/referrals",
      }).catch(() => {});
    }
  } catch (err) {
    console.error(
      "[referrals] milestone award threw:",
      err instanceof Error ? err.message : err,
    );
  }
}

// US-1070: resolve the admin-configured referred-user SIGNUP incentive from
// system_settings, normalized + safe-defaulted. Read through the cached settings
// registry, so this is cheap on the redeem path.
export async function getReferredSignupIncentive(): Promise<ReferredSignupIncentive> {
  const raw = await getSetting<unknown>(
    REFERRED_SIGNUP_INCENTIVE_SETTING_KEY,
    DEFAULT_REFERRED_SIGNUP_INCENTIVE,
  );
  return normalizeReferredSignupIncentive(raw);
}

// US-1070: apply the referred-user welcome incentive for a freshly-redeemed
// referral. Called once, right after the referral_event is inserted (the UNIQUE
// referred_user_id makes a second redeem impossible, so this can run at most once
// per new user — the abuse guard). Within that, it is ALSO idempotent + race-safe
// against a retry of the same event: it CLAIMS the event row (sets
// signup_incentive_applied_at only if still null) BEFORE moving credits, so two
// concurrent callers can't double-grant. Best-effort — never throws; a failed
// credit grant rolls the claim back so a later retry can complete it.
//
// Two incentive levers (either/both, admin-configured):
//   • bonus_credits      → granted to the new user's balance immediately
//   • free_month_coupon  → stashed on users.pending_referral_coupon and applied
//                          at their NEXT subscription checkout (payments.ts)
export async function applyReferredSignupIncentive(
  eventId: string,
  referredUserId: string,
): Promise<void> {
  try {
    const incentive = await getReferredSignupIncentive();
    if (!incentive.enabled) return;
    if (incentive.bonus_credits <= 0 && !incentive.free_month_coupon_id) return;

    // CLAIM: stamp the event row only if no incentive was applied yet. The
    // .is("signup_incentive_applied_at", null) guard makes the claim atomic.
    const nowIso = new Date().toISOString();
    const { data: claimed, error: claimErr } = await supabaseAdmin
      .from("referral_events")
      .update({
        signup_incentive_applied_at: nowIso,
        signup_incentive_credits: incentive.bonus_credits,
        signup_incentive_coupon: incentive.free_month_coupon_id,
      })
      .eq("id", eventId)
      .is("signup_incentive_applied_at", null)
      .select("id");
    if (claimErr) {
      console.error("[referrals] signup-incentive claim failed:", claimErr.message);
      return;
    }
    if (!claimed || claimed.length === 0) {
      // Already applied by a prior call — nothing to do.
      return;
    }

    // Free-month coupon: stash it for the next subscription checkout to consume.
    if (incentive.free_month_coupon_id) {
      const { error: couponErr } = await supabaseAdmin
        .from("users")
        .update({ pending_referral_coupon: incentive.free_month_coupon_id })
        .eq("id", referredUserId);
      if (couponErr) {
        console.error("[referrals] signup-incentive coupon stash failed:", couponErr.message);
      }
    }

    // Bonus credits: grant immediately so onboarding reflects the balance.
    if (incentive.bonus_credits > 0) {
      const { error: creditErr } = await supabaseAdmin.rpc("grant_grade_credits", {
        p_user_id: referredUserId,
        p_credits: incentive.bonus_credits,
        p_reason: "admin_grant",
        p_stripe_payment_intent: null,
        p_notes: `Referral signup incentive (event ${eventId})`,
      });
      if (creditErr) {
        // Roll the claim back so a retry can pay it (and re-stash the coupon).
        console.error("[referrals] signup-incentive credit grant failed:", creditErr.message);
        await supabaseAdmin
          .from("referral_events")
          .update({
            signup_incentive_applied_at: null,
            signup_incentive_credits: null,
            signup_incentive_coupon: null,
          })
          .eq("id", eventId);
        return;
      }

      await notifyUser(referredUserId, {
        type: "billing",
        title: "Welcome bonus added",
        message:
          `${incentive.bonus_credits} grade credit${incentive.bonus_credits === 1 ? "" : "s"} were added to your account as a referral welcome bonus.`,
        link: "/dashboard/billing",
      }).catch(() => {});
    }
  } catch (err) {
    console.error(
      "[referrals] signup-incentive apply threw:",
      err instanceof Error ? err.message : err,
    );
  }
}

// Called when a referred user performs their first PAID action. Flips the
// still-pending row to `qualified`, then (US-864) AUTO-GRANTS it. Idempotent
// (only matches the pending row) and best-effort — never throws, so it can't
// break the payment flow it's wired into.
export async function maybeQualifyReferral(userId: string): Promise<void> {
  try {
    const { data: flipped, error } = await supabaseAdmin
      .from("referral_events")
      .update({ reward_status: "qualified", qualified_at: new Date().toISOString() })
      .eq("referred_user_id", userId)
      .eq("reward_status", "pending")
      .select("id");
    if (error) {
      console.error("[referrals] qualify hook failed:", error.message);
      return;
    }
    // Auto-grant the freshly-qualified referral. Best-effort: a `blocked`
    // (suspended) or transient `error` result simply leaves the row at
    // `qualified` for the admin grant queue to resolve.
    for (const row of (flipped ?? []) as Array<{ id: string }>) {
      const result = await grantReferralReward(row.id);
      if (result.status === "error" || result.status === "blocked") {
        console.warn(
          `[referrals] auto-grant for event ${row.id} not completed: ${result.status}`,
        );
      }
    }
  } catch (err) {
    console.error("[referrals] qualify hook threw:", err instanceof Error ? err.message : err);
  }
}
