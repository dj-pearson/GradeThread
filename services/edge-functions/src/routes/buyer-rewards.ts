// US-1814: buyer rewards leaderboard — opt-in + confirmer feed.
//
// Personal account (no workspace middleware): ownership is the authed user
// directly, c.get("userId"). The opt-in write and the cross-buyer ranking both
// run on the service-role client — the ranking reads OTHER buyers' confirmation
// counts (RLS would deny a direct client read), and exposes ONLY a PII-free
// alias + count. Mirrors the referral leaderboard opt-in (referrals.ts / 00195).

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

type BuyerEnv = { Variables: { userId: string } };

export const buyerRewardsRoutes = new Hono<BuyerEnv>();

const MAX_LEADERBOARD = 100;
const DISPLAY_NAME_MAX = 40;

// Toggle leaderboard participation and/or set the public alias.
buyerRewardsRoutes.post("/rewards/leaderboard", async (c) => {
  const userId = c.get("userId");
  let body: { enabled?: boolean; display_name?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const update: { rewards_leaderboard_enabled?: boolean; rewards_display_name?: string | null } = {};

  let nextName: string | null | undefined;
  if (body.display_name !== undefined) {
    const trimmed = typeof body.display_name === "string" ? body.display_name.trim() : "";
    if (trimmed.length > DISPLAY_NAME_MAX) {
      return c.json({ error: `Display name must be ${DISPLAY_NAME_MAX} characters or fewer.` }, 400);
    }
    nextName = trimmed.length > 0 ? trimmed : null;
    update.rewards_display_name = nextName;
  }

  if (typeof body.enabled === "boolean") {
    if (body.enabled) {
      // Resolve the alias that WOULD result from this write; a board row needs one.
      let resultingName = nextName;
      if (resultingName === undefined) {
        const { data: cur } = await supabaseAdmin
          .from("users")
          .select("rewards_display_name")
          .eq("id", userId)
          .maybeSingle();
        resultingName = (cur as { rewards_display_name?: string | null } | null)?.rewards_display_name ?? null;
      }
      if (!resultingName) {
        return c.json({ error: "Add a display name before joining the leaderboard." }, 400);
      }
    }
    update.rewards_leaderboard_enabled = body.enabled;
  }

  if (Object.keys(update).length === 0) {
    return c.json({ error: "Nothing to update." }, 400);
  }

  const { data, error } = await supabaseAdmin
    .from("users")
    .update(update as never)
    .eq("id", userId)
    .select("rewards_leaderboard_enabled, rewards_display_name")
    .maybeSingle();
  if (error) {
    console.error("[buyer-rewards] leaderboard opt-in update failed:", error);
    return c.json({ error: "Couldn't update your leaderboard settings." }, 500);
  }
  const row = data as { rewards_leaderboard_enabled?: boolean; rewards_display_name?: string | null } | null;
  return c.json({
    me: {
      enabled: row?.rewards_leaderboard_enabled ?? false,
      display_name: row?.rewards_display_name ?? null,
    },
  });
});

// The confirmer leaderboard (opted-in aliases + confirmation counts) plus the
// caller's own opt-in status for the settings toggle.
buyerRewardsRoutes.get("/rewards/leaderboard", async (c) => {
  const userId = c.get("userId");

  const { data: me } = await supabaseAdmin
    .from("users")
    .select("rewards_leaderboard_enabled, rewards_display_name")
    .eq("id", userId)
    .maybeSingle();

  const { data: optedIn, error } = await supabaseAdmin
    .from("users")
    .select("id, rewards_display_name")
    .eq("rewards_leaderboard_enabled", true)
    .not("rewards_display_name", "is", null)
    .limit(5000);
  if (error) {
    console.error("[buyer-rewards] leaderboard load failed:", error);
    return c.json({ error: "Couldn't load the leaderboard." }, 500);
  }

  const users = (optedIn ?? []) as Array<{ id: string; rewards_display_name: string | null }>;
  const meRow = me as { rewards_leaderboard_enabled?: boolean; rewards_display_name?: string | null } | null;
  const meOut = {
    enabled: meRow?.rewards_leaderboard_enabled ?? false,
    display_name: meRow?.rewards_display_name ?? null,
  };
  if (users.length === 0) return c.json({ leaderboard: [], me: meOut });

  // Count each opted-in buyer's confirmations (buyer_arrival + confirmed).
  const ids = users.map((u) => u.id);
  const { data: outcomes } = await supabaseAdmin
    .from("grade_outcomes")
    .select("buyer_user_id")
    .eq("source", "buyer_arrival")
    .eq("match_status", "confirmed")
    .in("buyer_user_id", ids);

  const counts = new Map<string, number>();
  for (const o of outcomes ?? []) {
    const id = (o as { buyer_user_id: string | null }).buyer_user_id;
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const leaderboard = users
    .map((u) => ({ display_name: u.rewards_display_name as string, confirmations: counts.get(u.id) ?? 0 }))
    .filter((r) => r.confirmations > 0)
    .sort((a, b) => b.confirmations - a.confirmations)
    .slice(0, MAX_LEADERBOARD);

  return c.json({ leaderboard, me: meOut });
});
