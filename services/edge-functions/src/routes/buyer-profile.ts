// US-1818: buyer public-profile management (opt-in + privacy controls).
//
// Personal account (no workspace middleware): ownership is the authed user,
// c.get("userId"). Reads/writes only the caller's own users row. The PUBLIC read
// (by handle) lives in content-public.ts and is unauthenticated.

import { Hono } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { normalizeHandle, normalizeVisibility } from "../lib/buyer-profile.ts";
import { mintExtensionToken } from "../lib/extension-token.ts";

type BuyerEnv = { Variables: { userId: string } };

export const buyerProfileRoutes = new Hono<BuyerEnv>();

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
