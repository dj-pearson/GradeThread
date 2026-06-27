// US-629: referral program — user-facing endpoints.
//
//   GET  /api/referrals/me        provision (lazily) + return the caller's code,
//                                 referral stats, and whether they were referred
//   POST /api/referrals/redeem    attribute the caller as referred by a code
//
// Authed (mounted with authMiddleware in main.ts). Service-role client, but
// every query is scoped to the caller (c.var.userId). Reward GRANTS happen on
// the admin side (admin-growth.ts) where they're step-up gated + audited.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  nextMilestone,
  REFERRAL_MILESTONES,
} from "../lib/referral-rewards.ts";
import { applyReferredSignupIncentive, getReferralRewardConfig } from "../lib/referrals.ts";

type Env = { Variables: { userId?: string } };

export const referralRoutes = new Hono<Env>();

// Public leaderboard alias: shown on the opt-in top-referrers board. PII-free by
// construction (no email/name unless the user types it here).
const MAX_LEADERBOARD_NAME = 40;

// Unambiguous alphabet (no 0/O, 1/I/L) for a human-shareable code.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function genCode(len = 8): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let out = "";
  for (let i = 0; i < len; i++) out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  return out;
}

// Provision the caller's referral code if they don't have one yet. Retries on
// the (rare) unique-collision. Exported so the affiliate channel (US-603) can
// resolve the caller's earned-link code without duplicating provisioning.
export async function ensureCode(userId: string): Promise<string> {
  const { data: existing } = await supabaseAdmin
    .from("referral_codes")
    .select("code")
    .eq("user_id", userId)
    .maybeSingle();
  if (existing?.code) return existing.code;

  for (let attempt = 0; attempt < 5; attempt++) {
    const code = genCode();
    const { error } = await supabaseAdmin
      .from("referral_codes")
      .insert({ user_id: userId, code });
    if (!error) return code;
    // 23505 = unique_violation. If it's the user_id that collided (a concurrent
    // provision), read it back; otherwise retry with a fresh code.
    const { data: row } = await supabaseAdmin
      .from("referral_codes")
      .select("code")
      .eq("user_id", userId)
      .maybeSingle();
    if (row?.code) return row.code;
  }
  throw new Error("Could not provision a referral code");
}

referralRoutes.get("/me", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  const code = await ensureCode(userId);

  // Referrer stats (people I referred), by status.
  const mine = (status?: string) => {
    let q = supabaseAdmin
      .from("referral_events")
      .select("id", { count: "exact", head: true })
      .eq("referrer_user_id", userId);
    if (status) q = q.eq("reward_status", status);
    return q;
  };
  const [total, pending, qualified, granted] = await Promise.all([
    mine(),
    mine("pending"),
    mine("qualified"),
    mine("granted"),
  ]);

  // Was I referred by someone?
  const { data: referredRow } = await supabaseAdmin
    .from("referral_events")
    .select("reward_status, code")
    .eq("referred_user_id", userId)
    .maybeSingle();

  // Leaderboard opt-in + public alias (US-864).
  const { data: prefs } = await supabaseAdmin
    .from("users")
    .select("referral_leaderboard_enabled, referral_display_name")
    .eq("id", userId)
    .maybeSingle();
  const pref = prefs as
    | { referral_leaderboard_enabled?: boolean; referral_display_name?: string | null }
    | null;

  const grantedCount = granted.count ?? 0;
  const inProgressCount = (pending.count ?? 0) + (qualified.count ?? 0);

  // US-1071: milestone progress. Tiers are reached on GRANTED referrals; the
  // bonus credits actually paid are tracked in referral_milestone_grants.
  const { data: milestoneRows } = await supabaseAdmin
    .from("referral_milestone_grants")
    .select("threshold, bonus_credits")
    .eq("user_id", userId);
  const earnedTiers = ((milestoneRows ?? []) as Array<{ threshold: number; bonus_credits: number }>);
  const earnedBonus = earnedTiers.reduce((sum, m) => sum + m.bonus_credits, 0);
  const next = nextMilestone(grantedCount);

  // US-1069: per-referral reward size is admin-configured in system_settings.
  const rewardConfig = await getReferralRewardConfig();
  const perReferral = rewardConfig.referrer_credits;

  return c.json({
    code,
    stats: {
      total: total.count ?? 0,
      pending: pending.count ?? 0,
      qualified: qualified.count ?? 0,
      granted: grantedCount,
    },
    // US-864: surface the referrer's reward in actual grade credits — earned
    // (already applied to their balance) vs. pending (referrals still in flight).
    credits: {
      per_referral: perReferral,
      earned: grantedCount * perReferral,
      pending: inProgressCount * perReferral,
    },
    // US-1071: tiered/milestone rewards.
    milestones: {
      tiers: REFERRAL_MILESTONES,
      earned_thresholds: earnedTiers.map((m) => m.threshold).sort((a, b) => a - b),
      earned_bonus_credits: earnedBonus,
      next: next ? { threshold: next.threshold, bonus: next.bonus, remaining: next.threshold - grantedCount } : null,
    },
    leaderboard: {
      enabled: pref?.referral_leaderboard_enabled ?? false,
      display_name: pref?.referral_display_name ?? null,
    },
    referred_by: referredRow ? { status: referredRow.reward_status, code: referredRow.code } : null,
  });
});

