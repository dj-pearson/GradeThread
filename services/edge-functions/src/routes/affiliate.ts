// US-603: affiliate / earned-link channel.
//
//   POST /api/affiliate/click   PUBLIC (unauthenticated) — log a click on a
//                               "Graded by GradeThread" badge / earned link.
//                               No PII, no auth; the code is the only join key.
//   GET  /api/affiliate/me      AUTHED — the caller's earned-link code + click
//                               and conversion stats for their own code.
//
// Rewards/payouts are NOT here — affiliate conversions ride the existing
// referral_events ledger (see referrals.ts redeem + admin-growth.ts grant).
// The /me endpoint is mounted behind authMiddleware in main.ts; /click is left
// public (rate-limited per-IP, fail-closed). Every read is scoped to the
// caller's own code.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { ensureCode } from "./referrals.ts";

type Env = { Variables: { userId?: string } };

export const affiliateRoutes = new Hono<Env>();

const VALID_SOURCES = new Set(["badge", "link", "certificate"]);

// Trim to keep the row small and avoid storing oversized attacker-controlled
// strings. Paths/hosts are diagnostics only.
function clip(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t.slice(0, max) : null;
}

// PUBLIC — anonymous visitor landed via an earned link. Log the click so the
// code's owner can see their funnel. Unknown codes are silently accepted-as-noop
// (return ok) so we never leak which codes exist to an unauthenticated caller.
affiliateRoutes.post("/click", async (c) => {
  let body: { code?: unknown; source?: unknown; path?: unknown; referrer?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }

  const code = typeof body.code === "string" ? body.code.trim().toUpperCase() : "";
  if (!code || code.length > 32) return c.json({ error: "code is required" }, 400);

  const source = VALID_SOURCES.has(String(body.source)) ? String(body.source) : "link";

  // Only log clicks for codes that actually exist — keeps the table from being
  // a free-write sink. Done silently either way (don't reveal existence).
  const { data: owner } = await supabaseAdmin
    .from("referral_codes")
    .select("user_id")
    .eq("code", code)
    .maybeSingle();
  if (!owner) return c.json({ ok: true });

  await supabaseAdmin.from("affiliate_clicks").insert({
    code,
    source,
    landing_path: clip(body.path, 512),
    referrer_host: clip(body.referrer, 255),
  });

  return c.json({ ok: true });
});

// AUTHED — the caller's earned-link code + funnel. Strictly scoped to the
// caller: clicks are joined by THEIR code, conversions are referral_events where
// they are the referrer and the channel is 'affiliate'.
affiliateRoutes.get("/me", async (c) => {
  const userId = c.get("userId");
  if (!userId) return c.json({ error: "Sign-in required" }, 401);

  const code = await ensureCode(userId);

  const since30 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const clicksTotalQ = supabaseAdmin
    .from("affiliate_clicks")
    .select("id", { count: "exact", head: true })
    .eq("code", code);
  const clicks30Q = supabaseAdmin
    .from("affiliate_clicks")
    .select("id", { count: "exact", head: true })
    .eq("code", code)
    .gte("created_at", since30);
  const convertedQ = supabaseAdmin
    .from("affiliate_clicks")
    .select("id", { count: "exact", head: true })
    .eq("code", code)
    .not("converted_user_id", "is", null);
  // Channel conversions in the reward ledger (independent of click linkage).
  const eventsQ = supabaseAdmin
    .from("referral_events")
    .select("id", { count: "exact", head: true })
    .eq("referrer_user_id", userId)
    .eq("attribution_source", "affiliate");

  const [clicksTotal, clicks30, converted, events] = await Promise.all([
    clicksTotalQ,
    clicks30Q,
    convertedQ,
    eventsQ,
  ]);

  return c.json({
    code,
    clicks: {
      total: clicksTotal.count ?? 0,
      last30: clicks30.count ?? 0,
      converted: converted.count ?? 0,
    },
    conversions: events.count ?? 0,
  });
});
