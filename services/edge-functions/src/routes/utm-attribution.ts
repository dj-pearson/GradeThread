// US-2101: persist first-/last-touch UTMs against the signed-in user.
//
// The client captures utm_source/medium/campaign/term/content into first-party
// storage on landing (consent-gated) and POSTs them here once the user
// authenticates, so the channel links to the converting user. Authenticated
// route (authMiddleware sets userId); the row written is ALWAYS the caller's own
// (userId from context, never a body-supplied id), so there is no cross-tenant
// exposure. Writes the users row via the service-role client.
//
// First-touch is IMMUTABLE — written only when the column is still null — so the
// original channel that acquired the user can never be overwritten by a later
// visit. Last-touch is refreshed every sync.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";

const UTM_KEYS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
] as const;

/** Keep only known UTM keys (+ landingAt) with string values; else null. */
export function sanitizeUtmSet(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object") return null;
  const src = input as Record<string, unknown>;
  const out: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    if (typeof src[k] === "string" && src[k]) out[k] = src[k] as string;
  }
  if (typeof src.landingAt === "string") out.landingAt = src.landingAt;
  // Require at least one real UTM dimension — landingAt alone is not a channel.
  return UTM_KEYS.some((k) => k in out) ? out : null;
}

export async function handleRecordUtm(c: Context): Promise<Response> {
  const userId = c.get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    first?: unknown;
    last?: unknown;
  };
  const first = sanitizeUtmSet(body.first);
  const last = sanitizeUtmSet(body.last);
  if (!first && !last) {
    return c.json({ error: "No valid UTM data." }, 400);
  }

  // Read the caller's own row to preserve first-touch immutability. Scoped to
  // the caller's id — never a body-supplied id (US-268).
  const { data: existing } = await supabaseAdmin
    .from("users")
    .select("utm_first_touch")
    .eq("id", userId)
    .maybeSingle();

  const patch: Record<string, unknown> = {};
  if (last) patch.utm_last_touch = last;
  // First-touch only when we have one AND the row doesn't already carry one.
  if (first && !existing?.utm_first_touch) patch.utm_first_touch = first;
  if (Object.keys(patch).length === 0) {
    // Nothing to change (e.g. only a first-touch arrived but one is already
    // stored) — a successful no-op, so the client stops re-sending.
    return c.json({ ok: true, unchanged: true });
  }

  const { error } = await supabaseAdmin
    .from("users")
    .update(patch)
    .eq("id", userId);
  if (error) {
    console.error("[utm-attribution] persist failed:", error.message);
    return c.json({ error: "Could not persist attribution." }, 500);
  }
  return c.json({ ok: true });
}