// US-1071: redeem a named campaign / promo code for bonus grade credits. Unlike
// a referral (which waits for a paid action), an admin-set campaign bonus grants
// immediately — the operator sizes the bonus to own the acquisition-cost ⇄ abuse
// tradeoff. Guards: one redemption per user, active + in-window code, optional
// max_redemptions cap, and a non-suspended account. Scoped to the caller.
referralRoutes.post("/campaign-codes/redeem", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  let body: { code?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return c.json({ error: "code is required" }, 400);

  // Suspended accounts can't accrue credit (mirrors referral redeem).
  const { data: me } = await supabaseAdmin
    .from("users")
    .select("suspended")
    .eq("id", userId)
    .maybeSingle();
  if (!me) return c.json({ error: "Account not found." }, 404);
  if ((me as { suspended?: boolean }).suspended) {
    return c.json({ error: "Suspended accounts can't redeem campaign codes." }, 403);
  }

  const { data: cc } = await supabaseAdmin
    .from("referral_campaign_codes")
    .select("id, bonus_referred_credits, is_active, starts_at, ends_at, max_redemptions, redemption_count")
    .eq("code", code)
    .maybeSingle();
  if (!cc) return c.json({ error: "That campaign code doesn't exist." }, 404);
  const camp = cc as {
    id: string;
    bonus_referred_credits: number;
    is_active: boolean;
    starts_at: string;
    ends_at: string | null;
    max_redemptions: number | null;
    redemption_count: number;
  };

  const now = Date.now();
  const live = camp.is_active &&
    new Date(camp.starts_at).getTime() <= now &&
    (!camp.ends_at || new Date(camp.ends_at).getTime() > now);
  if (!live) return c.json({ error: "That campaign code isn't active." }, 409);
  if (camp.max_redemptions != null && camp.redemption_count >= camp.max_redemptions) {
    return c.json({ error: "This campaign code has been fully redeemed." }, 409);
  }

  // CLAIM the redemption first (UNIQUE (campaign_code_id, user_id) blocks
  // a double / replay). Only after a successful claim do we move credits.
  const { error: claimErr } = await supabaseAdmin
    .from("referral_campaign_redemptions")
    .insert({
      campaign_code_id: camp.id,
      user_id: userId,
      credits_granted: camp.bonus_referred_credits,
    });
  if (claimErr) {
    if ((claimErr as { code?: string }).code === "23505") {
      return c.json({ error: "You've already redeemed this campaign code." }, 409);
    }
    console.error("[referrals] campaign redeem claim failed:", claimErr.message);
    return c.json({ error: "Couldn't redeem that code." }, 500);
  }

  if (camp.bonus_referred_credits > 0) {
    const { error: creditErr } = await supabaseAdmin.rpc("grant_grade_credits", {
      p_user_id: userId,
      p_credits: camp.bonus_referred_credits,
      p_reason: "admin_grant",
      p_stripe_payment_intent: null,
      p_notes: `Campaign code ${code}`,
    });
    if (creditErr) {
      // Roll the claim back so a retry can pay it.
      console.error("[referrals] campaign credit grant failed:", creditErr.message);
      await supabaseAdmin
        .from("referral_campaign_redemptions")
        .delete()
        .eq("campaign_code_id", camp.id)
        .eq("user_id", userId);
      return c.json({ error: "Couldn't apply the bonus." }, 500);
    }
  }

  // Best-effort cap counter bump (the authoritative cap check is the claim +
  // the >= comparison above; this keeps the displayed count fresh).
  await supabaseAdmin
    .from("referral_campaign_codes")
    .update({ redemption_count: camp.redemption_count + 1 })
    .eq("id", camp.id);

  return c.json({ ok: true, credits: camp.bonus_referred_credits });
});

