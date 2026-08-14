// US-1818: buyer public-profile management (opt-in + privacy controls).
//
// Personal account (no workspace middleware): ownership is the authed user,
// c.get("userId"). Reads/writes only the caller's own users row. The PUBLIC read
// (by handle) lives in content-public.ts and is unauthenticated.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { normalizeHandle, normalizeVisibility } from "../lib/buyer-profile.ts";
import { mintExtensionToken } from "../lib/extension-token.ts";
import {
  FREE_BUYER_ENTITLEMENTS,
  getBuyerEntitlements,
} from "../lib/buyer-entitlements.ts";

type BuyerEnv = { Variables: { userId: string } };

export const buyerProfileRoutes = new Hono<BuyerEnv>();

// ── GET /entitlements ─────────────────────────────────────────────────────
// US-2503 (slice 1 of N): the RESOLVED buyer entitlement payload, served.
//
// The React app resolves this matrix client-side from the profile it already
// holds (use-buyer-entitlements.ts), which is fine for one client. iOS needs
// the same answer, and a Swift reimplementation of the matrix would be a
// SECOND SOURCE OF TRUTH — the exact thing US-2503 AC3 forbids, and the thing
// that eventually lets a plan change unlock a feature on one client and not the
// other.
//
// So the server resolves it once and both clients read it. The edge resolver
// (lib/buyer-entitlements.ts) is already the authority every buyer route gates
// on via requireBuyerFeature, so this endpoint adds no new logic at all — it
// exposes the answer that was already being computed.
//
// TENANCY (US-268): getBuyerEntitlements reads the caller's OWN users row,
// scoped by c.get("userId"). There is no id, filter or workspace header a caller
// can supply, so there is nothing to forge.
//
// FAIL-SAFE, and it matters more here than usual: on any read gap the resolver
// falls back to FREE. A client that cached an optimistic unlock on a hiccup
// would show a paid screen to someone who is not paying, so the failure
// direction is deliberately "locked", never "unlocked".
//
// no-store: a plan change must be visible on the next load, and a shared cache
// must never hand one buyer's entitlements to another.
buyerProfileRoutes.get("/entitlements", async (c) => {
  const userId = c.get("userId");
  try {
    const ent = await getBuyerEntitlements(userId);
    return c.json(ent, 200, { "Cache-Control": "no-store, private" });
  } catch (err) {
    console.error(
      "[buyer-profile] entitlements resolve failed:",
      err instanceof Error ? err.message : String(err),
    );
    // Deny by default rather than 500: a locked screen with a retry is a better
    // outcome for a buyer than an error page, and it can never over-grant.
    return c.json(FREE_BUYER_ENTITLEMENTS, 200, {
      "Cache-Control": "no-store, private",
    });
  }
});

// US-1838: mint a signed extension token for the logged-in buyer. The buyer app
// calls this after login and hands the token to the extension, which sends it as
// `Authorization: Bearer` so its entitlements (and quota) are enforceable
// separately from the anonymous web grade-checker.
buyerProfileRoutes.post("/extension-token", async (c) => {
  const userId = c.get("userId");
  try {
    const { token, expiresAt } = await mintExtensionToken(userId);
    return c.json({ token, expiresAt });
  } catch (err) {
    console.error("[buyer-profile] extension-token mint failed:", err);
    return c.json({ error: "Could not create an extension token." }, 500);
  }
});

// Own profile settings (for the buyer settings UI).
buyerProfileRoutes.get("/profile", async (c) => {
  const userId = c.get("userId");
  const { data } = await supabaseAdmin
    .from("users")
    .select("buyer_profile_handle, buyer_profile_enabled, buyer_profile_show")
    .eq("id", userId)
    .maybeSingle();
  const row = data as
    | { buyer_profile_handle: string | null; buyer_profile_enabled: boolean; buyer_profile_show: unknown }
    | null;
  return c.json({
    handle: row?.buyer_profile_handle ?? null,
    enabled: row?.buyer_profile_enabled ?? false,
    show: normalizeVisibility(row?.buyer_profile_show),
  });
});

// Update the profile: set/clear the handle, toggle enabled, choose visible stats.
buyerProfileRoutes.post("/profile", async (c) => {
  const userId = c.get("userId");
  let body: { enabled?: boolean; handle?: string | null; show?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body." }, 400);
  }

  const update: {
    buyer_profile_handle?: string | null;
    buyer_profile_enabled?: boolean;
    buyer_profile_show?: unknown;
  } = {};

  let nextHandle: string | null | undefined;
  if (body.handle !== undefined) {
    if (body.handle === null || (typeof body.handle === "string" && body.handle.trim() === "")) {
      nextHandle = null;
    } else {
      const h = normalizeHandle(body.handle);
      if (!h) {
        return c.json(
          { error: "Handle must be 3–30 characters: letters, numbers, dashes (not a reserved word)." },
          400,
        );
      }
      // Uniqueness: another user already holds this handle?
      const { data: taken } = await supabaseAdmin
        .from("users")
        .select("id")
        .ilike("buyer_profile_handle", h)
        .neq("id", userId)
        .maybeSingle();
      if (taken) return c.json({ error: "That handle is taken." }, 409);
      nextHandle = h;
    }
    update.buyer_profile_handle = nextHandle;
  }

  if (body.show !== undefined) {
    update.buyer_profile_show = normalizeVisibility(body.show);
  }

  if (typeof body.enabled === "boolean") {
    if (body.enabled) {
      // Enabling requires a handle (this write's, or one already on the row).
      let resulting = nextHandle;
      if (resulting === undefined) {
        const { data: cur } = await supabaseAdmin
          .from("users")
          .select("buyer_profile_handle")
          .eq("id", userId)
          .maybeSingle();
        resulting = (cur as { buyer_profile_handle: string | null } | null)?.buyer_profile_handle ?? null;
      }
      if (!resulting) return c.json({ error: "Choose a handle before making your profile public." }, 400);
    }
    update.buyer_profile_enabled = body.enabled;
  }

  if (Object.keys(update).length === 0) return c.json({ error: "Nothing to update." }, 400);

  const { data, error } = await supabaseAdmin
    .from("users")
    .update(update as never)
    .eq("id", userId)
    .select("buyer_profile_handle, buyer_profile_enabled, buyer_profile_show")
    .maybeSingle();
  if (error) {
    console.error("[buyer-profile] update failed:", error);
    return c.json({ error: "Couldn't update your profile." }, 500);
  }
  const row = data as
    | { buyer_profile_handle: string | null; buyer_profile_enabled: boolean; buyer_profile_show: unknown }
    | null;
  return c.json({
    handle: row?.buyer_profile_handle ?? null,
    enabled: row?.buyer_profile_enabled ?? false,
    show: normalizeVisibility(row?.buyer_profile_show),
  });
});
