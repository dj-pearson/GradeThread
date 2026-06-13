// US-585: server-enforced waitlist / beta access gate.
//
// When the `waitlist_gating` feature_flags row is enabled (staged launch), an
// authenticated account may use gated flows ONLY if it has access:
//   • role of reviewer/admin/super_admin  (staff always get in), OR
//   • a waitlist_entries row (matched by user_id OR email) with status
//     'approved' or 'invited'.
// Otherwise the gate returns 403 { code: "waitlist_required" } and the SPA shows
// the "you're on the waitlist" page.
//
// FAIL-OPEN: if gating is OFF, or the gating flag / access read errors, the gate
// ALLOWS access. A staged-launch gate must never lock the whole product out
// because of a transient DB blip or an unseeded flag — it only ever restricts
// when an operator has deliberately turned gating on AND the account isn't
// approved.

import { createMiddleware } from "hono/factory";
import type { User } from "@supabase/supabase-js";
import { supabaseAdmin } from "./supabase.ts";
import { logEvent } from "./observability.ts";

const GATING_FLAG = "waitlist_gating";
const CACHE_TTL_MS = 30_000;

// The gating master switch is cached fleet-wide like other feature flags.
let gatingCache: { active: boolean; expires: number } | null = null;

export function clearAccessGateCache(): void {
  gatingCache = null;
}

/** Is the waitlist gate currently turned on? Fail-open → false (inactive). */
export async function isWaitlistGatingActive(): Promise<boolean> {
  const now = Date.now();
  if (gatingCache && gatingCache.expires > now) return gatingCache.active;

  let active = false; // fail-open: gate inactive unless explicitly enabled
  try {
    const { data, error } = await supabaseAdmin
      .from("feature_flags")
      .select("enabled")
      .eq("key", GATING_FLAG)
      .maybeSingle();
    if (error) {
      logEvent("warn", "waitlist_gate.flag_read_error", {});
    } else if (data) {
      active = (data as { enabled: boolean }).enabled === true;
    }
    // No row → stays inactive (fail-open).
  } catch {
    logEvent("warn", "waitlist_gate.flag_read_error", {});
  }

  gatingCache = { active, expires: now + CACHE_TTL_MS };
  return active;
}

const STAFF_ROLES = new Set(["reviewer", "admin", "super_admin"]);
const ACCESS_STATUSES = new Set(["approved", "invited"]);

/**
 * Does this account have early-access? Staff always do; everyone else needs an
 * approved/invited waitlist entry. Used both by the gate middleware and exposed
 * to the SPA via a status endpoint. Fail-open → true on read errors.
 */
export async function userHasAccess(userId: string, email: string | null | undefined): Promise<boolean> {
  try {
    const { data: userRow } = await supabaseAdmin
      .from("users")
      .select("role")
      .eq("id", userId)
      .maybeSingle();
    const role = (userRow as { role?: string } | null)?.role;
    if (role && STAFF_ROLES.has(role)) return true;

    // Match the waitlist by the linked user_id first, then by email (the row may
    // predate signup and not be linked yet).
    const orFilter = email
      ? `user_id.eq.${userId},email.eq.${email.toLowerCase()}`
      : `user_id.eq.${userId}`;
    const { data, error } = await supabaseAdmin
      .from("waitlist_entries")
      .select("status")
      .or(orFilter)
      .limit(20);
    if (error) {
      logEvent("warn", "waitlist_gate.access_read_error", {});
      return true; // fail-open
    }
    const rows = (data ?? []) as Array<{ status: string }>;
    return rows.some((r) => ACCESS_STATUSES.has(r.status));
  } catch {
    logEvent("warn", "waitlist_gate.access_read_error", {});
    return true; // fail-open
  }
}

type GateEnv = { Variables: { userId: string; user?: User } };

// Hono middleware enforcing the gate on a route group. Runs AFTER authMiddleware
// (needs userId/user). Cheap when gating is off (one cached flag read, no
// per-request access lookup).
export const accessGateMiddleware = createMiddleware<GateEnv>(async (c, next) => {
  if (!(await isWaitlistGatingActive())) {
    await next();
    return;
  }
  const userId = c.get("userId");
  const email = c.get("user")?.email ?? null;
  if (await userHasAccess(userId, email)) {
    await next();
    return;
  }
  logEvent("info", "waitlist_gate.blocked", { userId });
  return c.json(
    {
      error: "Your account is on the waitlist. You'll get access once you're approved.",
      code: "waitlist_required",
    },
    403,
  );
});