// US-864: opt in/out of the public top-referrers leaderboard and set the public
// alias shown there. Scoped to the caller (`.eq("id", userId)`) — never touches
// another tenant's row (US-268). The alias is the ONLY identity that surfaces
// publicly, so going public requires one.
referralRoutes.put("/leaderboard", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  let body: { enabled?: unknown; display_name?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const update: Record<string, unknown> = {};

  let nextName: string | null | undefined;
  if (body.display_name !== undefined) {
    const dn = typeof body.display_name === "string" ? body.display_name.trim() : "";
    nextName = dn ? dn.slice(0, MAX_LEADERBOARD_NAME) : null;
    update.referral_display_name = nextName;
  }

  if (body.enabled !== undefined) {
    const enabled = body.enabled === true;
    if (enabled) {
      // Resolve the alias that WOULD result from this write.
      let resultingName = nextName;
      if (resultingName === undefined) {
        const { data: cur } = await supabaseAdmin
          .from("users")
          .select("referral_display_name")
          .eq("id", userId)
          .maybeSingle();
        resultingName = (cur as { referral_display_name?: string | null } | null)
          ?.referral_display_name ?? null;
      }
      if (!resultingName) {
        return c.json(
          { error: "Add a display name before joining the leaderboard." },
          400,
        );
      }
    }
    update.referral_leaderboard_enabled = enabled;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "Nothing to update." }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .update(update)
    .eq("id", userId)
    .select("referral_leaderboard_enabled, referral_display_name")
    .maybeSingle();
  if (error) {
    console.error("[referrals] leaderboard opt-in update failed:", error);
    return c.json({ error: "Couldn't update your leaderboard settings." }, 500);
  }
  const row = data as
    | { referral_leaderboard_enabled?: boolean; referral_display_name?: string | null }
    | null;
  return c.json({
    leaderboard: {
      enabled: row?.referral_leaderboard_enabled ?? false,
      display_name: row?.referral_display_name ?? null,
    },
  });
});

referralRoutes.post("/redeem", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  let body: { code?: unknown; source?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body", error_code: "invalid_body" }, 400);
  }
  // US-1255: every failure carries a machine-readable `error_code` so the iOS
  // client can map invalid/self/already-referred/suspended to specific copy
  // instead of one generic "that code isn't valid". The web client ignores it
  // (it surfaces `error`), so this is purely additive.
  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code) return c.json({ error: "code is required", error_code: "missing_code" }, 400);
  // US-603: attribution channel. Only 'affiliate' (a stored ?ref= captured off an
  // earned link / "Graded by GradeThread" badge) is meaningful here; anything
  // else is a manually-typed code → 'direct'.
  const attributionSource = body.source === "affiliate" ? "affiliate" : "direct";

  // US-802: a suspended/deleted account must not accrue referral attribution
  // (which would later trigger a reward grant). Reject before inserting.
  const { data: me } = await supabaseAdmin
    .from("users")
    .select("suspended")
    .eq("id", userId)
    .maybeSingle();
  if (!me) return c.json({ error: "Account not found.", error_code: "account_not_found" }, 404);
  if ((me as { suspended?: boolean }).suspended) {
    return c.json(
      { error: "Suspended accounts can't redeem referral codes.", error_code: "account_suspended" },
      403,
    );
  }

  // Already attributed? (one referral per referred user — UNIQUE in schema)
  const { data: existing } = await supabaseAdmin
    .from("referral_events")
    .select("id")
    .eq("referred_user_id", userId)
    .maybeSingle();
  if (existing) {
    return c.json({ error: "You've already redeemed a referral code.", error_code: "already_referred" }, 409);
  }

  // Resolve the code → referrer.
  const { data: owner } = await supabaseAdmin
    .from("referral_codes")
    .select("user_id")
    .eq("code", code)
    .maybeSingle();
  if (!owner) return c.json({ error: "That referral code doesn't exist.", error_code: "invalid_code" }, 404);
  if (owner.user_id === userId) {
    return c.json({ error: "You can't redeem your own referral code.", error_code: "self_referral" }, 400);
  }

  const { data: inserted, error } = await supabaseAdmin
    .from("referral_events")
    .insert({
      referrer_user_id: owner.user_id,
      referred_user_id: userId,
      code,
      reward_status: "pending",
      attribution_source: attributionSource,
    })
    .select("id")
    .maybeSingle();
  if (error) {
    // Unique violation (raced) → treat as already redeemed.
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "You've already redeemed a referral code.", error_code: "already_referred" }, 409);
    }
    console.error("[referrals] redeem insert failed:", error);
    return c.json({ error: "Couldn't redeem that code.", error_code: "redeem_failed" }, 500);
  }

  // US-1070: apply the configured referred-user SIGNUP incentive (welcome credits
  // and/or a free-month coupon) right now — the share is only compelling if the
  // new user gets something tangible at signup, not just at first paid action.
  // Idempotent + abuse-guarded (one referral_event per user); best-effort so a
  // hiccup here never fails the redemption itself.
  const eventId = (inserted as { id?: string } | null)?.id;
  if (eventId) await applyReferredSignupIncentive(eventId, userId);

  // US-603: best-effort close the loop on click attribution — stamp the most
  // recent un-converted click for this code with the converting user, so the
  // affiliate's click→conversion rate is real. Never blocks the redemption.
  if (attributionSource === "affiliate") {
    const { data: click } = await supabaseAdmin
      .from("affiliate_clicks")
      .select("id")
      .eq("code", code)
      .is("converted_user_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (click?.id) {
      await supabaseAdmin
        .from("affiliate_clicks")
        .update({ converted_user_id: userId })
        .eq("id", click.id);
    }
  }

  return c.json({ ok: true });
});
