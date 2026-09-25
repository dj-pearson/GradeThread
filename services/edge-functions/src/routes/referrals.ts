// US-629: referral program — user-facing endpoints.
//
//   GET  /api/referrals/me        provision (lazily) + return the caller's code,
//                                 referral stats, and whether they were referred
//   GET  /api/referrals/me/events the caller's referrals, one masked row each
//   POST /api/referrals/redeem    attribute the caller as referred by a code
//
// Authed (mounted with authMiddleware in main.ts). Service-role client, but
// every query is scoped to the caller (c.var.userId). Reward GRANTS happen on
// the admin side (admin-growth.ts) where they're step-up gated + audited.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import {
  classifyReferralRow,
  classifyReferralRows,
  nextMilestone,
  REFERRAL_MILESTONES,
  redeemRefusal,
  type RedeemRefusal,
  type ReferralLedgerRow,
  referrerRank,
} from "../lib/referral-rewards.ts";
import { loadReferralBoardInputs } from "../lib/referral-board.ts";
import {
  applyReferredSignupIncentive,
  getReferralRewardConfig,
  getReferredSignupIncentive,
} from "../lib/referrals.ts";
import { certIdFromLandingPath, recordShareSignup } from "../lib/share-to-earn.ts";
import { validateAlias } from "../lib/leaderboards.ts";

type Env = { Variables: { userId?: string } };

export const referralRoutes = new Hono<Env>();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REDEEM_REFUSAL_COPY: Record<RedeemRefusal, string> = {
  account_too_old: "Referral codes are for new accounts.",
  already_paid: "Referral codes are for new accounts that haven't bought credits yet.",
  circular_referral: "You referred this person, so you can't use their code.",
};

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

  let code: string;
  try {
    code = await ensureCode(userId);
  } catch (err) {
    console.error("[referrals] code provisioning failed:", err instanceof Error ? err.message : err);
    return c.json({ error: "Couldn't load your referral code. Try again in a minute." }, 503);
  }

  // One round of reads, in parallel. Every one is scoped to the caller.
  const [
    { data: rowsRaw },
    { data: referredRow },
    { data: prefs },
    { data: milestoneRows },
    { data: paidRows },
    rewardConfig,
    incentive,
  ] = await Promise.all([
    supabaseAdmin
      .from("referral_events")
      .select("reward_status, referrer_reward_credits, created_at, qualified_at")
      .eq("referrer_user_id", userId),
    supabaseAdmin
      .from("referral_events")
      .select("reward_status, code")
      .eq("referred_user_id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("users")
      .select("referral_leaderboard_enabled, referral_display_name, created_at")
      .eq("id", userId)
      .maybeSingle(),
    supabaseAdmin
      .from("referral_milestone_grants")
      .select("threshold, bonus_credits")
      .eq("user_id", userId),
    supabaseAdmin
      .from("grade_credit_transactions")
      .select("id")
      .eq("user_id", userId)
      .eq("reason", "pack_purchase")
      .limit(1),
    getReferralRewardConfig(),
    getReferredSignupIncentive(),
  ]);

  const rows = (rowsRaw ?? []) as ReferralLedgerRow[];
  const pref = prefs as
    | {
      referral_leaderboard_enabled?: boolean;
      referral_display_name?: string | null;
      created_at?: string | null;
    }
    | null;

  // US-1071: milestone progress. Tiers are reached on GRANTED referrals; the
  // bonus credits actually paid are tracked in referral_milestone_grants.
  const earnedTiers = (milestoneRows ?? []) as Array<{ threshold: number; bonus_credits: number }>;
  const earnedBonus = earnedTiers.reduce((sum, m) => sum + m.bonus_credits, 0);

  const nowMs = Date.now();
  const summary = classifyReferralRows(rows, rewardConfig, nowMs, earnedBonus);
  const grantedCount = summary.granted;
  const next = nextMilestone(grantedCount);
  const perReferral = rewardConfig.referrer_credits;
  const count = (status: string) => rows.filter((r) => r.reward_status === status).length;

  // Could this caller still type in a friend's code? The same rules /redeem
  // enforces, so the card is hidden rather than offered and then refused.
  const redeemEligible = !referredRow &&
    redeemRefusal({
        accountCreatedAt: pref?.created_at ?? null,
        nowMs,
        windowDays: rewardConfig.redeem_window_days,
        hasPaidPurchase: (paidRows ?? []).length > 0,
        circular: false,
      }) === null;

  const cap = rewardConfig.per_referrer_cap;

  // Where the caller sits on the public board, ranked by the exact function
  // the board uses. Only computed for someone who can be on it at all.
  let boardRank: { rank: number; tied: boolean } | null = null;
  if (pref?.referral_leaderboard_enabled && grantedCount > 0) {
    try {
      const board = await loadReferralBoardInputs();
      boardRank = referrerRank(board.eligible, board.totals, userId);
    } catch (err) {
      console.error("[referrals] leaderboard rank read failed:", err instanceof Error ? err.message : err);
    }
  }

  return c.json({
    code,
    stats: {
      total: rows.length,
      pending: count("pending"),
      qualified: count("qualified"),
      granted: grantedCount,
      // Still able to pay, and never able to pay. pending + qualified mixes
      // the two, which is why "In progress" used to include forfeits.
      waiting: summary.waiting,
      forfeit: summary.forfeit,
    },
    // US-864: the referrer's reward in actual grade credits. earned is what the
    // ledger paid (each grant's stored amount plus milestone bonuses), pending
    // is what the still-live referrals will pay at today's rate.
    credits: {
      per_referral: perReferral,
      earned: summary.earned,
      pending: summary.pending_credits,
    },
    // The deal, as the Share tab explains it. Every number is the live config.
    rules: {
      per_referral: perReferral,
      referred_bonus: incentive.enabled ? incentive.bonus_credits : 0,
      referred_on_qualify: rewardConfig.referred_credits,
      window_days: rewardConfig.qualification_window_days,
      cap,
      cap_remaining: cap > 0 ? Math.max(0, cap - grantedCount) : null,
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
      // null until the caller is actually listed: opted in, with a rewarded
      // referral, under an alias the board publishes.
      rank: boardRank?.rank ?? null,
      tied: boardRank?.tied ?? false,
    },
    referred_by: referredRow ? { status: referredRow.reward_status, code: referredRow.code } : null,
    redeem_eligible: redeemEligible,
  });
});

