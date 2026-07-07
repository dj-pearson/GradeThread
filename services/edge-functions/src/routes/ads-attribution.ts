// US-1700: persist a captured ad click id against the signed-in user.
//
// The client captures gclid/gbraid/wbraid on landing (first-party storage) and
// POSTs it here once the user authenticates (post-signup), so the click links to
// the converting user. Authenticated route (authMiddleware sets userId); the
// attribution's owner is ALWAYS the caller's own id — never an id from the body —
// so there's no cross-tenant exposure. Writes the operator ad_click_attributions
// table via the service-role client.

import type { Context } from "hono";
import { supabaseAdmin } from "../lib/supabase.ts";
import { recordAttribution } from "../lib/ads-conversions.ts";

export async function handleRecordAttribution(c: Context): Promise<Response> {
  const userId = c.get("userId") as string | undefined;
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  const body = (await c.req.json().catch(() => ({}))) as {
    clickId?: unknown;
    clickIdType?: unknown;
    landingAt?: unknown;
  };
  const clickId = typeof body.clickId === "string" ? body.clickId : "";
  const clickIdType = typeof body.clickIdType === "string" ? body.clickIdType : "";
  if (!clickId || !clickIdType) {
    return c.json({ error: "clickId and clickIdType are required." }, 400);
  }

  const ok = await recordAttribution(supabaseAdmin, {
    clickId,
    clickIdType,
    ownerUserId: userId, // always the caller — never a body-supplied id
    landingAt: typeof body.landingAt === "string" ? body.landingAt : undefined,
  });
  if (!ok) return c.json({ ok: false, error: "Invalid or unsupported click id." }, 400);
  return c.json({ ok: true });
}
