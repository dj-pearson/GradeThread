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

type Env = { Variables: { userId?: string } };

export const referralRoutes = new Hono<Env>();

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
// the (rare) unique-collision.
async function ensureCode(userId: string): Promise<string> {
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

  return c.json({
    code,
    stats: {
      total: total.count ?? 0,
      pending: pending.count ?? 0,
      qualified: qualified.count ?? 0,
      granted: granted.count ?? 0,
    },
    referred_by: referredRow ? { status: referredRow.reward_status, code: referredRow.code } : null,
  });
});

referralRoutes.post("/redeem", async (c) => {
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

  // US-802: a suspended/deleted account must not accrue referral attribution
  // (which would later trigger a reward grant). Reject before inserting.
  const { data: me } = await supabaseAdmin
    .from("users")
    .select("suspended")
    .eq("id", userId)
    .maybeSingle();
  if (!me) return c.json({ error: "Account not found." }, 404);
  if ((me as { suspended?: boolean }).suspended) {
    return c.json(
      { error: "Suspended accounts can't redeem referral codes." },
      403,
    );
  }

  // Already attributed? (one referral per referred user — UNIQUE in schema)
  const { data: existing } = await supabaseAdmin
    .from("referral_events")
    .select("id")
    .eq("referred_user_id", userId)
    .maybeSingle();
  if (existing) return c.json({ error: "You've already redeemed a referral code." }, 409);

  // Resolve the code → referrer.
  const { data: owner } = await supabaseAdmin
    .from("referral_codes")
    .select("user_id")
    .eq("code", code)
    .maybeSingle();
  if (!owner) return c.json({ error: "That referral code doesn't exist." }, 404);
  if (owner.user_id === userId) {
    return c.json({ error: "You can't redeem your own referral code." }, 400);
  }

  const { error } = await supabaseAdmin.from("referral_events").insert({
    referrer_user_id: owner.user_id,
    referred_user_id: userId,
    code,
    reward_status: "pending",
  });
  if (error) {
    // Unique violation (raced) → treat as already redeemed.
    if ((error as { code?: string }).code === "23505") {
      return c.json({ error: "You've already redeemed a referral code." }, 409);
    }
    console.error("[referrals] redeem insert failed:", error);
    return c.json({ error: "Couldn't redeem that code." }, 500);
  }

  return c.json({ ok: true });
});