// GET /me/events — the caller's own referrals, one row each, so a seller can
// see who is stuck, who paid and who can no longer pay. Scoped to the caller as
// referrer (US-268). The friend is never named: rows are "Seller #N" in the
// order they joined. Statuses come from the same classifier as /me's tiles, so
// the list and the tiles always add up.
const EVENTS_LIMIT = 100;

referralRoutes.get("/me/events", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  const [{ data, error }, rewardConfig] = await Promise.all([
    supabaseAdmin
      .from("referral_events")
      .select("reward_status, referrer_reward_credits, created_at, qualified_at")
      .eq("referrer_user_id", userId)
      .order("created_at", { ascending: true })
      .limit(EVENTS_LIMIT),
    getReferralRewardConfig(),
  ]);
  if (error) {
    console.error("[referrals] events read failed:", error.message);
    return c.json({ error: "Couldn't load your referrals." }, 500);
  }

  const rows = (data ?? []) as ReferralLedgerRow[];
  const grantedCount = rows.filter((r) => r.reward_status === "granted").length;
  const nowMs = Date.now();
  const events = rows.map((row, i) => {
    const k = classifyReferralRow(row, rewardConfig, grantedCount, nowMs);
    return {
      label: `Seller #${i + 1}`,
      joined_at: row.created_at,
      status: k.status,
      reason: k.reason,
      credits: k.credits,
      qualify_by: k.status === "waiting" ? k.qualify_by : null,
    };
  });

  return c.json({ events, truncated: rows.length >= EVENTS_LIMIT });
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
    // The same alias rules as the rewards boards: no reserved words that pass
    // as the platform, no hidden or bidi characters on an indexable page.
    const v = validateAlias(body.display_name);
    if (!v.ok) return c.json({ error: v.error }, 400);
    nextName = v.alias;
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

  let body: { code?: unknown; source?: unknown; click_id?: unknown };
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
  const clickId = typeof body.click_id === "string" && UUID_RE.test(body.click_id)
    ? body.click_id
    : null;

  // US-802: a suspended/deleted account must not accrue referral attribution
  // (which would later trigger a reward grant). Reject before inserting.
  const { data: me } = await supabaseAdmin
    .from("users")
    .select("suspended, created_at")
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

  // Abuse guards: an old account, a paying customer, or the second half of an
  // A-refers-B-refers-A pair gets no signup incentive.
  const rewardConfig = await getReferralRewardConfig();
  const [{ data: paidRows }, { data: reverseRows }] = await Promise.all([
    supabaseAdmin
      .from("grade_credit_transactions")
      .select("id")
      .eq("user_id", userId)
      .eq("reason", "pack_purchase")
      .limit(1),
    supabaseAdmin
      .from("referral_events")
      .select("id")
      .eq("referrer_user_id", userId)
      .eq("referred_user_id", owner.user_id)
      .limit(1),
  ]);
  const refusal = redeemRefusal({
    accountCreatedAt: (me as { created_at?: string | null }).created_at,
    nowMs: Date.now(),
    windowDays: rewardConfig.redeem_window_days,
    hasPaidPurchase: (paidRows ?? []).length > 0,
    circular: (reverseRows ?? []).length > 0,
  });
  if (refusal) {
    return c.json({ error: REDEEM_REFUSAL_COPY[refusal], error_code: refusal }, 400);
  }

  // US-603: attribution channel. 'affiliate' is the cash switch, so the
  // client's word is not enough: it needs a logged click on this code. The
  // visitor's own click (click_id from POST /api/affiliate/click) is preferred;
  // any earlier click on the code still attributes the channel but pays no
  // share reward, since we cannot tell which cert they landed on.
  let click: { id: string; landing_path: string | null } | null = null;
  let attributionSource: "affiliate" | "direct" = "direct";
  if (body.source === "affiliate") {
    const nowIso = new Date().toISOString();
    if (clickId) {
      const { data } = await supabaseAdmin
        .from("affiliate_clicks")
        .select("id, landing_path")
        .eq("id", clickId)
        .eq("code", code)
        .is("converted_user_id", null)
        .lt("created_at", nowIso)
        .maybeSingle();
      click = (data as { id: string; landing_path: string | null } | null) ?? null;
    }
    if (click) {
      attributionSource = "affiliate";
    } else {
      const { data: anyClick } = await supabaseAdmin
        .from("affiliate_clicks")
        .select("id")
        .eq("code", code)
        .lt("created_at", nowIso)
        .limit(1);
      if ((anyClick ?? []).length > 0) attributionSource = "affiliate";
    }
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
  const credits = eventId ? await applyReferredSignupIncentive(eventId, userId) : 0;

  // US-603: close the loop on click attribution. Only the visitor's OWN click
  // (the click_id their browser got back from /click) is stamped, and only if
  // nobody converted it first. Stamping "the newest click on the code" paid the
  // cert share reward for whichever cert a stranger happened to open last.
  if (click) {
    const { data: stamped } = await supabaseAdmin
      .from("affiliate_clicks")
      .update({ converted_user_id: userId })
      .eq("id", click.id)
      .eq("code", code)
      .is("converted_user_id", null)
      .select("id");

    // US-1854: a signup is the strongest thing a shared find can produce, so
    // it pays the top rung of the share ladder outright. The click's
    // landing_path is the ONLY record of which find brought this person in.
    // The referrer is the code's owner, resolved above. Best-effort: a reward
    // problem must never fail a redemption that already landed.
    const certId = (stamped ?? []).length > 0 ? certIdFromLandingPath(click.landing_path) : null;
    if (certId) {
      await recordShareSignup(owner.user_id, "cert", certId);
    }
  }

  return c.json({ ok: true, credits });
});
